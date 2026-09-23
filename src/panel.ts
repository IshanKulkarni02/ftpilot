import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { DeployConfig, configExists, loadConfig, saveConfig, validateTargets } from "./config";
import * as ftp from "basic-ftp";
import { setCredentials, setEnvSecret, getCredentials, getEnvSecret, getLoginStatus } from "./secrets";
import { getCurrentBranch } from "./git";
import { DeployState, slimState } from "./progress";
import { rollbackableId } from "./rollback";
import { checkHealth, HealthResult } from "./health";
import * as ftpClient from "./ftpClient";
import { detectProject } from "./detect";

type TargetCreds = Record<string, { user: string; password: string }>;
/** Target name -> env var key -> value, for secret-flagged env vars being set/rotated. */
type TargetEnvSecrets = Record<string, Record<string, string>>;

type InMsg =
  | { type: "ready" }
  | { type: "draft"; config: DeployConfig | null }
  | { type: "openInEditor"; targetId?: string; addTarget?: boolean }
  | { type: "openHelp" }
  | { type: "updateCredentials"; account: string }
  | { type: "setEnvSecret"; targetId: string; key: string }
  | { type: "connect"; config: DeployConfig; stay: boolean }
  | { type: "disconnect" }
  | { type: "openReport" }
  | { type: "openLog" }
  | { type: "showOutput" }
  | { type: "dismissProgress" }
  | { type: "cancelDeploy" }
  | { type: "openDashboard" }
  | { type: "preview"; targetId?: string; compareRemote?: boolean; skipBuild?: boolean }
  | { type: "deployFromPreview" }
  | { type: "rollback"; id: string }
  | { type: "testHealth"; index: number; url: string; expect?: string }
  | { type: "testFtps"; config: DeployConfig }
  | {
      type: "saveConfig";
      config: DeployConfig;
      defaultUser?: string;
      defaultPassword?: string;
      targetCreds?: TargetCreds;
      envSecrets?: TargetEnvSecrets;
    }
  | { type: "deploy" }
  | { type: "fullRedeploy" }
  | { type: "deployTarget"; id: string; name: string }
  | { type: "backup" }
  | { type: "openConfigJson" }
  | { type: "detect"; index: number; cwd: string }
  | { type: "listDirs"; forPath: string }
  | { type: "browse"; index: number; field: "cwd" | "localDir"; from?: string };

type OutMsg =
  | { type: "init"; workspaceOpen: boolean; config?: DeployConfig; draft?: DeployConfig; meta?: InitMeta }
  | { type: "focus"; targetId?: string; addTarget?: boolean }
  | { type: "draft"; config: DeployConfig | null }
  | { type: "detected"; index: number; cwd: string; buildCommand?: string; localDir?: string; note: string }
  | { type: "dirs"; forPath: string; dirs: string[] }
  | { type: "browsed"; index: number; field: "cwd" | "localDir"; value: string }
  | { type: "saved" }
  | { type: "status"; text: string; kind: "idle" | "busy" | "ok" | "error" }
  | { type: "error"; message: string }
  | { type: "connection"; conn: ConnState }
  | { type: "progress"; state: DeployState | null }
  | { type: "healthResult"; index: number; result: HealthResult | null }
  | { type: "ftpsResult"; ok: boolean; message: string; certIssue?: boolean; unsupported?: boolean; suggestedHost?: string; testing?: boolean };

/** Read-only facts for display; secrets are reduced to "is it set?" before leaving the host. */
type InitMeta = {
  projectName: string;
  branch?: string;
  login: { user?: string; hasPassword: boolean };
  /** ftpUser -> has a saved password */
  targetLogins: Record<string, boolean>;
  /** target id -> env keys whose secret value is saved */
  envSecretsSet: Record<string, string[]>;
  /** Geek Mode setting: when off, no dashboard entry points are shown. */
  geekMode: boolean;
  /** Snapshot id of the one deploy that can be rolled back now (the most recent), if any. */
  rollbackable?: string;
};

type ConnState = {
  /** "ok" = one-off check passed and the session was closed; "connected" = session kept open. */
  state: "idle" | "connecting" | "ok" | "connected" | "error";
  text: string;
  /** Per-target remote folder check, filled in once connected. */
  checks?: { name: string; remoteDir: string; exists: boolean }[];
};

/** Turns basic-ftp / socket errors into something a non-FTP-expert can act on. */
function friendlyFtpError(err: unknown, host: string, port: number): string {
  const tls = ftpClient.diagnoseTlsError(err);
  if (tls) return tls.message + (tls.suggestedHost ? ` Try host '${tls.suggestedHost}'.` : "");
  const e = err as { code?: string | number; message?: string };
  if (e.code === 530) return "Login failed: wrong FTP username or password.";
  if (e.code === "ENOTFOUND") return `Host '${host}' not found. Check the FTP host.`;
  if (e.code === "ECONNREFUSED") return `Connection refused by ${host}:${port}. Check the port.`;
  if (e.code === "ETIMEDOUT" || /timeout/i.test(e.message ?? "")) return `Timed out reaching ${host}:${port}. Check host, port, and protocol.`;
  return e.message ?? String(err);
}

const IGNORE_DIR_NAMES = new Set(["node_modules", ".git", ".vscode", ".ftbdeploy"]);

/**
 * config.json (shared target/env config) is meant to be committed; manifest.json is a
 * per-machine build-state cache that would make contributors' incremental diffs clobber
 * each other if shared. Make sure it's gitignored the first time we save.
 */
