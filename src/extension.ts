import * as vscode from "vscode";
import { runSetupWizard } from "./setupWizard";
import { runDeploy } from "./deploy";
import { setCredentials } from "./secrets";
import { configPath, configExists } from "./config";

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;

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

  context.subscriptions.push(
    vscode.commands.registerCommand("ftpilot.setup", async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
        return;
      }
      await runSetupWizard(context, root);
    }),

    vscode.commands.registerCommand("ftpilot.deploy", async () => {
      const root = getWorkspaceRoot();
      if (root && !configExists(root)) {
        const choice = await vscode.window.showInformationMessage(
          "FTPilot isn't configured for this project yet.",
          "Configure Now"
        );
        if (choice === "Configure Now") {
          await runSetupWizard(context, root);
        }
        return;
      }
      await runDeploy(context, output, statusBar);
    }),

    vscode.commands.registerCommand("ftpilot.fullRedeploy", async () => {
      await runDeploy(context, output, statusBar, { forceFull: true });
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
          "No config yet — run 'FTPilot: Configure Project' first."
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
