import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { DeployConfig, configExists, loadConfig, saveConfig } from "./config";
import { setCredentials } from "./secrets";
import { detectBuildCommand, detectOutputDir } from "./detect";

type TargetCreds = Record<string, { user: string; password: string }>;

type InMsg =
  | { type: "ready" }
  | {
      type: "saveConfig";
      config: DeployConfig;
      defaultUser?: string;
      defaultPassword?: string;
      targetCreds?: TargetCreds;
    }
  | { type: "deploy" }
  | { type: "fullRedeploy" }
  | { type: "openConfigJson" }
  | { type: "detect"; index: number; cwd: string }
  | { type: "listDirs"; forPath: string };

type OutMsg =
  | { type: "init"; workspaceOpen: boolean; config?: DeployConfig }
  | { type: "detected"; index: number; buildCommand?: string; localDir?: string }
  | { type: "dirs"; forPath: string; dirs: string[] }
  | { type: "saved" }
  | { type: "status"; text: string; kind: "idle" | "busy" | "ok" | "error" }
  | { type: "error"; message: string };

const IGNORE_DIR_NAMES = new Set(["node_modules", ".git", ".vscode", ".ftbdeploy"]);

export class FtpilotPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "ftpilotPanel";
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderHtml();
    webviewView.webview.onDidReceiveMessage((msg: InMsg) => {
      void this.handleMessage(msg);
    });
  }

  refresh(): void {
    this.postInit();
  }

  reportStatus(text: string, kind: "idle" | "busy" | "ok" | "error"): void {
    this.post({ type: "status", text, kind });
  }

  private post(msg: OutMsg): void {
    void this.view?.webview.postMessage(msg);
  }

  private postInit(): void {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.post({ type: "init", workspaceOpen: false });
      return;
    }
    if (!configExists(root)) {
      this.post({ type: "init", workspaceOpen: true });
      return;
    }
    try {
      const config = loadConfig(root);
      this.post({ type: "init", workspaceOpen: true, config });
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
      this.post({ type: "init", workspaceOpen: true });
    }
  }

  private async handleMessage(msg: InMsg): Promise<void> {
    const root = this.getWorkspaceRoot();

    switch (msg.type) {
      case "ready":
        this.postInit();
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
        this.post({ type: "dirs", forPath: msg.forPath, dirs });
        return;
      }

      case "detect": {
        if (!root) return;
        const absCwd = msg.cwd ? path.join(root, msg.cwd) : root;
        const buildCommand = detectBuildCommand(absCwd);
        const outDir = detectOutputDir(absCwd);
        const localDir = outDir ? (msg.cwd ? `${msg.cwd}/${outDir}` : outDir) : undefined;
        this.post({ type: "detected", index: msg.index, buildCommand, localDir });
        return;
      }

      case "saveConfig": {
        if (!root) return;
        try {
          saveConfig(root, msg.config);
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
          this.post({ type: "saved" });
          this.postInit();
        } catch (err) {
          this.post({ type: "error", message: (err as Error).message });
        }
        return;
      }

      case "deploy":
        this.reportStatus("Deploying...", "busy");
        await vscode.commands.executeCommand("ftpilot.deploy");
        this.postInit();
        return;

      case "fullRedeploy":
        this.reportStatus("Force re-uploading everything...", "busy");
        await vscode.commands.executeCommand("ftpilot.fullRedeploy");
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

function renderHtml(): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style>
</head>
<body>
<div id="root">Loading…</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 4px 16px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.75; margin: 16px 0 8px; }
  section:first-of-type h3 { margin-top: 8px; }
  label { display: block; font-size: 12px; margin: 8px 0 3px; }
  input[type=text], input[type=number], input[type=password], select {
    width: 100%; box-sizing: border-box; padding: 4px 6px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  select { margin-bottom: 4px; }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .checkbox-row { display: flex; align-items: center; gap: 6px; margin: 10px 0 2px; }
  .checkbox-row input { width: auto; }
  .checkbox-row label { margin: 0; font-size: 12px; }
  button { width: 100%; padding: 6px 8px; margin-top: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, #8888)); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.15)); }
  button.link { background: none; color: var(--vscode-textLink-foreground); text-align: left; padding: 4px 0; width: auto; }
  button.link:hover { text-decoration: underline; background: none; }
  .target { border: 1px solid var(--vscode-panel-border, #8883); border-radius: 4px; padding: 8px; margin: 8px 0; }
  .target-head { display: flex; align-items: center; justify-content: space-between; }
  .target-head strong { font-size: 12px; }
  .remove-btn { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; width: auto; padding: 2px 4px; margin: 0; font-size: 12px; }
  .hint { font-size: 11px; opacity: 0.65; margin: 2px 0 0; }
  .status { font-size: 12px; padding: 6px 8px; border-radius: 3px; margin-bottom: 10px; }
  .status.busy { background: var(--vscode-inputValidation-infoBackground, #2244); color: var(--vscode-foreground); }
  .status.ok { background: var(--vscode-inputValidation-infoBackground, #2242); color: var(--vscode-foreground); }
  .status.error { background: var(--vscode-inputValidation-errorBackground, #4222); color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground)); }
  .empty { font-size: 12px; opacity: 0.8; line-height: 1.5; }
  .inline-btn { width: auto; display: inline-block; margin-left: 6px; padding: 2px 8px; font-size: 11px; white-space: nowrap; }
  .detect-row { display: flex; align-items: flex-end; gap: 6px; }
  .detect-row > div { flex: 1; }
  .summary { border: 1px solid var(--vscode-panel-border, #8883); border-radius: 4px; padding: 10px; margin: 8px 0; font-size: 12px; line-height: 1.7; }
  .summary .field { display: flex; justify-content: space-between; gap: 8px; }
  .summary .field span:first-child { opacity: 0.7; }
  .summary .target-block { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border, #8883); }
  .summary .target-block:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .warn-banner { font-size: 12px; background: var(--vscode-inputValidation-warningBackground, #5522); color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); padding: 6px 8px; border-radius: 3px; margin-bottom: 8px; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
function post(msg) { vscode.postMessage(msg); }

let workspaceOpen = false;
let cfg = null;
let defaultCredsOpen = false;
let defaultUser = "", defaultPassword = "";
let targetCredsOpen = {};
let targetCreds = {};
let lastStatus = null;
let view = "form"; // "form" | "confirmSave" | "confirmDeploy" | "confirmFull"
let customFields = {};
let dirsCache = {};
let requestedPaths = new Set();

function defaultConfig() {
  return { deployBranch: "deploy", host: "", port: 21, secure: false, uploadMode: "incremental", targets: [] };
}
function blankTarget() {
  return { name: "", buildCommand: "", cwd: "", localDir: "", remoteDir: "" };
}

function ensureDirsRequested(forPath) {
  const key = forPath || "";
  if (!(key in dirsCache) && !requestedPaths.has(key)) {
    requestedPaths.add(key);
    post({ type: "listDirs", forPath: key });
  }
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    workspaceOpen = msg.workspaceOpen;
    cfg = msg.config || defaultConfig();
    view = "form";
    render();
  } else if (msg.type === "detected") {
    const t = cfg.targets[msg.index];
    if (!t) return;
    if (msg.buildCommand) t.buildCommand = msg.buildCommand;
    if (msg.localDir) { t.localDir = msg.localDir; customFields["localDir_" + msg.index] = false; }
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
    lastStatus = { text: "Saved.", kind: "ok" };
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
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function labeledInput(labelText, value, onInput, opts) {
  opts = opts || {};
  const input = el("input", {
    type: opts.type || "text",
    value: value || "",
    placeholder: opts.placeholder || "",
    oninput: (e) => onInput(e.target.value),
  });
  return el("label", {}, [labelText, input]);
}

// A <select> of real, on-disk options, falling back to a free-text box when
// the user picks "Custom" or the current value isn't one of the options.
function selectOrCustom(key, labelText, value, options, onChange, opts) {
  opts = opts || {};
  const inOptions = options.includes(value) || (opts.allowBlank && !value);
  const isCustom = !!customFields[key] || (!!value && !inOptions);
  const selectValue = isCustom ? "__custom__" : (value || "");

  const optionEls = [];
  if (opts.allowBlank) {
    optionEls.push(el("option", { value: "", ...(selectValue === "" ? { selected: "selected" } : {}) }, [opts.blankLabel || "(project root)"]));
  }
  for (const o of options) {
    optionEls.push(el("option", { value: o, ...(selectValue === o ? { selected: "selected" } : {}) }, [o]));
  }
  optionEls.push(el("option", { value: "__custom__", ...(selectValue === "__custom__" ? { selected: "selected" } : {}) }, ["Custom … type manually"]));

  const selectEl = el("select", {
    onchange: (e) => {
      const v = e.target.value;
      if (v === "__custom__") { customFields[key] = true; }
      else { customFields[key] = false; onChange(v); }
      render();
    },
  }, optionEls);

  const kids = [labelText, selectEl];
  if (isCustom) {
    kids.push(el("input", { type: "text", value: value || "", placeholder: opts.placeholder || "", oninput: (e) => onChange(e.target.value) }));
  }
  return el("label", {}, kids);
}

function targetCard(target, index) {
  const acct = "target_" + index;
  const isBackend = !!target.restartFile || target._backend;
  const hasSeparateAccount = !!target.ftpUser || targetCredsOpen[acct];

  const head = el("div", { class: "target-head" }, [
    el("strong", {}, [target.name || "New target"]),
    el("button", { class: "remove-btn", onclick: () => { cfg.targets.splice(index, 1); render(); } }, ["✕ remove"]),
  ]);

  const nameInput = labeledInput("Name (mention the domain)", target.name, (v) => { target.name = v; render(); }, { placeholder: "Frontend (app.example.com)" });

  ensureDirsRequested("");
  const cwdOptions = dirsCache[""] || [];
  const cwdField = selectOrCustom("cwd_" + index, "Local folder for this target", target.cwd, cwdOptions, (v) => { target.cwd = v; render(); }, { allowBlank: true, blankLabel: "(project root)", placeholder: "client" });

  const detectBtn = el("button", { class: "secondary inline-btn", onclick: () => post({ type: "detect", index, cwd: target.cwd || "" }) }, ["Auto-detect"]);

  const buildInput = labeledInput("Build command (blank = no build step)", target.buildCommand, (v) => { target.buildCommand = v; }, { placeholder: "npm run build" });

  ensureDirsRequested(target.cwd || "");
  const subDirs = dirsCache[target.cwd || ""] || [];
  const prefix = target.cwd ? target.cwd + "/" : "";
  const presetNames = ["dist", "build", "out", "public"];
  const localDirOptions = Array.from(new Set([...presetNames, ...subDirs])).map((n) => prefix + n);
  const localDirField = selectOrCustom("localDir_" + index, "Local output folder to upload", target.localDir, localDirOptions, (v) => { target.localDir = v; }, { placeholder: prefix + "build" });

  const remoteDirInput = labeledInput("Remote folder (full FTP path)", target.remoteDir, (v) => { target.remoteDir = v; }, { placeholder: "/public_html or /api.example.com" });

  const backendCheckbox = el("input", {
    type: "checkbox",
    ...(isBackend ? { checked: "checked" } : {}),
    onchange: (e) => { target._backend = e.target.checked; if (!e.target.checked) target.restartFile = ""; render(); },
  });
  const backendRow = el("div", { class: "checkbox-row" }, [backendCheckbox, el("label", {}, ["cPanel Node.js app (Passenger) — restart after upload"])]);

  const restartInput = isBackend
    ? labeledInput("Restart file (full FTP path)", target.restartFile, (v) => { target.restartFile = v; }, { placeholder: "/api.example.com/tmp/restart.txt" })
    : null;

  const sepCheckbox = el("input", {
    type: "checkbox",
    ...(hasSeparateAccount ? { checked: "checked" } : {}),
    onchange: (e) => { targetCredsOpen[acct] = e.target.checked; if (!e.target.checked) target.ftpUser = ""; render(); },
  });
  const sepRow = el("div", { class: "checkbox-row" }, [sepCheckbox, el("label", {}, ["This domain has its own separate FTP login"])]);

  let sepFields = null;
  if (hasSeparateAccount) {
    const userInput = labeledInput("FTP username for this target", target.ftpUser, (v) => { target.ftpUser = v; });
    const cred = targetCreds[acct] || { user: "", password: "" };
    const passInput = labeledInput("FTP password (blank = keep existing)", cred.password, (v) => {
      cred.password = v; cred.user = target.ftpUser || cred.user; targetCreds[acct] = cred;
    }, { type: "password" });
    sepFields = el("div", {}, [userInput, passInput]);
  }

  return el("div", { class: "target" }, [
    head, nameInput, cwdField,
    el("div", { class: "detect-row" }, [el("div", {}, [buildInput]), detectBtn]),
    localDirField, remoteDirInput,
    backendRow, restartInput,
    sepRow, sepFields,
  ]);
}

function summaryField(label, value) {
  return el("div", { class: "field" }, [el("span", {}, [label]), el("span", {}, [value || "—"])]);
}

function targetSummaryBlock(t) {
  const fields = [
    summaryField("Name", t.name),
    summaryField("Build", t.buildCommand || "(none)"),
    summaryField("Local", (t.cwd ? t.cwd + "/" : "") === (t.localDir || "").slice(0, (t.cwd || "").length + 1) ? t.localDir : t.localDir),
    summaryField("Remote", t.remoteDir),
  ];
  if (t.restartFile) fields.push(summaryField("Restart file", t.restartFile));
  if (t.ftpUser) fields.push(summaryField("FTP account", t.ftpUser));
  return el("div", { class: "target-block" }, [el("div", {}, [el("strong", {}, [t.name || "(unnamed target)"])]), ...fields]);
}

function renderConfirmSave() {
  const root = document.getElementById("root");
  root.innerHTML = "";
  root.appendChild(el("h3", {}, ["Confirm & Save"]));
  const box = el("div", { class: "summary" }, [
    summaryField("Deploy branch", cfg.deployBranch),
    summaryField("FTP host", cfg.host + ":" + cfg.port),
    summaryField("Protocol", cfg.secure ? "FTPS" : "Plain FTP"),
    summaryField("Upload mode", cfg.uploadMode),
    summaryField("Default credentials", defaultUser && defaultPassword ? "will be updated (" + defaultUser + ")" : "unchanged"),
    ...cfg.targets.map(targetSummaryBlock),
  ]);
  root.appendChild(box);
  if (!cfg.targets.length) root.appendChild(el("p", { class: "empty" }, ["No targets configured — you can still save, but Deploy will have nothing to do."]));
  root.appendChild(el("button", { onclick: () => { post({ type: "saveConfig", config: stripConfig(cfg), defaultUser, defaultPassword, targetCreds }); defaultPassword = ""; for (const k in targetCreds) targetCreds[k].password = ""; } }, ["✓ Confirm & Save"]));
  root.appendChild(el("button", { class: "secondary", onclick: () => { view = "form"; render(); } }, ["← Back to Edit"]));
}

function renderConfirmDeploy(isFull) {
  const root = document.getElementById("root");
  root.innerHTML = "";
  root.appendChild(el("h3", {}, [isFull ? "Confirm Full Re-upload" : "Confirm Deploy"]));
  if (isFull) {
    root.appendChild(el("div", { class: "warn-banner" }, ["This re-uploads every file in every target below, even ones that haven't changed."]));
  }
  const box = el("div", { class: "summary" }, [
    summaryField("Branch", cfg.deployBranch),
    summaryField("Host", cfg.host + ":" + cfg.port),
    ...cfg.targets.map((t) => el("div", { class: "target-block" }, [summaryField(t.name || "(unnamed)", (t.localDir || "?") + " → " + (t.remoteDir || "?"))])),
  ]);
  root.appendChild(box);
  root.appendChild(el("button", { onclick: () => { post({ type: isFull ? "fullRedeploy" : "deploy" }); view = "form"; render(); } }, [isFull ? "✓ Confirm Full Re-upload" : "✓ Confirm Deploy"]));
  root.appendChild(el("button", { class: "secondary", onclick: () => { view = "form"; render(); } }, ["Cancel"]));
}

function stripConfig(c) {
  const targets = c.targets.map((t) => {
    const clean = { name: t.name, localDir: t.localDir, remoteDir: t.remoteDir };
    if (t.buildCommand) clean.buildCommand = t.buildCommand;
    if (t.cwd) clean.cwd = t.cwd;
    if (t.restartFile) clean.restartFile = t.restartFile;
    if (t.ftpUser) clean.ftpUser = t.ftpUser;
    return clean;
  });
  return { deployBranch: c.deployBranch, host: c.host, port: c.port, secure: c.secure, uploadMode: c.uploadMode, targets };
}

function render() {
  if (!workspaceOpen) {
    const root = document.getElementById("root");
    root.innerHTML = "";
    root.appendChild(el("p", { class: "empty" }, ["Open a project folder to configure FTPilot."]));
    return;
  }
  if (!cfg) cfg = defaultConfig();

  if (view === "confirmSave") return renderConfirmSave();
  if (view === "confirmDeploy") return renderConfirmDeploy(false);
  if (view === "confirmFull") return renderConfirmDeploy(true);

  const root = document.getElementById("root");
  root.innerHTML = "";

  if (lastStatus) {
    root.appendChild(el("div", { class: "status " + lastStatus.kind }, [lastStatus.text]));
  }

  const branchInput = labeledInput("Git branch to deploy from", cfg.deployBranch, (v) => cfg.deployBranch = v, { placeholder: "deploy" });

  const hostInput = labeledInput("FTP host", cfg.host, (v) => cfg.host = v, { placeholder: "ftp.yourdomain.com" });
  const portInput = labeledInput("Port", String(cfg.port || 21), (v) => cfg.port = parseInt(v, 10) || 21, { type: "number" });

  const protoSelect = el("select", { onchange: (e) => cfg.secure = e.target.value === "true" }, [
    el("option", { value: "false", ...(cfg.secure ? {} : { selected: "selected" }) }, ["Plain FTP"]),
    el("option", { value: "true", ...(cfg.secure ? { selected: "selected" } : {}) }, ["FTPS (explicit TLS)"]),
  ]);
  const protoLabel = el("label", {}, ["Protocol", protoSelect]);

  const modeSelect = el("select", { onchange: (e) => cfg.uploadMode = e.target.value }, [
    el("option", { value: "incremental", ...(cfg.uploadMode === "full" ? {} : { selected: "selected" }) }, ["Incremental (only changed files)"]),
    el("option", { value: "full", ...(cfg.uploadMode === "full" ? { selected: "selected" } : {}) }, ["Full (re-upload everything)"]),
  ]);
  const modeLabel = el("label", {}, ["Upload mode", modeSelect]);

  const connectionSection = el("section", {}, [
    el("h3", {}, ["Connection"]),
    branchInput,
    el("div", { class: "row2" }, [hostInput, portInput]),
    el("div", { class: "row2" }, [protoLabel, modeLabel]),
  ]);

  const credsToggle = el("input", { type: "checkbox", ...(defaultCredsOpen ? { checked: "checked" } : {}), onchange: (e) => { defaultCredsOpen = e.target.checked; render(); } });
  const credsRow = el("div", { class: "checkbox-row" }, [credsToggle, el("label", {}, ["Set / change default FTP username & password"])]);
  let credsFields = null;
  if (defaultCredsOpen) {
    const userInput = labeledInput("FTP username", defaultUser, (v) => defaultUser = v);
    const passInput = labeledInput("FTP password", defaultPassword, (v) => defaultPassword = v, { type: "password" });
    credsFields = el("div", {}, [userInput, passInput]);
  }
  const credsSection = el("section", {}, [el("h3", {}, ["Default FTP Credentials"]), credsRow, credsFields]);

  const targetsSection = el("section", {}, [
    el("h3", {}, ["Deploy Targets"]),
    ...cfg.targets.map((t, i) => targetCard(t, i)),
    el("button", { class: "secondary", onclick: () => { cfg.targets.push(blankTarget()); render(); } }, ["+ Add target"]),
  ]);

  const saveBtn = el("button", { onclick: () => { view = "confirmSave"; render(); } }, ["Save Config…"]);
  const deployBtn = el("button", { onclick: () => { view = "confirmDeploy"; render(); } }, ["☁ Deploy / Redeploy…"]);
  const fullBtn = el("button", { class: "secondary", onclick: () => { view = "confirmFull"; render(); } }, ["Force Full Re-upload…"]);
  const jsonBtn = el("button", { class: "link", onclick: () => post({ type: "openConfigJson" }) }, ["Open config.json"]);

  root.appendChild(connectionSection);
  root.appendChild(credsSection);
  root.appendChild(targetsSection);
  root.appendChild(saveBtn);
  root.appendChild(deployBtn);
  root.appendChild(fullBtn);
  root.appendChild(jsonBtn);
}

post({ type: "ready" });
`;
