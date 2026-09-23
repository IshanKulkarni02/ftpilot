import * as vscode from "vscode";
import { runDeploy } from "./deploy";
import { setCredentials } from "./secrets";
import { configPath, configExists } from "./config";
import { FtpilotPanel } from "./panel";

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let panel: FtpilotPanel;

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("FTPilot");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(cloud-upload) Deploy";
  statusBar.tooltip = "FTPilot: build and upload the deploy branch to your cPanel server(s)";
  statusBar.command = "ftpilot.deploy";
  statusBar.show();
  context.subscriptions.push(output, statusBar);

  panel = new FtpilotPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FtpilotPanel.viewType, panel)
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/.ftbdeploy/config.json");
  watcher.onDidChange(() => panel.refresh());
  watcher.onDidCreate(() => panel.refresh());
  watcher.onDidDelete(() => panel.refresh());
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => panel.refresh()));

  context.subscriptions.push(
    vscode.commands.registerCommand("ftpilot.deploy", async () => {
      const root = getWorkspaceRoot();
      if (root && !configExists(root)) {
        void vscode.window.showInformationMessage(
          "FTPilot isn't configured yet — open the FTPilot panel in the Activity Bar to set it up."
        );
        await vscode.commands.executeCommand("ftpilotPanel.focus");
        return;
      }
      await runDeploy(context, output, statusBar);
      panel.refresh();
    }),

    vscode.commands.registerCommand("ftpilot.fullRedeploy", async () => {
      await runDeploy(context, output, statusBar, { forceFull: true });
      panel.refresh();
    }),

    vscode.commands.registerCommand("ftpilot.setCredentials", async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
        return;
      }
      const account =
        (await vscode.window.showInputBox({
          prompt: "FTP account to set credentials for ('default', or a target's override username)",
          value: "default",
        })) ?? "default";
      const user = await vscode.window.showInputBox({ prompt: "FTP username" });
      if (!user) return;
      const password = await vscode.window.showInputBox({ prompt: "FTP password", password: true });
      if (!password) return;
      await setCredentials(context, root, account, { user, password });
      void vscode.window.showInformationMessage(`FTPilot: credentials saved for '${account}'.`);
    }),

    vscode.commands.registerCommand("ftpilot.editConfig", async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
        return;
      }
      if (!configExists(root)) {
        void vscode.window.showWarningMessage(
          "No config yet — open the FTPilot panel in the Activity Bar to set it up."
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(configPath(root));
      await vscode.window.showTextDocument(doc);
    })
  );
}

export function deactivate(): void {
  // no-op
}
