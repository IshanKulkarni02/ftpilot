import * as vscode from "vscode";
import { runDeploy, cancelDeploy, runRollback } from "./deploy";
import { listSnapshots, rollbackableId } from "./rollback";
import { DeployState } from "./progress";
import { Dashboard } from "./dashboard";
import { Metrics } from "./metrics";
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
  const dashboard = new Dashboard();
  context.subscriptions.push(dashboard);
  const onProgress = (state: DeployState, metrics?: Metrics) => {
    panel.reportProgress(state);
    dashboard.update(state, metrics);
  };
  context.subscriptions.push(panel); // closes any open "Check connection" FTP session on deactivate
  context.subscriptions.push(
    // Keep the form alive while the sidebar is hidden, so unsaved typing (incl. passwords) isn't lost.
    vscode.window.registerWebviewViewProvider(FtpilotPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("ftpilot.openInEditor", () => panel.openInEditor()),
    vscode.commands.registerCommand("ftpilot.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("ftpilot.openDashboard", () => dashboard.open()),
    vscode.commands.registerCommand("ftpilot.toggleGeekMode", async () => {
      const cfg = vscode.workspace.getConfiguration("ftpilot");
      const on = !cfg.get<boolean>("geekMode", false);
      await cfg.update("geekMode", on, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(on ? "FTPilot: Geek Mode on. The dashboard opens when a deploy starts." : "FTPilot: Geek Mode off.");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("ftpilot.geekMode")) panel.refresh(); }),
    vscode.commands.registerCommand("ftpilot.cancelDeploy", () => cancelDeploy()),
    // From the panel (already confirmed there) or the Command Palette (pick + confirm here).
    vscode.commands.registerCommand("ftpilot.rollback", async (args?: { snapshotId?: string; confirmed?: boolean }) => {
      const root = getWorkspaceRoot();
      if (!root) return;
      let id = args?.snapshotId;
      if (!id) {
        // Only the most recent deploy can be undone (then the one before it, and so on).
        const nextId = rollbackableId(root);
        const usable = listSnapshots(root).filter((i) => i.id === nextId);
        if (!usable.length) {
          void vscode.window.showInformationMessage("FTPilot: nothing to roll back. Only the most recent deploy can be rolled back, and only if a rollback copy was saved before it.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          usable.map((i) => ({
            label: new Date(i.createdAt).toLocaleString(),
            description: `${i.branch ?? ""}${i.commit ? ` @ ${i.commit}` : ""}`,
            detail: i.targets.map((t) => `${t.name}: ${t.restore.length} to restore, ${t.created.length} to delete`).join(" · "),
            id: i.id,
          })),
          { placeHolder: "Roll back the most recent deploy" }
        );
        if (!pick) return;
        id = pick.id;
      }
      if (!args?.confirmed) {
        const ok = await vscode.window.showWarningMessage(
          "Roll back this deploy? The server files it overwrote or deleted are put back, files it created are deleted, and Node apps are restarted.",
          { modal: true },
          "Roll Back"
        );
        if (ok !== "Roll Back") return;
      }
      await runRollback(context, output, statusBar, { snapshotId: id, onProgress });
      panel.refresh();
    }),
    vscode.commands.registerCommand("ftpilot.preview", async (args?: { targetId?: string; compareRemote?: boolean; skipBuild?: boolean }) => {
      await runDeploy(context, output, statusBar, { dryRun: true, onlyTargetId: args?.targetId, compareRemote: args?.compareRemote, skipBuild: args?.skipBuild, onProgress });
      panel.refresh();
    }),
    // Uploads exactly what the preview showed: same scope, existing build output (no rebuild).
    vscode.commands.registerCommand("ftpilot.deployPreview", async (args?: { targetId?: string }) => {
      await runDeploy(context, output, statusBar, { skipBuild: true, onlyTargetId: args?.targetId, onProgress });
      panel.refresh();
    }),
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
