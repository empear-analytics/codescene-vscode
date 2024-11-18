import vscode, { WorkspaceEdit } from 'vscode';
import { CodeSceneTabPanel } from '../codescene-tab/webview-panel';
import { CsExtensionState } from '../cs-extension-state';
import CsDiagnostics from '../diagnostics/cs-diagnostics';
import Telemetry from '../telemetry';
import { isDefined } from '../utils';
import { FnToRefactor } from './capabilities';
import { RefactoringRequest } from './request';
import { createTempDocument, decorateCode, selectCode, targetEditor } from './utils';

export class CsRefactoringCommands implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.commands.registerCommand(
        'codescene.requestAndPresentRefactoring',
        this.requestAndPresentRefactoringCmd,
        this
      ),
      vscode.commands.registerCommand('codescene.applyRefactoring', this.applyRefactoringCmd, this),
      vscode.commands.registerCommand('codescene.showDiffForRefactoring', this.showDiffForRefactoringCmd, this)
    );
  }

  private presentRefactoringRequestCmd(request?: RefactoringRequest) {
    if (!request) return;
    CodeSceneTabPanel.show(request);
  }

  private async requestAndPresentRefactoringCmd(document: vscode.TextDocument, fnToRefactor?: FnToRefactor) {
    if (!fnToRefactor) return;
    if (!CsExtensionState.acknowledgedAceUsage) {
      CodeSceneTabPanel.show({ document, fnToRefactor });
      return;
    }

    const request = new RefactoringRequest(fnToRefactor, document);
    this.presentRefactoringRequestCmd(request);
  }

  private async applyRefactoringCmd(refactoring: RefactoringRequest) {
    const {
      document,
      fnToRefactor,
      fnToRefactor: { range },
    } = refactoring;

    return refactoring.promise.then(async (response) => {
      const { level } = response.confidence;
      if (level < 2) {
        throw new Error(
          `Don't apply refactoring for function "${fnToRefactor.name}" - confidence level too low (${response.confidence}).`
        );
      }
      const workSpaceEdit = new WorkspaceEdit();
      workSpaceEdit.replace(document.uri, range, response.code);
      await vscode.workspace.applyEdit(workSpaceEdit);
      // Select the replaced code in the editor, starting from the original position
      void selectCode(document, response.code, range.start);

      // Immediately trigger a re-review of the new file-content
      // This is important, since otherwise the review is controlled by the debounced review done in the onDidChangeTextDocument (extension.ts)
      CsDiagnostics.review(document);
      Telemetry.instance.logUsage('refactor/applied', { 'trace-id': refactoring.traceId });
    });
  }

  private async showDiffForRefactoringCmd(refactoring: RefactoringRequest) {
    const {
      document,
      fnToRefactor: { range },
    } = refactoring;

    const response = await refactoring.promise;
    const decoratedCode = decorateCode(response, document.languageId);
    // Create temporary virtual documents to use in the diff command. Just opening a new document with the new code
    // imposes a save dialog on the user when closing the diff.
    const originalCodeTmpDoc = await createTempDocument('Original', {
      content: document.getText(range),
      languageId: document.languageId,
    });
    const refactoringTmpDoc = await createTempDocument('Refactoring', {
      content: decoratedCode,
      languageId: document.languageId,
    });

    // Use showTextDocument using the tmp doc and the target editor view column to set that editor active.
    // The diff command will then open in that same viewColumn, and not on top of the ACE panel.
    const editor = targetEditor(document);
    await vscode.window.showTextDocument(originalCodeTmpDoc, editor?.viewColumn, false);
    await vscode.commands.executeCommand('vscode.diff', originalCodeTmpDoc.uri, refactoringTmpDoc.uri);

    Telemetry.instance.logUsage('refactor/diff-shown', { 'trace-id': refactoring.traceId });
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