function ensureManifestGitignored(workspaceRoot: string): void {
  const entry = ".ftbdeploy/manifest.json";
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf8");
    if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${existing}${prefix}${entry}\n`, "utf8");
}

/** workspaceState key for unsaved configuration edits, so they survive the tab being closed or VS Code reloading. Never holds secrets — those are only entered via native password input boxes. */
const DRAFT_KEY = "ftpilot.draft";

export class FtpilotPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "ftpilotPanel";
  /** Sidebar (operations view) and, when open, the configuration editor tab. */
  private webviews = new Set<vscode.Webview>();
  private editorPanel?: vscode.WebviewPanel;
  /** Sent to the config tab once its script is ready (e.g. "focus this target"). */
  private pendingEditorMsg?: OutMsg;
  /** Live FTP session opened by "Check connection"; deploy/backup still open their own. */
  private client?: ftp.Client;
  private keepAlive?: NodeJS.Timeout;
  private conn: ConnState = { state: "idle", text: "Not connected" };
  /** Latest deploy progress, re-sent to views that open mid-deploy or after it. */
  private progress?: DeployState;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const sub = this.attach(webviewView.webview, false);
    // Refresh on show so the branch guardrail reflects any checkout done meanwhile.
    const vis = webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.postInit(); });
    webviewView.onDidDispose(() => { sub.dispose(); vis.dispose(); });
  }

  /** Opens (or focuses) the full configuration tab, optionally jumping to a target. */
  openInEditor(focus?: { targetId?: string; addTarget?: boolean }): void {
    const focusMsg: OutMsg | undefined = focus && (focus.targetId || focus.addTarget) ? { type: "focus", ...focus } : undefined;
    if (this.editorPanel) {
      this.editorPanel.reveal();
      if (focusMsg) void this.editorPanel.webview.postMessage(focusMsg);
      return;
    }
    this.pendingEditorMsg = focusMsg;
    const panel = vscode.window.createWebviewPanel(
      FtpilotPanel.viewType + ".editor",
      "FTPilot Configuration",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.codiconRoot()] }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.png");
    this.editorPanel = panel;
    const sub = this.attach(panel.webview, true);
    panel.onDidDispose(() => {
      sub.dispose();
      this.editorPanel = undefined;
    });
  }

  private codiconRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "@vscode", "codicons", "dist");
  }

  private attach(webview: vscode.Webview, inEditor: boolean): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [this.codiconRoot()] };
    webview.html = renderHtml(inEditor, webview, vscode.Uri.joinPath(this.codiconRoot(), "codicon.css"));
    this.webviews.add(webview);
    const listener = webview.onDidReceiveMessage((msg: InMsg) => {
      void this.handleMessage(msg, webview);
    });
    return new vscode.Disposable(() => {
      listener.dispose();
      this.webviews.delete(webview);
    });
  }

  refresh(): void {
    this.postInit();
  }

  reportProgress(state: DeployState): void {
    this.progress = slimState(state);
    this.post({ type: "progress", state: this.progress });
  }

  reportStatus(text: string, kind: "idle" | "busy" | "ok" | "error"): void {
    this.post({ type: "status", text, kind });
  }

  /** Broadcasts to every open FTPilot webview, optionally skipping one (the sender). */
  private post(msg: OutMsg, except?: vscode.Webview): void {
    for (const w of this.webviews) {
      if (w !== except) void w.postMessage(msg);
    }
  }

  private async buildMeta(root: string, config?: DeployConfig): Promise<InitMeta> {
    let branch: string | undefined;
    try {
      branch = await getCurrentBranch(root);
    } catch {
      // not a git repo — branch guardrail shown as unknown
    }
    const targetLogins: Record<string, boolean> = {};
    const envSecretsSet: Record<string, string[]> = {};
    for (const t of config?.targets ?? []) {
      if (t.ftpUser) targetLogins[t.ftpUser] = (await getLoginStatus(this.context, root, t.ftpUser)).hasPassword;
      const key = t.id ?? t.name;
      for (const v of t.env ?? []) {
        if (v.secret && (await getEnvSecret(this.context, root, key, v.key))) (envSecretsSet[key] ??= []).push(v.key);
      }
    }
    return {
      projectName: path.basename(root),
      branch,
      login: await getLoginStatus(this.context, root, "default"),
      targetLogins,
      envSecretsSet,
      geekMode: vscode.workspace.getConfiguration("ftpilot").get<boolean>("geekMode", false),
      rollbackable: rollbackableId(root),
    };
  }

  private postInit(): void {
    void this.postInitAsync();
  }

  private async postInitAsync(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.post({ type: "init", workspaceOpen: false });
      return;
    }
    let config: DeployConfig | undefined;
    if (configExists(root)) {
      try {
        config = loadConfig(root, false);
      } catch (err) {
        this.post({ type: "error", message: (err as Error).message });
      }
    }
    // The draft can name targets/ftpUsers not saved yet; include them in the secret-status lookup.
    const draft = this.getDraft();
    const meta = await this.buildMeta(root, draft ? { ...(config ?? draft), targets: [...(config?.targets ?? []), ...draft.targets] } : config);
    this.post({ type: "init", workspaceOpen: true, config, draft, meta });
  }

  private setConn(conn: ConnState): void {
    this.conn = conn;
    this.post({ type: "connection", conn });
  }

  disconnect(text = "Disconnected"): void {
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    this.client?.close();
    this.client = undefined;
    this.setConn({ state: "idle", text });
  }

  dispose(): void {
    this.disconnect();
  }

  private async connectAndCheck(root: string, config: DeployConfig, stay: boolean): Promise<void> {
    this.disconnect();
    if (!config.host) {
      this.setConn({ state: "error", text: "Enter the FTP host first." });
      return;
    }
    const creds = await getCredentials(this.context, root, "default");
    if (!creds) {
      this.setConn({ state: "error", text: "No FTP login saved for this project. Use Update Credentials." });
      return;
    }
    this.setConn({ state: "connecting", text: `Connecting to ${config.host}:${config.port}…` });
    let client: ftp.Client | undefined;
    try {
      client = await ftpClient.connect(config, creds);
      const home = await client.pwd();
      const checks: NonNullable<ConnState["checks"]> = [];
      for (const t of config.targets) {
        if (!t.remoteDir) continue;
        let exists = true;
        try {
          await client.cd(t.remoteDir);
        } catch {
          exists = false;
        }
        await client.cd(home);
        checks.push({ name: t.name || "(unnamed)", remoteDir: t.remoteDir, exists });
      }
      if (!stay) {
        client.close();
        this.setConn({ state: "ok", text: `Login OK as ${creds.user} @ ${config.host} (not kept open)`, checks });
        return;
      }
      this.client = client;
      // Servers drop idle FTP sessions after a few minutes; NOOP keeps it open, and a
      // failed NOOP means the server closed it, so reflect that in the UI.
      this.keepAlive = setInterval(() => {
        this.client?.send("NOOP").catch(() => this.disconnect("Connection closed by server"));
      }, 60_000);
      this.setConn({ state: "connected", text: `Connected as ${creds.user} @ ${config.host}`, checks });
    } catch (err) {
      client?.close();
      this.setConn({ state: "error", text: friendlyFtpError(err, config.host, config.port) });
    }
  }

  private getDraft(): DeployConfig | undefined {
    return this.context.workspaceState.get<DeployConfig>(DRAFT_KEY);
  }

  private async handleMessage(msg: InMsg, from: vscode.Webview): Promise<void> {
    const root = this.getWorkspaceRoot();
    const reply = (m: OutMsg) => void from.postMessage(m);

    switch (msg.type) {
      case "ready":
        this.postInit();
        reply({ type: "connection", conn: this.conn });
        if (this.progress) reply({ type: "progress", state: this.progress });
        if (this.pendingEditorMsg && from === this.editorPanel?.webview) {
          // The tab queues this until its first init has arrived.
          reply(this.pendingEditorMsg);
          this.pendingEditorMsg = undefined;
        }
        return;

      case "openReport":
        if (this.progress?.reportPath) await vscode.env.openExternal(vscode.Uri.file(this.progress.reportPath));
        return;

      case "openLog":
        if (this.progress?.logPath) await vscode.window.showTextDocument(vscode.Uri.file(this.progress.logPath), { preview: true });
        return;

      case "showOutput":
        await vscode.commands.executeCommand("ftpilot.showOutput");
        return;

      case "testFtps": {
        if (!root) return;
        const creds = await getCredentials(this.context, root, "default");
        if (!creds) {
          reply({ type: "ftpsResult", ok: false, message: "Save your FTP login first (Update Credentials)." });
          return;
        }
        reply({ type: "ftpsResult", ok: false, testing: true, message: `Trying an encrypted login to ${msg.config.host}…` });
        try {
          // Always verify the certificate here: the point is to find a setup that doesn't need the bypass.
          const client = await ftpClient.connect({ ...msg.config, secure: true, allowInvalidCert: false }, creds);
          client.close();
          reply({ type: "ftpsResult", ok: true, message: `FTPS works on ${msg.config.host} with a valid certificate.` });
        } catch (err) {
          const tls = ftpClient.diagnoseTlsError(err);
          reply({
            type: "ftpsResult",
            ok: false,
            message: tls?.message ?? friendlyFtpError(err, msg.config.host, msg.config.port),
            certIssue: tls?.certIssue,
            unsupported: tls?.unsupported,
            suggestedHost: tls?.suggestedHost && tls.suggestedHost !== msg.config.host ? tls.suggestedHost : undefined,
          });
        }
        return;
      }

      case "preview":
        await vscode.commands.executeCommand("ftpilot.preview", { targetId: msg.targetId, compareRemote: msg.compareRemote, skipBuild: msg.skipBuild });
        this.postInit();
        return;

      case "testHealth": {
        reply({ type: "healthResult", index: msg.index, result: null });
        // One attempt: this is an interactive check, not a post-restart wait.
        const result = await checkHealth(msg.url.trim(), msg.expect?.trim() || undefined, { attempts: 1 });
        reply({ type: "healthResult", index: msg.index, result });
        return;
      }

      case "rollback":
        await vscode.commands.executeCommand("ftpilot.rollback", { snapshotId: msg.id, confirmed: true });
        this.postInit();
        return;

      case "deployFromPreview":
        await vscode.commands.executeCommand("ftpilot.deployPreview", { targetId: this.progress?.onlyTargetId });
        this.postInit();
        return;

      case "openDashboard":
        await vscode.commands.executeCommand("ftpilot.openDashboard");
        return;

      case "cancelDeploy":
        await vscode.commands.executeCommand("ftpilot.cancelDeploy");
        return;

      case "dismissProgress":
        this.progress = undefined;
        this.post({ type: "progress", state: null });
        return;

      case "openHelp":
        await vscode.commands.executeCommand("ftpilot.openHelp");
        return;

      case "updateCredentials": {
        if (!root) return;
        const isProject = msg.account === "default";
        let user = msg.account;
        if (isProject) {
          const current = await getLoginStatus(this.context, root, "default");
          const entered = await vscode.window.showInputBox({
            title: "FTPilot: Update Credentials (1/2)",
            prompt: `FTP username for ${path.basename(root)}`,
            value: current.user ?? "",
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : "Username is required"),
          });
          if (entered === undefined) return;
          user = entered.trim();
        }
        const password = await vscode.window.showInputBox({
          title: isProject ? "FTPilot: Update Credentials (2/2)" : "FTPilot: Update Credentials",
          prompt: `FTP password for ${user}`,
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v ? undefined : "Password is required"),
        });
        if (!password) return;
        await setCredentials(this.context, root, msg.account, { user, password });
        this.reportStatus(`Credentials saved for ${user}.`, "ok");
        this.postInit();
        return;
      }

      case "setEnvSecret": {
        if (!root) return;
        const value = await vscode.window.showInputBox({
          title: "FTPilot: Set Secret Value",
          prompt: `Value for ${msg.key} (stored in VS Code SecretStorage, never in config.json)`,
          password: true,
          ignoreFocusOut: true,
        });
        if (value === undefined || value === "") return;
        await setEnvSecret(this.context, root, msg.targetId, msg.key, value);
        this.reportStatus(`Secret ${msg.key} saved.`, "ok");
        this.postInit();
        return;
      }

      case "connect":
        if (root) await this.connectAndCheck(root, msg.config, msg.stay);
        return;

      case "disconnect":
        this.disconnect();
        return;

      case "draft":
        await this.context.workspaceState.update(DRAFT_KEY, msg.config ?? undefined);
        this.post({ type: "draft", config: msg.config }, from);
        return;

      case "openInEditor":
        this.openInEditor({ targetId: msg.targetId, addTarget: msg.addTarget });
        return;

      case "listDirs": {
        if (!root) return;
        const base = msg.forPath ? path.join(root, msg.forPath) : root;
        let dirs: string[] = [];
        try {
          dirs = fs
            .readdirSync(base, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !IGNORE_DIR_NAMES.has(e.name) && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort();
        } catch {
          // path doesn't exist yet (e.g. pre-build) — empty list is fine, "Custom" still works
        }
        reply({ type: "dirs", forPath: msg.forPath, dirs });
        return;
      }

      case "browse": {
        if (!root) return;
        const start = msg.from && fs.existsSync(path.join(root, msg.from)) ? path.join(root, msg.from) : root;
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
          defaultUri: vscode.Uri.file(start),
          openLabel: msg.field === "cwd" ? "Use as Project Folder" : "Use as Output Folder",
        });
        if (!picked?.[0]) return;
        const rel = path.relative(root, picked[0].fsPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          reply({ type: "error", message: "Pick a folder inside the open project (" + path.basename(root) + ")." });
          return;
        }
        reply({ type: "browsed", index: msg.index, field: msg.field, value: rel.split(path.sep).join("/") });
        return;
      }

      case "detect": {
        if (!root) return;
        const r = detectProject(root, msg.cwd);
        reply({ type: "detected", index: msg.index, ...r });
        return;
      }

      case "saveConfig": {
        if (!root) return;
        const problems = validateTargets(msg.config.targets);
        if (problems.length) {
          reply({ type: "error", message: "Not saved. " + problems.join(" ") });
          return;
        }
        try {
          saveConfig(root, msg.config);
          ensureManifestGitignored(root);
          if (msg.defaultUser && msg.defaultPassword) {
            await setCredentials(this.context, root, "default", {
              user: msg.defaultUser,
              password: msg.defaultPassword,
            });
          }
          if (msg.targetCreds) {
            for (const [account, creds] of Object.entries(msg.targetCreds)) {
              if (creds.user && creds.password) {
                await setCredentials(this.context, root, account, creds);
              }
            }
          }
          if (msg.envSecrets) {
            for (const [targetName, vars] of Object.entries(msg.envSecrets)) {
              for (const [key, value] of Object.entries(vars)) {
                if (value) {
                  await setEnvSecret(this.context, root, targetName, key, value);
                }
              }
            }
          }
          await this.context.workspaceState.update(DRAFT_KEY, undefined);
          reply({ type: "saved" });
          this.postInit();
        } catch (err) {
          reply({ type: "error", message: (err as Error).message });
        }
        return;
      }

      case "deploy":
        await vscode.commands.executeCommand("ftpilot.deploy");
        this.postInit();
        return;

      case "deployTarget":
        await vscode.commands.executeCommand("ftpilot.deployTarget", msg.id);
        this.postInit();
        return;

      case "fullRedeploy":
        await vscode.commands.executeCommand("ftpilot.fullRedeploy");
        this.postInit();
        return;

      case "backup":
        this.reportStatus("Backing up server...", "busy");
        await vscode.commands.executeCommand("ftpilot.backup");
        this.postInit();
        return;

      case "openConfigJson":
        await vscode.commands.executeCommand("ftpilot.editConfig");
        return;
    }
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function renderHtml(inEditor: boolean, webview: vscode.Webview, codiconCss: vscode.Uri): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${webview.asWebviewUri(codiconCss)}">
<style>${CSS}</style>
</head>
<body${inEditor ? ' class="in-editor"' : ""}>
<div id="root">Loading…</div>
<script nonce="${nonce}">const IN_EDITOR = ${inEditor};${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
  :root { --gap: 8px; --ctl-h: 26px; --border: var(--vscode-sideBar-border, var(--vscode-panel-border, rgba(128,128,128,0.2))); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 12px; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  body.in-editor { background: var(--vscode-editor-background); }
  body.in-editor #root { max-width: 760px; margin: 0 auto; padding-top: 8px; }

  /* Controls */
  label { display: block; font-size: 12px; margin: 6px 0 0; color: var(--vscode-foreground); }
  label > input, label > select { margin-top: 3px; }
  input[type=text], input[type=number], input[type=password], select {
    display: block; width: 100%; height: var(--ctl-h); padding: 0 6px; font: inherit; font-size: 13px; border-radius: 2px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  select { background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); border-color: var(--vscode-dropdown-border, var(--vscode-input-border, transparent)); padding-right: 2px; }
  label > select + input { margin-top: 4px; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  input:focus, select:focus, button:focus-visible, .section-head:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input[type=checkbox] { width: 14px; height: 14px; margin: 0; accent-color: var(--vscode-button-background); flex: none; }

  button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: var(--ctl-h); padding: 0 10px; font: inherit; font-size: 13px; border-radius: 2px; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; pointer-events: none; }
  button.block { width: 100%; }
  button.link { height: auto; padding: 0; border: none; background: none; color: var(--vscode-textLink-foreground); }
  button.link:hover { background: none; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  button.icon { width: 22px; height: 22px; padding: 0; border: none; background: none; color: var(--vscode-icon-foreground, var(--vscode-foreground)); }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .codicon { font-size: 16px; }
  button .codicon { font-size: 14px; }

  /* Layout */
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 var(--gap); }
  .grid31 { display: grid; grid-template-columns: 3fr 1fr; gap: 0 var(--gap); }
  .grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
  .grid3 button { padding: 0 4px; overflow: hidden; text-overflow: ellipsis; }
  .with-btn { display: grid; grid-template-columns: 1fr auto; gap: var(--gap); align-items: end; }
  .with-btn.tight { gap: 4px; align-items: center; margin-top: 3px; }
  .with-btn.tight select { margin-top: 0; }
  button.square { width: var(--ctl-h); padding: 0; }
  .check-row { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; font-size: 12px; cursor: pointer; }
  .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 0; line-height: 1.4; }

  /* Top bar + notices */
  .topbar { padding: 6px 12px 2px; }
  .notice { display: flex; align-items: center; gap: 6px; margin: 6px 12px 0; padding: 4px 8px; font-size: 12px; border-radius: 2px; border: 1px solid transparent; }
  .notice .grow { flex: 1; }
  .notice .actions { display: flex; gap: 10px; }
  .notice.warn { background: var(--vscode-inputValidation-warningBackground); border-color: var(--vscode-inputValidation-warningBorder, transparent); }
  .notice.warn > .codicon { color: var(--vscode-editorWarning-foreground); }
  .notice.error { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder, transparent); }
  .notice.error > .codicon { color: var(--vscode-errorForeground); }
  .notice.info, .notice.busy, .notice.ok { background: var(--vscode-inputValidation-infoBackground); border-color: var(--vscode-inputValidation-infoBorder, transparent); }
  .notice.ok > .codicon { color: var(--vscode-testing-iconPassed); }

  /* Collapsible sidebar-style sections */
  .section { border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--border)); margin-top: 8px; }
  .section-head { display: flex; align-items: center; gap: 2px; height: 22px; padding: 0 8px 0 4px; cursor: pointer; user-select: none;
    background: var(--vscode-sideBarSectionHeader-background); color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .section-head .title { flex: 1; }
  .section-head .count { font-weight: 400; opacity: 0.8; }
  .section-body { padding: 2px 12px 10px 20px; }
  .section.collapsed .section-body { display: none; }

  /* Connection status */
  .conn-line { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .conn-line .codicon { font-size: 14px; }
  .conn-connected .codicon, .conn-ok .codicon { color: var(--vscode-testing-iconPassed); }
  .conn-error { color: var(--vscode-errorForeground); }
  .conn-error .codicon { color: var(--vscode-errorForeground); }
  .conn-checks { list-style: none; margin: 4px 0 0; padding: 0 0 0 20px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .conn-checks li { display: flex; align-items: center; gap: 4px; }
  .conn-checks .codicon { font-size: 13px; }
  .conn-checks .codicon-check { color: var(--vscode-testing-iconPassed); }
  .conn-checks .codicon-warning { color: var(--vscode-editorWarning-foreground); }

  /* Target cards */
  .card { margin-top: 8px; border: 1px solid var(--border); border-radius: 2px; background: var(--vscode-editorWidget-background, transparent); }
  .card-head { display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 4px 0 8px; }
  .card-head .title { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-head .title.placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }
  .card-body { padding: 0 8px 10px; border-top: 1px solid var(--border); }
  .card.collapsed .card-body { display: none; }

  /* Switch */
  .switch-row { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; cursor: pointer; user-select: none; }
  .switch { position: relative; width: 26px; height: 14px; border-radius: 7px; flex: none; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-foreground); opacity: 0.7; transition: left .12s; }
  .switch[aria-checked=true] { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .switch[aria-checked=true]::after { left: 14px; background: var(--vscode-button-foreground); opacity: 1; }
  .advanced { margin-top: 4px; padding-left: 10px; border-left: 1px solid var(--border); }

  /* Env vars */
  .env-head { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 12px; }
  .env-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) auto auto; align-items: center; gap: 4px; margin-top: 4px; }
  .env-row label.secret { display: flex; align-items: center; gap: 3px; margin: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }

  /* Footer */
  .actions-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; padding: 10px 12px 0; }
  .actions-row button { padding: 0 4px; overflow: hidden; text-overflow: ellipsis; }
  .footer { position: sticky; bottom: 0; padding: 8px 12px; border-top: 1px solid var(--border); margin-top: 10px; }
  .footer { background: var(--vscode-sideBar-background); }
  body.in-editor .footer { background: var(--vscode-editor-background); }
  .footer-links { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; }

  /* Labels, helper text, tooltips */
  .label-text { display: inline-flex; align-items: center; gap: 4px; }
  .info { display: inline-flex; color: var(--vscode-descriptionForeground); cursor: help; }
  .info .codicon { font-size: 13px; }
  .field .hint { margin-top: 3px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .warn-text { color: var(--vscode-editorWarning-foreground); display: inline-flex; align-items: center; gap: 2px; }
  .ok-icon { color: var(--vscode-testing-iconPassed); display: inline-flex; }
  .warn-text .codicon, .ok-icon .codicon { font-size: 13px; }

  /* Key/value rows (sidebar summary) */
  .kv-list { padding-top: 4px; }
  .kv { display: grid; grid-template-columns: 16px 58px minmax(0, 1fr); align-items: center; gap: 6px; min-height: 22px; font-size: 12px; }
  .kv > .codicon { font-size: 14px; color: var(--vscode-descriptionForeground); }
  .kv .k { color: var(--vscode-descriptionForeground); }
  .kv .v { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .kv .vt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kv .v button.icon { width: 18px; height: 18px; flex: none; }
  .kv .v button.icon .codicon { font-size: 13px; }
  .kv.conn-connected > .codicon, .kv.conn-ok > .codicon { color: var(--vscode-testing-iconPassed); }
  .kv.conn-error > .codicon, .kv.conn-error .v { color: var(--vscode-errorForeground); }
  .section-head .acts { display: flex; align-items: center; gap: 0; }
  .section-head .acts button.icon { width: 20px; height: 20px; }
  .card.ops .card-body { padding: 4px 8px 6px; }
  .card.ops .kv { grid-template-columns: 16px 52px minmax(0, 1fr); }
  .actions-row.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .empty-state { padding: 16px 16px 8px; text-align: center; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .empty-state .codicon.big { font-size: 32px; opacity: 0.6; }
  .empty-state button.block { margin-top: 4px; }

  .tls-box .notice { margin: 8px 0 0; }
  .tls-box .check-row { margin-top: 8px; }
  .detect-note { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; font-size: 12px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  .detect-note .codicon { font-size: 14px; margin-top: 1px; color: var(--vscode-testing-iconPassed); }
  .detect-note.bad .codicon { color: var(--vscode-editorWarning-foreground); }

  /* Deploy progress card */
  .pc { margin: 8px 12px 0; padding: 8px; border: 1px solid var(--border); border-radius: 2px; background: var(--vscode-editorWidget-background, transparent); font-size: 12px; }
  .pc.failed { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  .pc-head { display: flex; align-items: center; gap: 6px; }
  .pc-head strong { flex: 1; font-size: 13px; font-weight: 600; }
  .pc-head > .codicon { font-size: 16px; }
  .pc.ok .pc-head > .codicon { color: var(--vscode-testing-iconPassed); }
  .pc.failed .pc-head > .codicon { color: var(--vscode-errorForeground); }
  .pc-time { font-variant-numeric: tabular-nums; }
  .pc-now { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; min-width: 0; }
  .pc-now code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pc-bar { height: 4px; margin-top: 8px; border-radius: 2px; background: var(--vscode-progressBar-background, var(--vscode-button-background)); background: color-mix(in srgb, var(--vscode-progressBar-background, #0078d4) 20%, transparent); overflow: hidden; }
  .pc-bar > div { height: 100%; background: var(--vscode-progressBar-background, var(--vscode-button-background)); transition: width .2s; }
  .pc-count { display: flex; justify-content: space-between; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .pc-actions { margin-top: 8px; }
  .pc.preview .pc-head > .codicon { color: var(--vscode-textLink-foreground); }
  .pc .notice { margin: 8px 0 0; }
  .pc-stats { margin-top: 2px; font-variant-numeric: tabular-nums; }
  .pc-targets { list-style: none; margin: 8px 0 0; padding: 0; }
  .pc-targets li { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 6px; align-items: center; min-height: 20px; }
  .pc-targets .codicon { font-size: 14px; color: var(--vscode-descriptionForeground); }
  .pc-targets .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pc-targets .r { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .pc-targets .pc-done .codicon, .pc-targets .pc-built .codicon { color: var(--vscode-testing-iconPassed); }
  .pc-targets .pc-failed .codicon, .pc-targets .pc-failed .r { color: var(--vscode-errorForeground); }
  .pc-error { margin-top: 8px; padding: 6px 8px; border-radius: 2px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder, transparent); white-space: pre-wrap; word-break: break-word; }
  .pc-error pre { margin: 6px 0 0; max-height: 180px; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  .pc-links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  .pc-links button.link { display: inline-flex; align-items: center; gap: 4px; }

  /* Config tab */
  .cfg-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 8px 12px 0; }
  .cfg-header h1 { font-size: 18px; font-weight: 600; margin: 0; }
  .cfg-header .hint { margin: 2px 0 0; }
  .cfg-links { display: flex; gap: 14px; font-size: 12px; padding-top: 4px; }
  .cfg-links button.link { display: inline-flex; align-items: center; gap: 4px; }
  .cred-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px; }
  .cred-row > .codicon { color: var(--vscode-descriptionForeground); }
  .cred-pass { letter-spacing: 1px; color: var(--vscode-descriptionForeground); }
  .env-row > button.secondary { justify-content: flex-start; }

  /* Confirm screens */
  .confirm { padding: 8px 12px; }
  .confirm h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin: 6px 0 8px; color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground)); }
  .summary { border: 1px solid var(--border); border-radius: 2px; padding: 6px 8px; font-size: 12px; line-height: 1.7; }
  .summary .field-row { display: flex; justify-content: space-between; gap: 8px; }
  .summary .field-row span:first-child { color: var(--vscode-descriptionForeground); }
  .summary .field-row span:last-child { text-align: right; word-break: break-all; }
  .summary .target-block { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .summary .target-block:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .confirm .notice { margin: 0 0 8px; }
  .confirm .btns { display: grid; gap: 6px; margin-top: 10px; }
  .empty { padding: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
function post(msg) { vscode.postMessage(msg); }
// Sidebar = daily operations (read-only summary + deploy); editor tab = full configuration form.
const MODE = IN_EDITOR ? "config" : "ops";

let workspaceOpen = false;
let saved = null;       // config.json as on disk (null = not configured yet)
let cfg = null;         // ops: same as saved; config: the editable working copy
let meta = null;        // { projectName, branch, login, targetLogins, envSecretsSet }
let hasDraft = false;   // ops: the config tab holds unsaved edits
let lastStatus = null;
let conn = { state: "idle", text: "Disconnected" };
let view = "form";      // "form" | "confirmSave" | "confirmDeploy" | "confirmFull" | "confirmBackup" | "confirmDeployTarget"
let pendingTarget = null;
let pendingRollback = null;
let customFields = {};
let advancedOpen = {};
let dirsCache = {};
let requestedPaths = new Set();
let baseline = JSON.stringify(defaultConfig());
let lastSentDraft = baseline;
let draftTimer = null;
let initDone = false;
let progress = null; // live/last deploy state from the host
let progressTimer = null;
let healthNotes = {}; // target index -> null (testing) | HealthResult
let ftpsResult = null; // last Test FTPS outcome (config tab)
let detectNotes = {}; // target index -> { text, ok } from the last Auto-detect
let pendingFocus = null;

// Per-view UI conveniences (collapsed sections/cards). Safe to lose; never holds config.
let ui = { sections: {}, cards: {} };
try { const st = vscode.getState(); if (st && st.ui) ui = st.ui; } catch (e) {}
function saveUi() { try { vscode.setState({ ui }); } catch (e) {} }

// Unsaved config edits persist via the extension host (workspaceState), so they survive
// closing the tab or reloading. cfg never holds secrets: those only go through native input boxes.
function scheduleDraft() {
  if (MODE !== "config") return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const s = JSON.stringify(cfg);
    if (!cfg || s === lastSentDraft) return;
    lastSentDraft = s;
    post({ type: "draft", config: s === baseline ? null : cfg });
  }, 300);
}
document.addEventListener("input", scheduleDraft);
document.addEventListener("change", scheduleDraft);

function defaultConfig() {
  return { deployBranch: "deploy", host: "", port: 21, secure: true, uploadMode: "incremental", maxConnections: 8, exclude: ["*.map", "*.d.ts"], targets: [] };
}
function blankTarget() {
  return { id: genId(), name: "", buildCommand: "", cwd: "", localDir: "", remoteDir: "", env: [] };
}
// Stable per-target id so env secrets survive a rename (SecretStorage is keyed by id, not name).
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function isDirty() { return MODE === "config" && !!cfg && JSON.stringify(cfg) !== baseline; }
function targetKey(t) { return t.id || t.name; }

function ensureDirsRequested(forPath) {
  const key = forPath || "";
  if (!(key in dirsCache) && !requestedPaths.has(key)) {
    requestedPaths.add(key);
    post({ type: "listDirs", forPath: key });
  }
}

function applyFocus(msg) {
  let index = -1;
    if (msg.addTarget) { cfg.targets.push(blankTarget()); index = cfg.targets.length - 1; }
    else index = cfg.targets.findIndex((t) => targetKey(t) === msg.targetId);
    if (index < 0) return;
    ui.sections.targets = false;
    ui.cards[targetKey(cfg.targets[index])] = false;
    render();
    scrollToCard(index);
}

function scrollToCard(index) {
  const card = document.querySelectorAll(".card")[index];
  if (card) { card.scrollIntoView({ block: "start" }); const f = card.querySelector("input"); if (f) f.focus({ preventScroll: true }); }
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    workspaceOpen = msg.workspaceOpen;
    saved = msg.config || null;
    meta = msg.meta || null;
    const disk = saved ? JSON.parse(JSON.stringify(saved)) : defaultConfig();
    // Backfill ids for targets saved before "id" existed (persisted on next save).
    for (const t of disk.targets) { if (!t.id) t.id = genId(); if (!t.env) t.env = []; }
    // Configs saved before these settings existed get the defaults, without counting as an edit.
    if (disk.maxConnections === undefined) disk.maxConnections = 8;
    if (!disk.exclude) disk.exclude = ["*.map", "*.d.ts"];
    baseline = JSON.stringify(disk);
    hasDraft = !!msg.draft;
    cfg = MODE === "config" && msg.draft ? msg.draft : disk;
    lastSentDraft = JSON.stringify(cfg);
    // Deliberately not resetting the view: init also arrives on visibility changes and config-file
    // writes, and must not yank the user out of a confirm screen. Flows that finish (save,
    // deploy, rollback) already return to the form themselves.
    // A "busy..." notice is stale once fresh state arrives.
    if (lastStatus && lastStatus.kind === "busy") lastStatus = null;
    // Index-keyed toggles would leak onto other targets after a reload; reset them.
    advancedOpen = {};
    detectNotes = {};
    healthNotes = {};
    if (ftpsResult && ftpsResult.testing) ftpsResult = null;
    render();
    initDone = true;
    if (pendingFocus) { const f = pendingFocus; pendingFocus = null; applyFocus(f); }
  } else if (msg.type === "focus") {
    if (MODE !== "config") return;
    if (!initDone) { pendingFocus = msg; return; }
    applyFocus(msg);
  } else if (msg.type === "detected") {
    const t = cfg.targets[msg.index];
    if (!t) return;
    if (msg.cwd !== (t.cwd || "")) { t.cwd = msg.cwd; customFields["cwd_" + msg.index] = false; }
    if (msg.buildCommand) t.buildCommand = msg.buildCommand;
    if (msg.localDir) { t.localDir = msg.localDir; customFields["localDir_" + msg.index] = false; }
    detectNotes[msg.index] = { text: msg.note, ok: !!(msg.buildCommand || msg.localDir) };
    render();
  } else if (msg.type === "browsed") {
    const t = cfg.targets[msg.index];
    if (!t) return;
    t[msg.field] = msg.value;
    customFields[msg.field + "_" + msg.index] = false;
    render();
  } else if (msg.type === "connection") {
    conn = msg.conn;
    // Re-render only the connection widgets so typing elsewhere keeps focus.
    for (const box of document.querySelectorAll("[data-conn]")) box.replaceWith(box.dataset.conn === "ops" ? opsConnectionBody() : connectionBox());
    const acts = document.getElementById("conn-acts");
    if (acts) acts.replaceWith(opsConnActions());
  } else if (msg.type === "healthResult") {
    healthNotes[msg.index] = msg.result;
    render();
  } else if (msg.type === "ftpsResult") {
    ftpsResult = msg;
    render();
  } else if (msg.type === "progress") {
    const wasRunning = isRunning(progress);
    progress = msg.state;
    const running = isRunning(progress);
    // Tick the elapsed timer while running, even between host updates.
    if (running && !progressTimer) progressTimer = setInterval(refreshProgressCard, 1000);
    if (!running && progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (running !== wasRunning) render(); else refreshProgressCard();
  } else if (msg.type === "draft") {
    if (MODE === "config") {
      cfg = msg.config || JSON.parse(baseline);
      lastSentDraft = JSON.stringify(cfg);
    } else {
      hasDraft = !!msg.config;
    }
    render();
  } else if (msg.type === "dirs") {
    dirsCache[msg.forPath || ""] = msg.dirs;
    render();
  } else if (msg.type === "status") {
    lastStatus = msg;
    render();
  } else if (msg.type === "error") {
    lastStatus = { text: msg.message, kind: "error" };
    render();
  } else if (msg.type === "saved") {
    lastStatus = { text: "Configuration saved.", kind: "ok" };
    view = "form";
    render();
  }
});

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const k in attrs || {}) {
    if (k === "class") node.className = attrs[k];
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), attrs[k]);
    else node.setAttribute(k, attrs[k]);
  }
  for (const c of children || []) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function ic(name, extra) {
  return el("i", { class: "codicon codicon-" + name + (extra ? " " + extra : ""), "aria-hidden": "true" }, []);
}

function iconBtn(icon, title, onclick, disabled) {
  return el("button", { class: "icon", title, "aria-label": title, ...(disabled ? { disabled: "disabled" } : {}),
    onclick: (e) => { e.stopPropagation(); onclick(e); } }, [ic(icon)]);
}

// Native-style inline tooltip beside a label.
function info(text) {
  return el("span", { class: "info", title: text, "aria-label": text, role: "img" }, [ic("info")]);
}

function labelText(text, opts) {
  return el("span", { class: "label-text" }, [text, opts && opts.info ? info(opts.info) : null]);
}

function field(labelEl, opts) {
  return opts && opts.help ? el("div", { class: "field" }, [labelEl, el("p", { class: "hint" }, [opts.help])]) : labelEl;
}

function labeledInput(text, value, onInput, opts) {
  opts = opts || {};
  const input = el("input", {
    type: opts.type || "text",
    value: value || "",
    placeholder: opts.placeholder || "",
    oninput: (e) => onInput(e.target.value),
  });
  return field(el("label", {}, [labelText(text, opts), input]), opts);
}

function labeledSelect(text, value, options, onChange, opts) {
  const select = el("select", { onchange: (e) => onChange(e.target.value) },
    options.map((o) => el("option", { value: o.value, ...(o.value === value ? { selected: "selected" } : {}) }, [o.label])));
  return field(el("label", {}, [labelText(text, opts), select]), opts);
}

// A <select> of real, on-disk folders, falling back to a free-text box for "Custom" or
// values not in the list; optional folder-picker button for nested folders.
function selectOrCustom(key, text, value, options, onChange, opts) {
  opts = opts || {};
  const inOptions = options.includes(value) || (opts.allowBlank && !value);
  const isCustom = !!customFields[key] || (!!value && !inOptions);
  const selectValue = isCustom ? "__custom__" : (value || "");

  const optionEls = [];
  // Without this, an empty value would *display* the first option while saving "".
  if (!opts.allowBlank && selectValue === "") {
    optionEls.push(el("option", { value: "", disabled: "disabled", selected: "selected" }, ["Select a folder..."]));
  }
  if (opts.allowBlank) {
    optionEls.push(el("option", { value: "", ...(selectValue === "" ? { selected: "selected" } : {}) }, [opts.blankLabel || "(project root)"]));
  }
  for (const o of options) {
    optionEls.push(el("option", { value: o, ...(selectValue === o ? { selected: "selected" } : {}) }, [o]));
  }
  optionEls.push(el("option", { value: "__custom__", ...(selectValue === "__custom__" ? { selected: "selected" } : {}) }, ["Custom path..."]));

  const selectEl = el("select", {
    onchange: (e) => {
      const v = e.target.value;
      if (v === "__custom__") { customFields[key] = true; }
      else { customFields[key] = false; onChange(v); }
      render();
    },
  }, optionEls);

  const kids = [labelText(text, opts), opts.onBrowse
    ? el("div", { class: "with-btn tight" }, [selectEl, el("button", { class: "secondary square", title: "Browse for a folder", "aria-label": "Browse for a folder", onclick: (e) => { e.preventDefault(); opts.onBrowse(); } }, [ic("folder-opened")])])
    : selectEl];
  if (isCustom) {
    kids.push(el("input", { type: "text", value: value || "", placeholder: opts.placeholder || "", "aria-label": text, oninput: (e) => onChange(e.target.value) }));
  }
  return field(el("label", {}, kids), opts);
}

function section(key, title, children, opts) {
  opts = opts || {};
  const collapsed = !!ui.sections[key];
  const toggle = () => { ui.sections[key] = !collapsed; saveUi(); render(); };
  const head = el("div", {
    class: "section-head", role: "button", tabindex: "0", "aria-expanded": String(!collapsed),
    onclick: toggle, onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } },
  }, [
    ic(collapsed ? "chevron-right" : "chevron-down"),
    el("span", { class: "title" }, [title, opts.count !== undefined ? el("span", { class: "count" }, [" (" + opts.count + ")"]) : null]),
    opts.actions ? el("span", { class: "acts", ...(opts.actionsId ? { id: opts.actionsId } : {}) }, opts.actions) : null,
  ]);
  return el("div", { class: "section" + (collapsed ? " collapsed" : "") }, [head, el("div", { class: "section-body" }, children)]);
}

function notice(kind, icon, children, actions) {
  return el("div", { class: "notice " + kind, role: kind === "error" ? "alert" : "status" }, [
    ic(icon), el("span", { class: "grow" }, children), actions ? el("span", { class: "actions" }, actions) : null,
  ]);
}

function link(text, onclick, icon) {
  return el("button", { class: "link", onclick }, [icon ? ic(icon) : null, text]);
}

const STATUS_ICON = { busy: "loading codicon-modifier-spin", ok: "pass", error: "error", idle: "info" };
function statusNotice() {
  return lastStatus ? notice(lastStatus.kind, STATUS_ICON[lastStatus.kind] || "info", [lastStatus.text]) : null;
}

function stripConfig(c) {
  const targets = c.targets.map((t) => {
    const clean = { id: t.id, name: t.name, localDir: t.localDir, remoteDir: t.remoteDir };
    if (t.buildCommand) clean.buildCommand = t.buildCommand;
    if (t.cwd) clean.cwd = t.cwd;
    if (t.restartFile) clean.restartFile = t.restartFile;
    if (t.ftpUser) clean.ftpUser = t.ftpUser;
    if ((t.healthUrl || "").trim()) clean.healthUrl = t.healthUrl.trim();
    if ((t.healthExpect || "").trim()) clean.healthExpect = t.healthExpect.trim();
    const env = (t.env || []).filter((v) => v.key).map((v) => v.secret ? { key: v.key, secret: true } : { key: v.key, value: v.value || "" });
    if (env.length) clean.env = env;
    return clean;
  });
  return {
    deployBranch: c.deployBranch, host: c.host, port: c.port, secure: c.secure, uploadMode: c.uploadMode,
    ...(c.secure && c.allowInvalidCert ? { allowInvalidCert: true } : {}),
    maxConnections: c.maxConnections || 8,
    ...(c.rollbackSnapshots === false ? { rollbackSnapshots: false } : {}),
    exclude: (c.exclude || []).map((p) => p.trim()).filter(Boolean),
    targets,
  };
}

/* ---------- Connection widgets ---------- */

const CONN = {
  idle: { icon: "circle-slash", label: "Disconnected" },
  connecting: { icon: "loading codicon-modifier-spin", label: "Connecting" },
  ok: { icon: "pass", label: "Login OK" },
  connected: { icon: "pass-filled", label: "Connected" },
  error: { icon: "error", label: "Error" },
};

function remoteChecks() {
  if (!(conn.state === "connected" || conn.state === "ok") || !conn.checks || !conn.checks.length) return null;
  return el("ul", { class: "conn-checks" }, conn.checks.map((c) =>
    el("li", {}, [ic(c.exists ? "check" : "warning"), el("span", {}, [c.name + ": " + c.remoteDir + (c.exists ? "" : " (created on deploy)")])])));
}

function connect(stay) { post({ type: "connect", config: stripConfig(cfg), stay }); }

// Config tab: explicit Check | Connect | Disconnect row.
function connectionBox() {
  const busy = conn.state === "connecting";
  const connected = conn.state === "connected";
  const btn = (icon, label, title, disabled, onclick) =>
    el("button", { class: "secondary", title, ...(disabled ? { disabled: "disabled" } : {}), onclick }, [ic(icon), label]);
  return el("div", { "data-conn": "config" }, [
    el("div", { class: "conn-line conn-" + conn.state, role: "status" }, [ic(CONN[conn.state].icon), conn.text]),
    remoteChecks(),
    el("div", { class: "grid3" }, [
      btn("pulse", "Check", "Test login and remote folders, then close", busy, () => connect(false)),
      btn("plug", "Connect", "Log in and keep the connection open", busy || connected, () => connect(true)),
      btn("debug-disconnect", "Disconnect", "Close the open connection", !connected, () => post({ type: "disconnect" })),
    ]),
  ]);
}

/* ---------- Deploy progress ---------- */

function isRunning(p) { return !!p && p.phase !== "done" && p.phase !== "failed"; }

function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

const PHASE_TITLE = { preparing: "Preparing", building: "Building", comparing: "Comparing files", snapshot: "Saving rollback copy", uploading: "Uploading", checking: "Health check" };
const TARGET_ICON = { pending: "circle-outline", building: "loading codicon-modifier-spin", built: "check", uploading: "loading codicon-modifier-spin", done: "pass-filled", failed: "error" };

function targetProgressText(t) {
  if (t.status === "pending") return "waiting";
  if (t.status === "building") return "building...";
  if (t.status === "built") return "built in " + fmtMs(t.buildMs || 0);
  if (t.status === "uploading") return t.uploaded + " / " + t.toUpload + (t.toRemove ? " (+" + t.removed + "/" + t.toRemove + " removed)" : "");
  if (t.status === "failed") return "failed";
  const base = t.uploaded + " up, " + t.removed + " removed, " + t.unchanged + " same";
  if (!t.health) return base;
  return base + (t.health.ok ? " · healthy " + t.health.status + " (" + t.health.ms + " ms)" : " · unhealthy");
}

function progressCard() {
  const p = progress;
  if (!p || MODE !== "ops") return null;
  const running = isRunning(p);
  const ok = p.phase === "done";
  if (running && p.phase === "checking" && !p.currentTarget) p.currentTarget = "";
  if (!running && ok && p.dryRun) return previewCard(p);
  const rb = p.kind === "rollback";
  const title = rb
    ? (running ? "Rolling back" : ok && p.healthFailed ? "Rolled back, health check failed" : ok ? "Rollback complete" : p.cancelled ? "Rollback cancelled" : "Rollback failed")
    : running ? (p.dryRun && p.phase !== "building" ? "Previewing" : PHASE_TITLE[p.phase] || "Working") : ok && p.healthFailed ? "Deployed, health check failed" : ok ? "Deploy succeeded" : p.cancelled ? (p.dryRun ? "Preview cancelled" : "Deploy cancelled") : p.dryRun ? "Preview failed" : "Deploy failed";
  const head = el("div", { class: "pc-head" }, [
    ic(running ? "loading codicon-modifier-spin" : ok && !p.healthFailed ? "pass-filled" : ok ? "warning" : "error"),
    el("strong", {}, [title]),
    el("span", { class: "muted pc-time" }, [fmtMs((p.finishedAt || Date.now()) - p.startedAt)]),
    meta && meta.geekMode ? iconBtn("dashboard", "Open Geek Mode dashboard", () => post({ type: "openDashboard" })) : null,
    running ? null : iconBtn("close", "Dismiss", () => post({ type: "dismissProgress" })),
  ]);

  let now = null;
  if (running && p.currentTarget) {
    const sub = p.phase === "building" ? p.lastLine : p.currentFile;
    now = el("div", { class: "pc-now" }, [el("span", {}, [p.currentTarget]), sub ? el("code", { title: sub }, [sub]) : null]);
  } else if (running && p.phase === "comparing") {
    now = el("div", { class: "pc-now" }, [el("span", {}, ["Checking which files changed"])]);
  }
  // Snapshot runs before upload with its own counter, so the upload bar stays meaningful.
  const snap = running && p.phase === "snapshot" && p.snapTotal ? el("div", {}, [
    el("div", { class: "pc-bar" }, [el("div", { style: "width:" + Math.floor(((p.snapDone || 0) / p.snapTotal) * 100) + "%" }, [])]),
    el("div", { class: "pc-count muted" }, ["Saving rollback copy: " + (p.snapDone || 0) + " / " + p.snapTotal, el("span", {}, [Math.floor(((p.snapDone || 0) / p.snapTotal) * 100) + "%"])]),
  ]) : null;

  let bar = null;
  if (p.totalOps > 0) {
    const pct = Math.min(100, Math.floor((p.doneOps / p.totalOps) * 100));
    const stats = [];
    if (running && p.phase === "uploading") {
      stats.push((p.connections || 0) + (p.connections === 1 ? " connection" : " connections"));
      if (p.rate) stats.push(p.rate.toFixed(1) + " files/s");
      const remaining = p.totalOps - p.doneOps;
      if (p.rate && remaining > 0) stats.push("~" + fmtMs((remaining / p.rate) * 1000) + " left");
    } else if (!running && p.peakConnections) {
      stats.push("peak " + p.peakConnections + " connections");
    }
    if (p.retries) stats.push(p.retries + (p.retries === 1 ? " retry" : " retries"));
    bar = el("div", {}, [
      el("div", { class: "pc-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, [el("div", { style: "width:" + pct + "%" }, [])]),
      el("div", { class: "pc-count muted" }, [p.doneOps + " / " + p.totalOps + " files", el("span", {}, [pct + "%"])]),
      stats.length ? el("div", { class: "pc-stats muted" }, [stats.join(" \u00b7 ")]) : null,
    ]);
  } else if (ok) {
    bar = el("div", { class: "pc-count muted" }, ["No files changed; nothing to upload."]);
  }

  const rows = el("ul", { class: "pc-targets" }, p.targets.map((t) =>
    el("li", { class: "pc-" + t.status }, [ic(TARGET_ICON[t.status] || "circle-outline"), el("span", { class: "n" }, [t.name]), el("span", { class: "r" }, [targetProgressText(t)])])));

  const unhealthy = p.targets.filter((t) => t.health && !t.health.ok);
  const healthErr = !running && unhealthy.length ? el("div", { class: "pc-error", role: "alert" }, unhealthy.map((t) =>
    el("div", {}, [t.name + ": " + t.health.error + " (" + t.health.url + ")"]))) : null;
  const err = p.error ? el("div", { class: "pc-error", role: "alert" }, [
    el("div", {}, [p.error.message]),
    p.error.detail ? el("pre", {}, [p.error.detail]) : null,
  ]) : null;

  // Offered after success, a failed health check, or a failure mid-upload (partial deploy).
  const canRollBack = !running && !rb && !p.dryRun && p.rollbackId && meta && meta.rollbackable === p.rollbackId;
  const rollbackBtn = canRollBack ? el("div", { class: "pc-actions" }, [
    el("button", { class: p.healthFailed || p.phase === "failed" ? "block" : "secondary block", onclick: () => { pendingRollback = p.rollbackId; view = "confirmRollback"; render(); } }, [ic("discard"), "Roll Back This Deploy"]),
  ]) : null;
  const links = running ? el("div", { class: "pc-links" }, [
    link("Cancel", () => post({ type: "cancelDeploy" }), "debug-stop"),
    link("Output", () => post({ type: "showOutput" }), "terminal"),
  ]) : el("div", { class: "pc-links" }, [
    p.reportPath ? link("Open Report", () => post({ type: "openReport" }), "file") : null,
    p.logPath ? link("Open Log", () => post({ type: "openLog" }), "output") : null,
    link("Output", () => post({ type: "showOutput" }), "terminal"),
  ]);

  return el("div", { id: "progress-card", class: "pc " + (running ? "running" : ok && !p.healthFailed ? "ok" : "failed") }, [head, now, snap, bar, rows, healthErr, err, rollbackBtn, links]);
}

function fmtBytes(n) {
  if (!n) return "0 KB";
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

// Finished preview: what a deploy would do, and a one-click way to do exactly that.
function previewCard(p) {
  const pending = p.totalOps;
  const drift = p.targets.reduce((n, t) => n + (t.driftCount || 0), 0);
  const head = el("div", { class: "pc-head" }, [
    ic("eye"),
    el("strong", {}, [pending ? "Preview ready" : "Nothing to deploy"]),
    el("span", { class: "muted pc-time" }, [fmtMs(p.finishedAt - p.startedAt)]),
    iconBtn("close", "Dismiss", () => post({ type: "dismissProgress" })),
  ]);
  const summary = el("div", { class: "pc-count muted" }, [
    pending
      ? pending + " file" + (pending === 1 ? "" : "s") + " · " + fmtBytes(p.totalBytes) + (p.estimateMs ? " · ~" + fmtMs(p.estimateMs) : "")
      : (p.compareRemote ? "Build matches the last deploy." : "Build matches FTPilot's record of the last deploy."),
  ]);
  const rows = el("ul", { class: "pc-targets" }, p.targets.map((t) => {
    const parts = [];
    if (t.newCount) parts.push(t.newCount + " new");
    if (t.changedCount) parts.push(t.changedCount + " changed");
    if (t.toRemove) parts.push(t.toRemove + " to remove");
    parts.push(t.unchanged + " same");
    return el("li", { class: "pc-built" }, [ic(t.toUpload || t.toRemove ? "diff" : "check"), el("span", { class: "n" }, [t.name]), el("span", { class: "r" }, [parts.join(", ")])]);
  }));
  const driftNote = p.compareRemote
    ? (drift
        ? notice("warn", "warning", [drift + " file(s) differ on the server from FTPilot's record (edited outside FTPilot?). A normal deploy won't resend them; Full Re-upload will."])
        : el("div", { class: "pc-stats muted" }, ["Server matches FTPilot's record."]))
    : null;
  const actions = el("div", { class: "pc-actions" }, [
    pending ? el("button", { class: "block", onclick: () => post({ type: "deployFromPreview" }) }, [ic("cloud-upload"), "Deploy These Changes"]) : null,
  ]);
  const links = el("div", { class: "pc-links" }, [
    p.compareRemote ? null : link("Compare with server", () => post({ type: "preview", targetId: p.onlyTargetId, compareRemote: true, skipBuild: true }), "remote-explorer"),
    p.reportPath ? link("Open Report", () => post({ type: "openReport" }), "file") : null,
  ]);
  return el("div", { id: "progress-card", class: "pc ok preview" }, [head, summary, rows, driftNote, actions, links]);
}

function refreshProgressCard() {
  const old = document.getElementById("progress-card");
  const neu = progressCard();
  if (old && neu) old.replaceWith(neu);
  else if (old || neu) render();
}

/* ---------- Sidebar: operations view ---------- */

function kv(icon, label, value, extra) {
  return el("div", { class: "kv" }, [ic(icon), el("span", { class: "k" }, [label]), el("span", { class: "v" }, [el("span", { class: "vt" }, value), extra || null])]);
}

function opsConnActions() {
  const busy = conn.state === "connecting";
  const connected = conn.state === "connected";
  return el("span", { class: "acts", id: "conn-acts" }, [
    iconBtn("pulse", "Test Connection", () => connect(false), busy),
    connected
      ? iconBtn("debug-disconnect", "Disconnect", () => post({ type: "disconnect" }))
      : iconBtn("plug", "Connect and stay connected", () => connect(true), busy),
    iconBtn("settings-gear", "Edit Connection", () => post({ type: "openInEditor" })),
  ]);
}

function opsConnectionBody() {
  const login = (meta && meta.login) || { hasPassword: false };
  const branch = meta && meta.branch;
  const onBranch = branch && branch === cfg.deployBranch;
  const branchExtra = !branch
    ? el("span", { class: "muted" }, ["(no git repo)"])
    : onBranch
      ? el("span", { class: "ok-icon", title: "You are on the deploy branch" }, [ic("check")])
      : el("span", { class: "warn-text", title: "You are on '" + branch + "'. Deploying will ask first." }, [ic("warning"), " on " + branch]);
  const c = CONN[conn.state];
  return el("div", { "data-conn": "ops", class: "kv-list" }, [
    kv("server", "Host", [cfg.host ? cfg.host + ":" + cfg.port : "Not set", el("span", { class: "muted" }, [" (" + (cfg.secure ? "FTPS" : "FTP") + ")"])],
      !cfg.secure
        ? el("span", { class: "warn-text", title: "Plain FTP sends your password and files unencrypted. Open the configuration to test FTPS." }, [ic("unlock"), " Unencrypted"])
        : cfg.allowInvalidCert
          ? el("span", { class: "warn-text", title: "Encrypted, but the server certificate isn't verified." }, [ic("warning"), " Cert not verified"])
          : el("span", { class: "ok-icon", title: "Encrypted (FTPS)" }, [ic("lock")])),
    kv("account", "Account", [login.user && login.hasPassword ? login.user : el("span", { class: "warn-text" }, ["Not set"])],
      iconBtn("edit", "Update Credentials", () => post({ type: "updateCredentials", account: "default" }))),
    kv("git-branch", "Branch", [cfg.deployBranch], branchExtra),
    el("div", { class: "kv conn-" + conn.state }, [ic(c.icon), el("span", { class: "k" }, ["Status"]),
      el("span", { class: "v", title: conn.text }, [conn.state === "error" ? conn.text : c.label])]),
    remoteChecks(),
  ]);
}

function opsTargetCard(t) {
  return el("div", { class: "card ops" }, [
    el("div", { class: "card-head" }, [
      el("span", { class: "title" }, [t.name || "(unnamed target)"]),
      iconBtn("eye", "Preview " + (t.name || "this target") + " (upload nothing)", () => post({ type: "preview", targetId: targetKey(t) }), isRunning(progress)),
      iconBtn("cloud-upload", "Deploy only " + (t.name || "this target"), () => { pendingTarget = t; view = "confirmDeployTarget"; render(); }, isRunning(progress)),
      iconBtn("settings-gear", "Target Settings", () => post({ type: "openInEditor", targetId: targetKey(t) })),
    ]),
    el("div", { class: "card-body kv-list" }, [
      kv("folder", "Working", [t.cwd || "."]),
      kv("package", "Output", [t.localDir || "-"]),
      kv("cloud", "Server", [t.remoteDir || "-"]),
      t.restartFile ? kv("debug-restart", "Restart", [t.restartFile]) : null,
      t.healthUrl ? kv("pulse", "Health", [t.healthUrl]) : null,
    ]),
  ]);
}

function renderOps(root) {
  if (hasDraft) {
    root.appendChild(notice("warn", "warning", ["Unsaved configuration changes"], [link("Review", () => post({ type: "openInEditor" }))]));
  }
  const st = statusNotice();
  if (st) root.appendChild(st);
  const pc = progressCard();
  if (pc) root.appendChild(pc);
  const busy = isRunning(progress);

  if (!saved) {
    root.appendChild(el("div", { class: "empty-state" }, [
      ic("cloud-upload", "big"),
      el("p", {}, ["FTPilot isn't configured for " + ((meta && meta.projectName) || "this project") + " yet."]),
      el("button", { class: "block", onclick: () => post({ type: "openInEditor" }) }, [ic("settings-gear"), "Configure FTPilot"]),
      el("p", {}, [link("Quick reference", () => post({ type: "openHelp" }), "question")]),
    ]));
    return;
  }

  root.appendChild(section("ops-conn", "Connection", [opsConnectionBody()], { actions: Array.from(opsConnActions().childNodes), actionsId: "conn-acts" }));
  root.appendChild(section("ops-targets", "Deploy Targets", saved.targets.map(opsTargetCard), {
    count: saved.targets.length,
    actions: [iconBtn("add", "Add Target", () => post({ type: "openInEditor", addTarget: true }))],
  }));
  root.appendChild(el("div", { class: "actions-row" }, [
    el("button", { class: "secondary", title: "Build and show what would change, without uploading", ...(busy ? { disabled: "disabled" } : {}), onclick: () => post({ type: "preview" }) }, [ic("eye"), "Preview"]),
    el("button", { class: "secondary", title: "Download remote files to a local .zip", ...(busy ? { disabled: "disabled" } : {}), onclick: () => { view = "confirmBackup"; render(); } }, [ic("archive"), "Backup"]),
    el("button", { class: "secondary", title: "Re-upload every file, ignoring what changed", ...(busy ? { disabled: "disabled" } : {}), onclick: () => { view = "confirmFull"; render(); } }, [ic("sync"), "Full Re-upload"]),
  ]));
  root.appendChild(el("div", { class: "footer" }, [
    el("button", { class: "block", ...(saved.targets.length && !busy ? {} : { disabled: "disabled" }), onclick: () => { view = "confirmDeploy"; render(); } }, busy ? [ic("loading", "codicon-modifier-spin"), "Deploying..."] : [ic("cloud-upload"), "Deploy All Targets"]),
  ]));
}

/* ---------- Editor tab: configuration view ---------- */

function credentialRow(account, user, hasPassword, disabledReason) {
  return el("div", { class: "cred-row" }, [
    ic("account"),
    el("span", { class: "cred-user" }, [user || el("span", { class: "muted" }, ["No username"])]),
    el("span", { class: "cred-pass" + (hasPassword ? "" : " warn-text") }, [hasPassword ? "••••••••••••" : "No password saved"]),
    el("button", { class: "secondary", ...(disabledReason ? { disabled: "disabled", title: disabledReason } : { title: "Opens a secure input box" }),
      onclick: () => post({ type: "updateCredentials", account }) }, [ic("edit"), "Update Credentials"]),
  ]);
}

function healthNote(index) {
  if (!(index in healthNotes)) return null;
  const r = healthNotes[index];
  if (!r) return el("div", { class: "detect-note" }, [ic("loading", "codicon-modifier-spin"), el("span", {}, ["Checking..."])]);
  return el("div", { class: "detect-note" + (r.ok ? "" : " bad"), role: "status" }, [
    ic(r.ok ? "pass" : "warning"),
    el("span", {}, [r.ok ? "Healthy: HTTP " + r.status + " in " + r.ms + " ms." : "Failed: " + r.error + "."]),
  ]);
}

function configTargetCard(target, index) {
  const isBackend = !!target.restartFile || target._backend;
  const hasSeparateAccount = !!target.ftpUser || target._ownLogin;
  const key = targetKey(target) || String(index);
  const collapsed = !!ui.cards[key];

  const head = el("div", { class: "card-head" }, [
    el("span", { class: "title" + (target.name ? "" : " placeholder") }, [target.name || "New target"]),
    iconBtn("trash", "Remove Target", () => { cfg.targets.splice(index, 1); render(); }),
    iconBtn(collapsed ? "chevron-down" : "chevron-up", collapsed ? "Expand" : "Collapse", () => { ui.cards[key] = !collapsed; saveUi(); render(); }),
  ]);

  // Name only re-renders the title, so typing keeps focus.
  const nameInput = labeledInput("Target Name", target.name, (v) => {
    target.name = v;
    const t = document.querySelectorAll(".card .card-head .title")[index];
    if (t) { t.textContent = v || "New target"; t.classList.toggle("placeholder", !v); }
  }, { placeholder: "Frontend (app.example.com)" });

  ensureDirsRequested("");
  const cwdField = selectOrCustom("cwd_" + index, "Working Directory", target.cwd, dirsCache[""] || [], (v) => { target.cwd = v; render(); }, {
    allowBlank: true, blankLabel: ". (project root)", placeholder: "client",
    help: "Project folder where build commands execute (e.g., ./client or .).",
    onBrowse: () => post({ type: "browse", index, field: "cwd", from: target.cwd || "" }),
  });

  const buildInput = labeledInput("Build Command", target.buildCommand, (v) => { target.buildCommand = v; }, { placeholder: "npm run build", info: "Runs in the Working Directory before upload. Leave blank if there is no build step." });
  const detectBtn = el("button", { class: "secondary", title: "Detect build command and output folder", onclick: () => post({ type: "detect", index, cwd: target.cwd || "" }) }, [ic("wand"), "Auto-detect"]);

  ensureDirsRequested(target.cwd || "");
  const prefix = target.cwd ? target.cwd + "/" : "";
  const localDirOptions = Array.from(new Set(["dist", "build", "out", "public", ...(dirsCache[target.cwd || ""] || [])])).map((n) => prefix + n);
  const localDirField = selectOrCustom("localDir_" + index, "Build Output Directory", target.localDir, localDirOptions, (v) => { target.localDir = v; }, {
    placeholder: prefix + "dist",
    help: "Folder containing compiled assets to upload (e.g., dist, build, out).",
    onBrowse: () => post({ type: "browse", index, field: "localDir", from: target.localDir || target.cwd || "" }),
  });
  const remoteDirInput = labeledInput("Server Destination Directory", target.remoteDir, (v) => { target.remoteDir = v; }, {
    placeholder: "/public_html",
    help: "Target path on the FTP server (e.g., /public_html or /api.example.com).",
  });

  const advKey = "adv_" + index;
  const hasEnv = (target.env || []).length > 0;
  const advOpen = advKey in advancedOpen ? advancedOpen[advKey] : (isBackend || !!target.ftpUser || hasEnv);
  const toggleAdv = () => { advancedOpen[advKey] = !advOpen; render(); };
  const advSwitch = el("div", { class: "switch-row", onclick: toggleAdv }, [
    el("span", { class: "switch", role: "switch", tabindex: "0", "aria-checked": String(advOpen), "aria-label": "Advanced options",
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleAdv(); } } }, []),
    "Advanced options",
  ]);

  let advanced = null;
  if (advOpen) {
    const restartRow = el("label", { class: "check-row" }, [
      el("input", { type: "checkbox", ...(isBackend ? { checked: "checked" } : {}), onchange: (e) => { target._backend = e.target.checked; if (!e.target.checked) target.restartFile = ""; render(); } }),
      "cPanel / Passenger App Restart",
      info("Only for a cPanel Setup Node.js App backend. Restarting the wrong app can cause downtime."),
    ]);
    const restartInput = isBackend
      ? labeledInput("Restart File", target.restartFile, (v) => { target.restartFile = v; }, { placeholder: "/api.example.com/tmp/restart.txt", help: "File path touched to restart Passenger (typically /tmp/restart.txt)." })
      : null;

    const ownRow = el("label", { class: "check-row" }, [
      el("input", { type: "checkbox", ...(hasSeparateAccount ? { checked: "checked" } : {}), onchange: (e) => { target._ownLogin = e.target.checked; if (!e.target.checked) target.ftpUser = ""; render(); } }),
      "Dedicated FTP Account",
      info("For a subdomain with its own FTP login. Other targets keep using the project credentials."),
    ]);
    let ownFields = null;
    if (hasSeparateAccount) {
      const hasPw = !!(meta && target.ftpUser && meta.targetLogins[target.ftpUser]);
      ownFields = el("div", {}, [
        labeledInput("FTP Username", target.ftpUser, (v) => { target.ftpUser = v; }, { placeholder: "deploy@api.example.com" }),
        credentialRow(target.ftpUser, null, hasPw, target.ftpUser ? null : "Enter the username first"),
      ]);
    }
    const expectInput = labeledInput("Health Check Must Contain", target.healthExpect, (v) => { target.healthExpect = v; }, {
      placeholder: 'e.g. "status":"ok"  (optional)',
      help: "Only pass the health check if the response contains this text.",
    });
    advanced = el("div", { class: "advanced" }, [restartRow, restartInput, ownRow, ownFields, expectInput, envVarsSection(target)]);
  }

  return el("div", { class: "card" + (collapsed ? " collapsed" : "") }, [
    head,
    el("div", { class: "card-body" }, [
      el("div", { class: "grid2" }, [nameInput, cwdField]),
      el("div", { class: "with-btn" }, [buildInput, detectBtn]),
      detectNotes[index] ? el("div", { class: "detect-note" + (detectNotes[index].ok ? "" : " bad"), role: "status" }, [ic(detectNotes[index].ok ? "pass" : "warning"), el("span", {}, [detectNotes[index].text])]) : null,
      el("div", { class: "grid2" }, [localDirField, remoteDirInput]),
      el("div", { class: "with-btn" }, [
        labeledInput("Health Check URL", target.healthUrl, (v) => { target.healthUrl = v; }, {
          placeholder: "https://example.com/  (optional)",
          info: "Fetched after every deploy (3 tries, 5 s apart, to allow a Node app to restart). Passes on HTTP 200 to 399. Leave blank to skip.",
        }),
        el("button", { class: "secondary", title: "Fetch this URL now", ...((target.healthUrl || "").trim() ? {} : { disabled: "disabled" }),
          onclick: () => post({ type: "testHealth", index, url: target.healthUrl, expect: target.healthExpect }) }, [ic("pulse"), "Test"]),
      ]),
      healthNote(index),
      advSwitch, advanced,
    ]),
  ]);
}

function envVarRow(target, envVar, envIndex) {
  const keyInput = el("input", { type: "text", value: envVar.key || "", placeholder: "KEY", "aria-label": "Variable name", oninput: (e) => { envVar.key = e.target.value; } });
  let valueCell;
  if (envVar.secret) {
    const isSet = !!(meta && (meta.envSecretsSet[targetKey(target)] || []).includes(envVar.key));
    valueCell = el("button", { class: "secondary", ...(envVar.key ? {} : { disabled: "disabled" }), title: "Opens a secure input box",
      onclick: () => post({ type: "setEnvSecret", targetId: targetKey(target), key: envVar.key }) }, [ic("key"), isSet ? "Update Value" : "Set Value"]);
  } else {
    valueCell = el("input", { type: "text", value: envVar.value || "", placeholder: "value", "aria-label": "Value", oninput: (e) => { envVar.value = e.target.value; } });
  }
  const secretToggle = el("label", { class: "secret", title: "Secret: stored in VS Code SecretStorage, never in config.json" }, [
    el("input", { type: "checkbox", ...(envVar.secret ? { checked: "checked" } : {}), onchange: (e) => { envVar.secret = e.target.checked; if (!e.target.checked) envVar.value = envVar.value || ""; render(); } }),
    ic("lock"),
  ]);
  return el("div", { class: "env-row" }, [keyInput, valueCell, secretToggle, iconBtn("close", "Remove Variable", () => { target.env.splice(envIndex, 1); render(); })]);
}

function envVarsSection(target) {
  if (!target.env) target.env = [];
  return el("div", {}, [
    el("div", { class: "env-head" }, [
      labelText("Build Environment Variables", { info: "Injected into the build command. Tick the lock to store a value in SecretStorage instead of config.json." }),
      iconBtn("add", "Add Variable", () => { target.env.push({ key: "", value: "", secret: false }); render(); }),
    ]),
    ...target.env.map((v, i) => envVarRow(target, v, i)),
  ]);
}

// Encryption guidance under the Protocol field: warn on plain FTP, help get FTPS working.
function tlsBox() {
  const kids = [];
  if (!cfg.secure) {
    kids.push(notice("warn", "warning", ["Plain FTP sends your password and files unencrypted."], [
      link("Test FTPS", () => post({ type: "testFtps", config: stripConfig(cfg) })),
    ]));
  }
  if (ftpsResult) {
    const r = ftpsResult;
    const actions = [];
    if (r.ok && !cfg.secure) actions.push(link("Switch to FTPS", () => { cfg.secure = true; cfg.allowInvalidCert = false; ftpsResult = null; render(); }));
    if (r.suggestedHost) actions.push(link("Use " + r.suggestedHost, () => { cfg.host = r.suggestedHost; ftpsResult = null; post({ type: "testFtps", config: { ...stripConfig(cfg), host: r.suggestedHost } }); render(); }));
    kids.push(notice(r.testing ? "busy" : r.ok ? "ok" : "error", r.testing ? "loading codicon-modifier-spin" : r.ok ? "pass" : "error", [r.message], actions.length ? actions : null));
  }
  // The bypass is only offered once it's actually needed (a cert problem was seen) or already on.
  if (cfg.secure && (cfg.allowInvalidCert || (ftpsResult && ftpsResult.certIssue))) {
    kids.push(el("label", { class: "check-row" }, [
      el("input", { type: "checkbox", ...(cfg.allowInvalidCert ? { checked: "checked" } : {}), onchange: (e) => { cfg.allowInvalidCert = e.target.checked; render(); } }),
      "Allow invalid or mismatched certificate",
      info("Still encrypted, but FTPilot won't verify who it's talking to, so a network attacker could intercept the connection. Prefer using the hostname the certificate is issued for."),
    ]));
    if (cfg.allowInvalidCert) kids.push(el("p", { class: "hint warn-text" }, ["Less safe: certificate checks are off for this project."]));
  }
  return kids.length ? el("div", { class: "tls-box" }, kids) : null;
}

function renderConfig(root) {
  root.appendChild(el("div", { class: "cfg-header" }, [
    el("div", {}, [el("h1", {}, ["FTPilot Configuration"]), el("p", { class: "hint" }, [(meta && meta.projectName) || ""])]),
    el("div", { class: "cfg-links" }, [
      link("Quick reference", () => post({ type: "openHelp" }), "question"),
      link("Open config.json", () => post({ type: "openConfigJson" }), "json"),
    ]),
  ]));
  if (isDirty()) {
    root.appendChild(notice("warn", "warning", ["Unsaved changes (kept until you save)"], [
      link("Discard", () => { cfg = JSON.parse(baseline); render(); }),
      link("Save", () => { view = "confirmSave"; render(); }),
    ]));
  }
  const st = statusNotice();
  if (st) root.appendChild(st);

  root.appendChild(section("connection", "Connection", [
    labeledInput("Deploy Branch", cfg.deployBranch, (v) => cfg.deployBranch = v, { placeholder: "deploy", help: "Safety guardrail: Deployments are restricted to this branch." }),
    el("div", { class: "grid31" }, [
      labeledInput("FTP Host", cfg.host, (v) => cfg.host = v, { placeholder: "ftp.yourdomain.com" }),
      labeledInput("Port", String(cfg.port || 21), (v) => cfg.port = parseInt(v, 10) || 21, { type: "number" }),
    ]),
    el("div", { class: "grid2" }, [
      labeledSelect("Protocol", String(!!cfg.secure), [{ value: "false", label: "Plain FTP" }, { value: "true", label: "FTPS (explicit TLS)" }], (v) => { cfg.secure = v === "true"; scheduleDraft(); }),
      labeledSelect("Deployment Strategy", cfg.uploadMode === "full" ? "full" : "incremental",
        [{ value: "incremental", label: "Incremental (Sync changed files only)" }, { value: "full", label: "Full (Overwrite remote files)" }],
        (v) => { cfg.uploadMode = v; scheduleDraft(); },
        { info: "Incremental also deletes remote files FTPilot uploaded earlier that no longer exist locally. Full never deletes." }),
    ]),
    tlsBox(),
  ]));

  root.appendChild(section("upload", "Upload", [
    el("div", { class: "grid2" }, [
      labeledInput("Max Parallel Connections", String(cfg.maxConnections), (v) => { cfg.maxConnections = Math.max(1, Math.min(10, parseInt(v, 10) || 1)); }, {
        type: "number",
        info: "FTPilot starts with 2 connections and adds more while it keeps getting faster, never above this. It backs off automatically if the server refuses connections. Use 1 to upload one file at a time.",
        help: "Upper limit, 1 to 10. Shared cPanel hosts usually allow 5 to 8.",
      }),
      labeledInput("Exclude Patterns", cfg.exclude.join(", "), (v) => { cfg.exclude = v.split(",").map((p) => p.trim()).filter(Boolean); }, {
        placeholder: "*.map, *.d.ts",
        info: "Comma-separated globs, relative to each Build Output Directory. A pattern without / matches at any depth. Excluded files are never uploaded or deleted: copies already on the server are left alone.",
        help: "Files never uploaded. Source maps and type declarations aren't needed to run the site.",
      }),
    ]),
    el("label", { class: "check-row" }, [
      el("input", { type: "checkbox", ...(cfg.rollbackSnapshots !== false ? { checked: "checked" } : {}), onchange: (e) => { cfg.rollbackSnapshots = e.target.checked; render(); } }),
      "Save a rollback copy before each deploy",
      info("Before uploading, FTPilot downloads the server's current copy of every file the deploy will overwrite or delete, so Roll Back can restore it. Adds download time: small in Incremental mode, roughly doubles a Full deploy. The last 3 copies are kept in .ftbdeploy/rollback/ (gitignored)."),
    ]),
  ]));

  const login = (meta && meta.login) || { hasPassword: false };
  root.appendChild(section("login", "Credentials", [
    credentialRow("default", login.user, login.hasPassword),
    el("p", { class: "hint" }, ["Stored in VS Code SecretStorage for this project folder only. Never written to config.json."]),
    connectionBox(),
  ]));

  const addTarget = () => { cfg.targets.push(blankTarget()); ui.sections.targets = false; saveUi(); render(); scrollToCard(cfg.targets.length - 1); };
  root.appendChild(section("targets", "Deploy Targets", [
    ...cfg.targets.map((t, i) => configTargetCard(t, i)),
    cfg.targets.length ? null : el("p", { class: "hint" }, ["No targets yet. Add one per domain or subdomain you deploy to."]),
    el("button", { class: "secondary block", style: "margin-top:8px", onclick: addTarget }, [ic("add"), "Add Target"]),
  ], { count: cfg.targets.length, actions: [iconBtn("add", "Add Target", addTarget)] }));

  root.appendChild(el("div", { class: "footer" }, [
    el("button", { class: "block", ...(isDirty() || !saved ? {} : { disabled: "disabled" }), onclick: () => { view = "confirmSave"; render(); } }, [ic("save"), "Save Configuration"]),
  ]));
  // Catches changes that don't come from a DOM input event (add/remove target, auto-detect, discard).
  scheduleDraft();
}

/* ---------- Confirm screens ---------- */

function summaryField(label, value) {
  return el("div", { class: "field-row" }, [el("span", {}, [label]), el("span", {}, [value || "-"])]);
}

function confirmScreen(title, bodyKids, confirmLabel, confirmIcon, onConfirm) {
  const root = document.getElementById("root");
  root.innerHTML = "";
  root.appendChild(el("div", { class: "confirm" }, [
    el("h2", {}, [title]),
    ...bodyKids,
    el("div", { class: "btns" }, [
      el("button", { class: "block", onclick: onConfirm }, [ic(confirmIcon), confirmLabel]),
      el("button", { class: "secondary block", onclick: () => { view = "form"; render(); } }, [ic("arrow-left"), "Back"]),
    ]),
  ]));
}

// Mirrors validateTargets() in config.ts so problems show before saving, not at deploy time.
function targetProblems(targets) {
  const problems = [];
  targets.forEach((t, i) => {
    const label = t.name || "Target " + (i + 1);
    const local = (t.localDir || "").trim().replace(/^[.]([/]|$)/, "").replace(/[/]+$/, "");
    if (!(t.name || "").trim()) problems.push(label + ": Target Name is empty.");
    if (!local) problems.push(label + ": Build Output Directory is empty. Pick the build folder, e.g. dist or out.");
    else if (local.split("/").includes("..")) problems.push(label + ": Build Output Directory must be inside the project.");
    if (!(t.remoteDir || "").trim()) problems.push(label + ": Server Destination Directory is empty.");
    if ((t.healthUrl || "").trim() && !/^https?:[/][/][^ /]+/i.test(t.healthUrl.trim())) problems.push(label + ": Health Check URL must start with http:// or https://.");
  });
  return problems;
}

function renderConfirmSave() {
  const problems = targetProblems(cfg.targets);
  if (problems.length) {
    const root = document.getElementById("root");
    root.innerHTML = "";
    root.appendChild(el("div", { class: "confirm" }, [
      el("h2", {}, ["Can't Save Yet"]),
      notice("error", "error", [el("div", {}, problems.map((p) => el("div", {}, [p])))]),
      el("div", { class: "btns" }, [el("button", { class: "block", onclick: () => { view = "form"; render(); } }, [ic("arrow-left"), "Back to Fix"])]),
    ]));
    return;
  }
  confirmScreen("Save Configuration", [
    el("div", { class: "summary" }, [
      summaryField("Deploy branch", cfg.deployBranch),
      summaryField("FTP host", cfg.host + ":" + cfg.port),
      summaryField("Protocol", cfg.secure ? "FTPS" : "Plain FTP"),
      summaryField("Strategy", cfg.uploadMode === "full" ? "Full" : "Incremental"),
      ...cfg.targets.map((t) => el("div", { class: "target-block" }, [
        el("strong", {}, [t.name || "(unnamed target)"]),
        summaryField("Build", t.buildCommand || "(none)"),
        summaryField("Output", t.localDir),
        summaryField("Server", t.remoteDir),
        t.restartFile ? summaryField("Restart file", t.restartFile) : null,
        t.ftpUser ? summaryField("FTP account", t.ftpUser) : null,
        t.env && t.env.length ? summaryField("Env vars", t.env.map((v) => v.key + (v.secret ? " (secret)" : "")).join(", ")) : null,
      ])),
    ]),
    cfg.targets.length ? null : el("p", { class: "hint" }, ["No targets configured. You can still save, but Deploy will have nothing to do."]),
  ], "Save", "save", () => post({ type: "saveConfig", config: stripConfig(cfg) }));
}

function renderConfirmDeploy(isFull, onlyTarget) {
  const targets = onlyTarget ? [onlyTarget] : cfg.targets;
  confirmScreen(isFull ? "Full Re-upload" : onlyTarget ? "Deploy " + (onlyTarget.name || "target") : "Deploy All Targets", [
    hasDraft ? notice("warn", "warning", ["The configuration tab has unsaved changes. Deploy uses the saved config."]) : null,
    isFull ? notice("warn", "warning", ["Re-uploads every file in every target, even unchanged ones."]) : null,
    el("div", { class: "summary" }, [
      summaryField("Branch", cfg.deployBranch),
      summaryField("Host", cfg.host + ":" + cfg.port),
      ...targets.map((t) => el("div", { class: "target-block" }, [summaryField(t.name || "(unnamed)", (t.localDir || "?") + " > " + (t.remoteDir || "?"))])),
    ]),
  ], isFull ? "Re-upload Everything" : "Deploy", isFull ? "sync" : "cloud-upload", () => {
    if (onlyTarget) post({ type: "deployTarget", id: targetKey(onlyTarget), name: onlyTarget.name });
    else post({ type: isFull ? "fullRedeploy" : "deploy" });
    view = "form"; render();
  });
}

function renderConfirmRollback() {
  confirmScreen("Roll Back Deploy", [
    notice("warn", "warning", ["This changes the live server."]),
    el("p", { class: "hint" }, ["Puts back the server files this deploy overwrote or deleted, deletes the files it created, restarts Node (Passenger) apps, and runs health checks. Your local build, config and git history are not touched. Database changes are not undone."]),
  ], "Roll Back", "discard", () => { post({ type: "rollback", id: pendingRollback }); pendingRollback = null; view = "form"; render(); });
}

function renderConfirmBackup() {
  confirmScreen("Backup Server", [
    el("p", { class: "hint" }, ["Downloads every target's remote files into a .zip under .ftbdeploy/backups/. Nothing on the server changes."]),
    el("div", { class: "summary" }, cfg.targets.map((t) => el("div", { class: "target-block" }, [summaryField(t.name || "(unnamed)", t.remoteDir || "?")]))),
  ], "Back Up Now", "archive", () => { post({ type: "backup" }); view = "form"; render(); });
}

function render() {
  const root = document.getElementById("root");
  if (!workspaceOpen) {
    root.innerHTML = "";
    root.appendChild(el("p", { class: "empty-state" }, ["Open a project folder to use FTPilot."]));
    return;
  }
  if (!cfg) cfg = defaultConfig();
  if (view === "confirmSave") return renderConfirmSave();
  if (view === "confirmBackup") return renderConfirmBackup();
  if (view === "confirmDeploy") return renderConfirmDeploy(false);
  if (view === "confirmFull") return renderConfirmDeploy(true);
  if (view === "confirmDeployTarget" && pendingTarget) return renderConfirmDeploy(false, pendingTarget);
  if (view === "confirmRollback" && pendingRollback) return renderConfirmRollback();
  root.innerHTML = "";
  if (MODE === "config") renderConfig(root); else renderOps(root);
}

post({ type: "ready" });
`;
