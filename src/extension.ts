import * as vscode from 'vscode';
import { UsageObservatory, type ObservatoryHandle } from './observatory/observatory.js';

let activeObservatory: UsageObservatory | undefined;

function currentWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): ObservatoryHandle {
  const verifyCmd = vscode.commands.registerCommand(
    'sentra.verifyInstallation',
    () => {
      void vscode.window.showInformationMessage('Sentra is installed and active.');
    }
  );

  const observatory = new UsageObservatory({ workspace: currentWorkspacePath() });
  activeObservatory = observatory;

  const wsListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    observatory.setWorkspace(currentWorkspacePath());
  });

  context.subscriptions.push(
    verifyCmd,
    wsListener,
    {
      dispose: () => {
        observatory.dispose();
        if (activeObservatory === observatory) activeObservatory = undefined;
      },
    }
  );

  // Non-blocking startup: initial refresh runs asynchronously after activate() returns.
  observatory.start();
  return observatory.createHandle();
}

export function deactivate(): void {
  activeObservatory?.dispose();
  activeObservatory = undefined;
}
