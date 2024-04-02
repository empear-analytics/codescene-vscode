import * as vscode from 'vscode';
import { requestRefactoringsCmdName } from './refactoring/commands';
import Reviewer, { ReviewOpts, chScorePrefix } from './review/reviewer';
import { reviewDocumentSelector } from './language-support';
import { logOutputChannel } from './log';

export const csSource = 'CodeScene';

export default class CsDiagnostics {
  // The collection of diagnostics presented in the Problems tab
  private static collection: vscode.DiagnosticCollection;
  private static readonly documentSelector: vscode.DocumentSelector = reviewDocumentSelector();

  static init(context: vscode.ExtensionContext) {
    if (!CsDiagnostics.collection) {
      CsDiagnostics.collection = vscode.languages.createDiagnosticCollection('codescene');
      context.subscriptions.push(CsDiagnostics.collection);
    }
  }

  static set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
    CsDiagnostics.collection.set(uri, diagnostics);
  }

  static review(document: vscode.TextDocument, reviewOpts?: ReviewOpts) {
    if (vscode.languages.match(CsDiagnostics.documentSelector, document) === 0) {
      return;
    }

    Reviewer.instance
      .review(document, reviewOpts)
      .then((diagnostics) => {
        // Remove the diagnostics that are for file level issues. These are only shown as code lenses
        const importantDiagnostics = diagnostics.filter((d) => !d.message.startsWith(chScorePrefix));
        CsDiagnostics.set(document.uri, importantDiagnostics);

        // Try to request refactorings for the important diagnostics
        void vscode.commands.executeCommand(requestRefactoringsCmdName, document, importantDiagnostics);
      })
      .catch((e) => {
        logOutputChannel.error(`Review error ${e}`);
      });
  }

  static abort(document: vscode.TextDocument) {
    Reviewer.instance.abort(document);
  }
}
