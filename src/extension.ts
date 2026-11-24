import * as vscode from 'vscode';
import { PreventiveMonitor, type MonitoringListener } from './monitoring/monitoring.js';
import type { MonitoringSnapshot } from './monitoring/rules.js';
import { UsageObservatory, type ObservatoryHandle } from './observatory/observatory.js';

export interface SentraExtensionHandle extends ObservatoryHandle {
  getMonitoringSnapshot(): MonitoringSnapshot;
  onDidUpdateMonitoring(listener: MonitoringListener): () => void;
}

let activeObservatory: UsageObservatory | undefined;
let activeMonitor: PreventiveMonitor | undefined;

function currentWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): SentraExtensionHandle {
  const verifyCmd = vscode.commands.registerCommand(
    'sentra.verifyInstallation',
    () => {
      void vscode.window.showInformationMessage('Sentra is installed and active.');
    }
  );

  const observatory = new UsageObservatory({ workspace: currentWorkspacePath() });
  const monitor = new PreventiveMonitor(observatory);
  activeObservatory = observatory;
  activeMonitor = monitor;

  const wsListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    observatory.setWorkspace(currentWorkspacePath());
  });

  context.subscriptions.push(
    verifyCmd,
    wsListener,
    {
      dispose: () => {
        monitor.dispose();
        observatory.dispose();
        if (activeMonitor === monitor) activeMonitor = undefined;
        if (activeObservatory === observatory) activeObservatory = undefined;
      },
    }
  );

  // Non-blocking startup: initial refresh runs asynchronously after activate() returns.
  observatory.start();
  return {
    ...observatory.createHandle(),
    getMonitoringSnapshot: () => monitor.getSnapshot(),
    onDidUpdateMonitoring: (listener: MonitoringListener) => monitor.onDidUpdate(listener),
  };
}

export function deactivate(): void {
  activeMonitor?.dispose();
  activeObservatory?.dispose();
  activeMonitor = undefined;
  activeObservatory = undefined;
}
