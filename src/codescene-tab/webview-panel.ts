import vscode, { Disposable, Uri, ViewColumn, WebviewPanel } from 'vscode';
import { CsExtensionState } from '../cs-extension-state';
import { InteractiveDocsParams } from '../documentation/commands';
import { logOutputChannel } from '../log';
import { refactoringSymbol, toConfidenceSymbol } from '../refactoring/commands';
import { CsRefactoringRequest } from '../refactoring/cs-refactoring-requests';
import { decorateCode, targetEditor } from '../refactoring/utils';
import { isError } from '../utils';
import { functionLocationContent } from './webview/components';
import { docsForCategory } from './webview/documentation-components';
import {
  refactoringButton,
  refactoringContent,
  refactoringSummary,
  refactoringUnavailable,
} from './webview/refactoring-components';
import { renderHtmlTemplate } from './webview/utils';

export interface CodeSceneTabPanelParams {
  params: InteractiveDocsParams | CsRefactoringRequest;
}

export class CodeSceneTabPanel implements Disposable {
  private static _instance: CodeSceneTabPanel | undefined;
  private static readonly viewType = 'codescene-tab';
  private readonly webViewPanel: WebviewPanel;
  private disposables: Disposable[] = [];
  private state?: InteractiveDocsParams | CsRefactoringRequest;

  public static get instance() {
    if (!CodeSceneTabPanel._instance) {
      CodeSceneTabPanel._instance = new CodeSceneTabPanel();
    }
    return CodeSceneTabPanel._instance;
  }

