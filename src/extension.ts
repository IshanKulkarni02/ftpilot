import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { runDeploy, cancelDeploy, runRollback } from "./deploy";
import { listSnapshots, rollbackableId } from "./rollback";
import { DeployState } from "./progress";
import { Dashboard } from "./dashboard";
import { Metrics } from "./metrics";
import { runBackup } from "./backup";
import { setCredentials, getCredentials } from "./secrets";
import { ensureAuthorized, setAppPassword, clearAppPassword, hasAppPassword, lockNow, configureAppLock, maybeShowFirstRunPrompt } from "./auth";
import { configPath, configExists, loadConfig, remoteTreePath, ensureGitignored } from "./config";
import { FtpilotPanel } from "./panel";
import { setupAgentSkill, isAgentSkillUpToDate, agentSkillFilesExist, SKILL_RELATIVE_PATH, AGENTS_DOC_RELATIVE_PATH } from "./agentSkill";
import * as ftpClient from "./ftpClient";

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
  const dashboard = new Dashboard(context);
  context.subscriptions.push(dashboard);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(Dashboard.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
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
    vscode.commands.registerCommand("ftpilot.setAppPassword", async () => {
      await setAppPassword(context);
    }),
    vscode.commands.registerCommand("ftpilot.configureAppLock", async () => {
      await configureAppLock(context);
    }),
    vscode.commands.registerCommand("ftpilot.removeAppPassword", async () => {
      if (!(await hasAppPassword(context))) {
        void vscode.window.showInformationMessage("FTPilot: no app password is set.");
        return;
      }
      if (!(await ensureAuthorized(context, "Remove the FTPilot app password"))) return;
      await clearAppPassword(context);
      void vscode.window.showInformationMessage("FTPilot: app password removed. Touch ID / Windows Hello (if available) will be used instead.");
    }),
    vscode.commands.registerCommand("ftpilot.lockNow", () => {
      lockNow();
      void vscode.window.showInformationMessage("FTPilot: locked. The next deploy or credential change will ask for authentication.");
    }),
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
      if (!(await ensureAuthorized(context, "Change the saved FTP login"))) return;
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
    }),

    vscode.commands.registerCommand("ftpilot.setupAgentSkill", async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
        return;
      }
      if (isAgentSkillUpToDate(root)) {
        void vscode.window.showInformationMessage("FTPilot: the AI agent deploy skill is already set up and up to date.");
        return;
      }
      let overwrite = true;
      if (agentSkillFilesExist(root)) {
        const choice = await vscode.window.showWarningMessage(
          `FTPilot: ${SKILL_RELATIVE_PATH} and/or ${AGENTS_DOC_RELATIVE_PATH} already exist with different content. Overwrite with the latest FTPilot instructions?`,
          { modal: true },
          "Overwrite"
        );
        if (choice !== "Overwrite") return;
        overwrite = true;
      }
      const { results, pointers } = setupAgentSkill(root, overwrite);
      const written = results.filter((r) => r.action === "created" || r.action === "updated").map((r) => r.relativePath);
      const linked = pointers.filter((p) => p.action === "updated").map((p) => p.relativePath);
      const summary = [
        written.length ? `Wrote ${written.join(" and ")}.` : "Already up to date.",
        linked.length ? `Linked from ${linked.join(" and ")}.` : "",
        "Commit these so every contributor's coding agent gets it. Say \"ready to deploy\" to a Claude Code session in this project to try it.",
      ].filter(Boolean).join(" ");
      void vscode.window.showInformationMessage(`FTPilot: ${summary}`, "Open SKILL.md").then((c) => {
        if (c) void vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root), SKILL_RELATIVE_PATH)).then((d) => vscode.window.showTextDocument(d));
      });
      panel.refresh();
    }),

    // Folder *names* only, never file contents or anything outside the FTP account(s) already
    // saved for this project — lets a coding agent match server folders to targets without ever
    // seeing the credentials that produced the listing.
    vscode.commands.registerCommand("ftpilot.scanRemoteStructure", async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
        return;
      }
      let config;
      try {
        config = loadConfig(root, false);
      } catch (err) {
        void vscode.window.showErrorMessage(`FTPilot: ${(err as Error).message}`);
        return;
      }
      if (!config.host) {
        void vscode.window.showWarningMessage("FTPilot: set the FTP host in the panel first, then scan.");
        return;
      }
      if (!(await ensureAuthorized(context, "Scan the server's folder structure"))) return;

      const accounts = ["default", ...new Set(config.targets.map((t) => t.ftpUser).filter((u): u is string => !!u))];
      const scanned: Record<string, { dirs: string[] }> = {};
      const problems: string[] = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "FTPilot: scanning server folder structure…" },
        async () => {
          for (const account of accounts) {
            const creds = await getCredentials(context, root, account);
            if (!creds) {
              problems.push(`${account}: no saved credentials, skipped`);
              continue;
            }
            let client: Awaited<ReturnType<typeof ftpClient.connect>> | undefined;
            try {
              client = await ftpClient.connect(config, creds);
              scanned[account] = { dirs: await ftpClient.listRemoteDirTree(client, "/") };
            } catch (err) {
              problems.push(`${account}: ${(err as Error).message}`);
            } finally {
              client?.close();
            }
          }
        }
      );

      if (!Object.keys(scanned).length) {
        void vscode.window.showErrorMessage(`FTPilot: couldn't scan any account. ${problems.join(" ")}`);
        return;
      }

      const outPath = remoteTreePath(root);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify({ scannedAt: new Date().toISOString(), host: config.host, accounts: scanned }, null, 2) + "\n",
        "utf8"
      );
      // Reflects the live server layout at scan time and can go stale — not meant to be committed or shared.
      ensureGitignored(root, ".ftbdeploy/remote-tree.json");

      const dirCount = Object.values(scanned).reduce((n, a) => n + a.dirs.length, 0);
      const summary =
        `Scanned ${Object.keys(scanned).length} account(s), ${dirCount} folder(s) into .ftbdeploy/remote-tree.json.` +
        (problems.length ? ` (${problems.join("; ")})` : "") +
        ` Tell your coding agent to match it against your targets' remoteDir.`;
      void vscode.window.showInformationMessage(`FTPilot: ${summary}`, "Open remote-tree.json").then((c) => {
        if (c) void vscode.workspace.openTextDocument(outPath).then((d) => vscode.window.showTextDocument(d));
      });
    })
  );

  void maybeShowFirstRunPrompt(context);
}

export function deactivate(): void {
  // no-op
}
