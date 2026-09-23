import * as vscode from "vscode";
import { runDeploy, cancelDeploy } from "./deploy";
import { DeployState } from "./progress";
import { runBackup } from "./backup";
import { setCredentials } from "./secrets";
import { configPath, configExists, loadConfig } from "./config";
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
  const onProgress = (state: DeployState) => panel.reportProgress(state);
  context.subscriptions.push(panel); // closes any open "Check connection" FTP session on deactivate
  context.subscriptions.push(
    // Keep the form alive while the sidebar is hidden, so unsaved typing (incl. passwords) isn't lost.
    vscode.window.registerWebviewViewProvider(FtpilotPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("ftpilot.openInEditor", () => panel.openInEditor()),
    vscode.commands.registerCommand("ftpilot.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("ftpilot.cancelDeploy", () => cancelDeploy()),
    vscode.commands.registerCommand("ftpilot.openHelp", () =>
      vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(context.extensionUri, "media", "HELP.md"))
    )
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
      await runDeploy(context, output, statusBar, { onProgress });
      panel.refresh();
    }),

    // Internal (not in the Command Palette): the per-target cloud icon in the panel.
    vscode.commands.registerCommand("ftpilot.deployTarget", async (targetId: string) => {
      await runDeploy(context, output, statusBar, { onlyTargetId: targetId, onProgress });
      panel.refresh();
    }),

    vscode.commands.registerCommand("ftpilot.fullRedeploy", async () => {
      await runDeploy(context, output, statusBar, { forceFull: true, onProgress });
      panel.refresh();
    }),

    vscode.commands.registerCommand("ftpilot.backup", async () => {
      await runBackup(context, output);
      panel.refresh();
    }),

    vscode.commands.registerCommand("ftpilot.setCredentials", async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
        return;
      }
      // "default" is only the internal storage key for this project's main login (keyed per
      // workspace folder in secrets.ts) — it is never shared across projects.
      const PROJECT_LOGIN = "This project's FTP login";
      let overrides: string[] = [];
      try {
        overrides = [...new Set(loadConfig(root, false).targets.map((t) => t.ftpUser).filter((u): u is string => !!u))];
      } catch {
        // no config / no targets yet — only the project login can be set
      }
      const picked = overrides.length
        ? await vscode.window.showQuickPick([PROJECT_LOGIN, ...overrides], {
            placeHolder: "Which login? (targets with their own FTP login are listed by username)",
          })
        : PROJECT_LOGIN;
      if (!picked) return;
      const account = picked === PROJECT_LOGIN ? "default" : picked;
      const user = await vscode.window.showInputBox({ prompt: "FTP username" });
      if (!user) return;
      const password = await vscode.window.showInputBox({ prompt: "FTP password", password: true });
      if (!password) return;
      await setCredentials(context, root, account, { user, password });
      void vscode.window.showInformationMessage(`FTPilot: credentials saved for ${picked === PROJECT_LOGIN ? "this project" : `'${account}'`}.`);
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