  constructor() {
    this.webViewPanel = vscode.window.createWebviewPanel(
      CodeSceneTabPanel.viewType,
      'CodeScene',
      { viewColumn: ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [
          Uri.joinPath(CsExtensionState.extensionUri, 'out'),
          Uri.joinPath(CsExtensionState.extensionUri, 'assets'),
        ],
        // retainContextWhenHidden: true, // Might this to keep the state of the auto-refactor button then moving the webview tab around. It's
      }
    );
    this.webViewPanel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.webViewPanel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          if (!this.state) return;
          if (this.state instanceof CsRefactoringRequest) {
            await this.handleRefactoringMessage(this.state, message.command);
          } else {
            await this.handleDocumentationMessage(this.state, message.command);
          }
        } catch (error) {
          if (!isError(error)) return;
          void vscode.window.showErrorMessage(error.message);
          logOutputChannel.error(error.message);
        }
      },
      this,
      this.disposables
    );
  }

  private async handleRefactoringMessage(refactoring: CsRefactoringRequest, command: string) {
    switch (command) {
      case 'goto-function-location':
        this.goToFunctionLocation(refactoring.document.uri, refactoring.fnToRefactor.range.start);
        return;
      case 'apply':
        vscode.commands.executeCommand('codescene.applyRefactoring', refactoring).then(
          () => {
            this.dispose();
          },
          (error) => {
            logOutputChannel.error(error);
            this.dispose();
          }
        );
        return;
      case 'reject':
        this.deselectRefactoring(refactoring);
        this.dispose();
        return;
      case 'copy-code':
        await this.copyCode(refactoring);
        return;
      case 'show-diff':
        void vscode.commands.executeCommand('codescene.showDiffForRefactoring', refactoring);
        return;
      case 'show-logoutput':
        logOutputChannel.show();
        return;
      default:
        throw new Error(`Command not implemented: "${command}"!`);
    }
  }

  private deselectRefactoring(refactoring: CsRefactoringRequest) {
    const editor = targetEditor(refactoring.document);
    if (editor) {
      editor.selection = new vscode.Selection(0, 0, 0, 0);
    }
  }

  private async copyCode(refactoring: CsRefactoringRequest) {
    const decoratedCode = decorateCode(await refactoring.promise, refactoring.document.languageId);
    await vscode.env.clipboard.writeText(decoratedCode);
    void vscode.window.showInformationMessage('Copied refactoring suggestion to clipboard');
  }

  private async handleDocumentationMessage(params: InteractiveDocsParams, command: string) {
    switch (command) {
      case 'goto-function-location':
        this.goToFunctionLocation(params.document.uri, params.issueInfo.position);
        return;
      case 'request-and-present-refactoring':
        void vscode.commands.executeCommand(
          'codescene.requestAndPresentRefactoring',
          params.document,
          params.fnToRefactor
        );
        return;
      default:
        throw new Error(`Command not implemented: "${command}"!`);
    }
  }

  private goToFunctionLocation(uri: Uri, pos: vscode.Position) {
    const location = new vscode.Location(uri, pos);
    void vscode.commands.executeCommand('editor.action.goToLocations', uri, pos, [location]);
  }

  private async updateWebView(params: InteractiveDocsParams | CsRefactoringRequest) {
    this.state = params;
    if (params instanceof CsRefactoringRequest) {
      await this.presentRefactoring(params);
      return;
    }
    await this.presentDocumentation(params);
  }

  private async presentRefactoring(refactoring: CsRefactoringRequest) {
    const { fnToRefactor, promise, document } = refactoring;

    const fnLocContent = functionLocationContent({
      filePath: fnToRefactor.filePath,
      position: fnToRefactor.range.start,
      fnName: fnToRefactor.name,
    });

    this.updateRefactoringContent('Refactoring...', [
      fnLocContent,
      `<div class="loading-content">
         <vscode-progress-ring class="progress-ring"></vscode-progress-ring>
       </div>`,
    ]);

    try {
      const response = await promise;
      const {
        confidence: { level, title },
      } = response;

      const highlightCode = toConfidenceSymbol(level) === refactoringSymbol;
      const editor = targetEditor(document);
      if (highlightCode && editor) {
        editor.selection = new vscode.Selection(fnToRefactor.range.start, fnToRefactor.range.end);
      }

      this.updateRefactoringContent(title, [
        fnLocContent,
        refactoringSummary(response.confidence),
        await refactoringContent(response, document.languageId),
      ]);
    } catch (error) {
      const title = 'Refactoring Failed';
      const actionHtml = `
        There was an error when performing this refactoring. 
        Please see the <a href="" id="show-logoutput-link">CodeScene Log</a> output for error details.`;
      const summaryContent = refactoringSummary({
        level: 0,
        title,
        description: '',
        'recommended-action': {
          description: title,
          details: actionHtml,
        },
      });
      this.updateRefactoringContent(title, [fnLocContent, summaryContent, refactoringUnavailable()]);
    }
  }

  private updateRefactoringContent(title: string, content: string | string[]) {
    renderHtmlTemplate(this.webViewPanel, {
      title,
      bodyContent: content,
      cssPaths: [['out', 'codescene-tab', 'webview', 'refactoring-styles.css']],
      scriptPaths: [['out', 'codescene-tab', 'webview', 'refactoring-script.js']],
    });
  }

  private async presentDocumentation(params: InteractiveDocsParams) {
    const { issueInfo, document } = params;
    const title = issueInfo.category;

    const fnLocContent = functionLocationContent({
      filePath: document.uri.fsPath,
      position: issueInfo.position,
      fnName: issueInfo.fnName,
    });

    let fnToRefactor = params.fnToRefactor;
    // If we haven't been provided with a function to refactor, try to find one
    // This is the case when presenting documentation from a codelens or codeaction,
    // and unfortunately in the case of presenting from a delta analysis with an unsupported code smell...
    if (!fnToRefactor) {
      fnToRefactor = (
        await CsExtensionState.aceCapabilities?.getFunctionsToRefactor(document, [
          { category: issueInfo.category, line: issueInfo.position.line + 1 },
        ])
      )?.[0];
    }

    const buttonContent = `
      <div class="button-container">
        ${refactoringButton(fnToRefactor)}
      </div>
    `;

    const docsContent = await docsForCategory(issueInfo.category);

    this.updateContentWithDocScripts(title, [fnLocContent, buttonContent, docsContent]);
  }

  private updateContentWithDocScripts(title: string, content: string | string[]) {
    renderHtmlTemplate(this.webViewPanel, {
      title,
      bodyContent: content,
      scriptPaths: [['out', 'codescene-tab', 'webview', 'documentation-script.js']],
    });
  }

  dispose() {
    CodeSceneTabPanel._instance = undefined;
    this.webViewPanel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  static show({ params }: CodeSceneTabPanelParams) {
    void CodeSceneTabPanel.instance.updateWebView(params);
    if (!CodeSceneTabPanel.instance.webViewPanel.visible) {
      CodeSceneTabPanel.instance.webViewPanel.reveal(undefined, true);
    }
  }
}