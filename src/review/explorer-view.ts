import vscode from 'vscode';
import { logOutputChannel } from '../log';
import { isDefined, rangeStr } from '../utils';
import { scoreToDescription, toCsReviewUri } from './presentation';
import Reviewer, { ReviewCacheItem } from './reviewer';
import { chScorePrefix, fileAndFunctionLevelIssueCount, formatScore, getCsDiagnosticCode } from './utils';

export class ReviewExplorerView implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private treeDataProvider: ReviewTreeProvider;
  private view: vscode.TreeView<ReviewTreeBranch | ReviewTreeLeaf>;

  constructor() {
    this.treeDataProvider = new ReviewTreeProvider();

    this.view = vscode.window.createTreeView('codescene.explorerCodeReviewView', {
      treeDataProvider: this.treeDataProvider,
      showCollapseAll: true,
    });
    this.disposables.push(this.view);

    const changeTextEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) =>
      this.revealInTreeView(editor)
    );
    this.disposables.push(changeTextEditorDisposable);
  }

  private revealInTreeView(editor?: vscode.TextEditor) {
    const document = editor?.document;
    if (!isDefined(document) || !this.view.visible) return;

    const reviewCacheItem = Reviewer.instance.reviewCache.get(document.fileName);
    if (!isDefined(reviewCacheItem)) return;

    this.view.reveal(new ReviewTreeBranch(document, reviewCacheItem)).then(undefined, (reason) => {
      logOutputChannel.warn(`Failed to reveal review tree branch: ${reason}`);
    });
  }

  dispose() {
    this.treeDataProvider.dispose(); // Dispose and clear the treedataprovider first, emptying the view

    this.disposables.forEach((d) => d.dispose());
  }
}

class ReviewTreeBranch {
  document: vscode.TextDocument;
  label: string;
  score?: number;
  issues?: number;
  children: ReviewTreeLeaf[] = [];
  hasError = false;

  constructor(document: vscode.TextDocument, { csReview }: ReviewCacheItem) {
    this.document = document;
    const file = document.uri.path.split('/').pop();
    this.label = `${file} - Reviewing...`;

    void csReview.reviewResult.then((reviewResult) => {
      if (!reviewResult) this.hasError = true;
      this.score = reviewResult?.score;
      this.label = `${file} - ${formatScore(this.score)}`;
      this.issues = reviewResult ? fileAndFunctionLevelIssueCount(reviewResult) : undefined;
    });

    void csReview.diagnostics.then((diagnostics) => {
      this.children = diagnostics
        .map((d) => {
          if (d.message.startsWith(chScorePrefix)) return;
          return new ReviewTreeLeaf(this, d);
        })
        .filter(isDefined)
        .sort((a, b) => a.diagnostic.range.start.line - b.diagnostic.range.start.line);
    });
  }

  get collapsibleState(): vscode.TreeItemCollapsibleState {
    return this.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
  }
}

class ReviewTreeLeaf {
  label: string;
  parent: ReviewTreeBranch;
  diagnostic: vscode.Diagnostic;

  constructor(parent: ReviewTreeBranch, diagnostic: vscode.Diagnostic) {
    this.parent = parent;
    this.label = `${getCsDiagnosticCode(diagnostic.code)} ${rangeStr(diagnostic.range)}`;
    this.diagnostic = diagnostic;
  }
}

class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeBranch | ReviewTreeLeaf>, vscode.Disposable {
  private treeDataChangedEmitter = new vscode.EventEmitter<void>();
  private disposables: vscode.Disposable[] = [];
  readonly onDidChangeTreeData = this.treeDataChangedEmitter.event;

  constructor() {
    this.disposables.push(
      Reviewer.instance.onDidReview((e) => {
        this.treeDataChangedEmitter.fire();
      })
    );
  }

  getTreeItem(element: ReviewTreeBranch | ReviewTreeLeaf): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if (element instanceof ReviewTreeBranch) {
      const item = new vscode.TreeItem(element.label, element.collapsibleState);
      const relativePath = vscode.workspace.asRelativePath(element.document.uri);

      const markdownString = () => {
        if (element.hasError) return `${relativePath} • Error while reviewing`;

        const score = element.score;
        return score
          ? `${relativePath} • **${scoreToDescription(score)}** • ${element.issues} code health issues found`
          : `${relativePath} • Reviewing...`;
      };

      item.tooltip = new vscode.MarkdownString(markdownString());
      item.resourceUri = toCsReviewUri(element.document.uri, { score: element.score, issues: element.issues });
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);

    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    const code = getCsDiagnosticCode(element.diagnostic.code);
    const msgDetails = element.diagnostic.message.replace(code, '').trim();
    item.tooltip = new vscode.MarkdownString(
      `**${code}** ${msgDetails} on line ${element.diagnostic.range.start.line + 1}`
    );

    const location = new vscode.Location(element.parent.document.uri, element.diagnostic.range);
    item.command = {
      command: 'editor.action.goToLocations',
      title: 'Go To Location(s)',
      arguments: [element.parent.document.uri, element.diagnostic.range.start, [location]],
    };
    return item;
  }

  getChildren(
    element?: ReviewTreeBranch | ReviewTreeLeaf | undefined
  ): vscode.ProviderResult<ReviewTreeBranch[] | ReviewTreeLeaf[]> {
    if (isDefined(element)) {
      if (element instanceof ReviewTreeBranch) {
        return element.children;
      }
      return []; // No children for ReviewTreeLeaf (issues)
    }

    return buildTreeFromReviewCache();
  }

  getParent(element: ReviewTreeBranch | ReviewTreeLeaf): vscode.ProviderResult<ReviewTreeBranch | ReviewTreeLeaf> {
    if (element instanceof ReviewTreeLeaf) {
      return element.parent;
    }
    return null;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

function buildTreeFromReviewCache(): ReviewTreeBranch[] {
  const treeItems: ReviewTreeBranch[] = [];
  Reviewer.instance.reviewCache.forEach((item) => {
    treeItems.push(new ReviewTreeBranch(item.document, item));
  });

  // TODO - sort tree items by score/Reviewing status
  return treeItems;
}
