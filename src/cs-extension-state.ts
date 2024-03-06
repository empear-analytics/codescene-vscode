import vscode from 'vscode';
import { PreFlightResponse } from './cs-rest-api';
import { CsStatusBar } from './cs-statusbar';
import { CliStatus } from './download';
import { CsRefactoringCommands } from './refactoring/commands';
import { CsRefactoringRequests } from './refactoring/cs-refactoring-requests';
import Telemetry from './telemetry';
import { isDefined } from './utils';
import { StatusViewProvider } from './webviews/status-view-provider';

export interface CsFeatures {
  codeHealthAnalysis?: CliStatus;
  automatedCodeEngineering?: PreFlightResponse | Error | string;
}

export interface CsStateProperties {
  session?: vscode.AuthenticationSession;
  features?: CsFeatures;
}

/**
 * This class is used to handle the state of the extension. One part is managing and presenting
 * the state properties, the other part is to handle the state of components that are registered
 * when the user signs in and out of CodeScene.
 */
export class CsExtensionState {
  private stateProperties: CsStateProperties = {};
  private statusViewProvider: StatusViewProvider;
  private statusBar: CsStatusBar;

  private refactoringCommand: CsRefactoringCommands | undefined;
  private aceFeatureDisposables: vscode.Disposable[] = [];

  constructor(statusViewProvider: StatusViewProvider) {
    this.statusViewProvider = statusViewProvider;
    this.statusBar = new CsStatusBar();
  }

  updateStatusViews() {
    this.statusViewProvider.update(this.stateProperties);
    this.statusBar.setOnline(isDefined(this.stateProperties.session));
  }

  /**
   * Sets session state and updates the codescene.isSignedIn context variable.
   * This can be used in package.json to conditionally enable/disable views.
   */
  setSession(session?: vscode.AuthenticationSession) {
    const signedIn = isDefined(session);
    vscode.commands.executeCommand('setContext', 'codescene.isSignedIn', signedIn);
    Telemetry.instance.setSession(session);
    this.stateProperties.session = session;
    if (!signedIn) {
      // this.csWorkspace.clearProjectAssociation(); <- when re-working Change Coupling...
      this.disableACE('Not signed in'); // Ace cannot be active if not signed in
      return;
    }

    this.updateStatusViews();
  }

  setCliStatus(cliStatus: CliStatus) {
    this.stateProperties.features = { ...this.stateProperties.features, codeHealthAnalysis: cliStatus };
    this.updateStatusViews();
  }

  enableACE(preFlight: PreFlightResponse, disposables: vscode.Disposable[]) {
    this.stateProperties.features = { ...this.stateProperties.features, automatedCodeEngineering: preFlight };
    this.aceFeatureDisposables = disposables;
    this.refactoringCommand?.enableRequestRefactoringsCmd(preFlight);
    this.updateStatusViews();
  }

  disableACE(reason: Error | string) {
    this.stateProperties.features = { ...this.stateProperties.features, automatedCodeEngineering: reason };

    this.refactoringCommand?.disableRequestRefactoringsCmd();
    this.aceFeatureDisposables.forEach((d) => d.dispose());
    this.aceFeatureDisposables = [];
    CsRefactoringRequests.deleteAll();
    this.updateStatusViews();
  }

  setRefactoringCommand(refactoringCommand: CsRefactoringCommands) {
    this.refactoringCommand = refactoringCommand;
  }
}
