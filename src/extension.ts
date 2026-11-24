import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    'sentra.verifyInstallation',
    () => {
      void vscode.window.showInformationMessage('Sentra is installed and active.');
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // No resources to dispose during bootstrap.
}
