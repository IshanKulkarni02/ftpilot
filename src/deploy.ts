import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { loadConfig, manifestPath, updateTargetLocalDir, DeployTarget } from "./config";
import { getCredentials } from "./secrets";
import { getCurrentBranch, checkoutBranch, getShortCommit } from "./git";
import { runBuild, validateEnvSecrets, BuildError, LogSink } from "./build";
import { loadManifest, saveManifest, hashTarget, diffTarget, walkDir, Manifest } from "./manifest";
import { DeployState, DeployTracker } from "./progress";
import { writeReport, writeLog, formatMs } from "./report";
import { snapshotTopLevelDirs, diffTopLevelDirs } from "./detect";
import * as ftpClient from "./ftpClient";

export interface DeployOptions {
  /** Force full re-upload of every target, ignoring uploadMode / manifest. */
  forceFull?: boolean;
  /** Build + upload only this target (matched by id, falling back to name). */
  onlyTargetId?: string;
  /** Live progress snapshots (throttled) for the panel. */
  onProgress?: (state: DeployState) => void;
}

/** One deploy at a time: two concurrent runs would race on the manifest and the FTP server. */
let running = false;

export interface DeployResult {
  ok: boolean;
  message: string;
}

export async function runDeploy(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  statusBar: vscode.StatusBarItem,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
    return { ok: false, message: "No folder open." };
  }
  const workspaceRoot = folders[0].uri.fsPath;
  if (running) {
    void vscode.window.showWarningMessage("FTPilot: a deploy is already running.");
    return { ok: false, message: "Already running." };
  }
  running = true;
  try {
    return await runDeployInner(context, output, statusBar, options, workspaceRoot);
  } finally {
    running = false;
  }
}

async function runDeployInner(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  statusBar: vscode.StatusBarItem,
  options: DeployOptions,
  workspaceRoot: string
): Promise<DeployResult> {
  let config;
  try {
    config = loadConfig(workspaceRoot);
    if (options.onlyTargetId) {
      config.targets = config.targets.filter((t) => (t.id ?? t.name) === options.onlyTargetId);
      if (config.targets.length === 0) throw new Error("That target no longer exists in .ftbdeploy/config.json. Save the config first.");
    }
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      (err as Error).message,
      "Open FTPilot Panel"
    );
    if (choice === "Open FTPilot Panel") {
      await vscode.commands.executeCommand("ftpilotPanel.focus");
    }
    return { ok: false, message: (err as Error).message };
  }

  try {
    const branch = await getCurrentBranch(workspaceRoot);
    if (branch !== config.deployBranch) {
      const choice = await vscode.window.showWarningMessage(
        `FTPilot deploys from branch '${config.deployBranch}', but you're currently on '${branch}'.`,
        { modal: true },
        "Deploy This Branch",
        "Switch & Deploy"
      );
      if (choice === "Switch & Deploy") {
        output.show(true);
        output.appendLine(`\nSwitching to branch '${config.deployBranch}'...`);
        try {
          await checkoutBranch(workspaceRoot, config.deployBranch);
        } catch (err) {
          const message = `Couldn't switch to '${config.deployBranch}': ${(err as Error).message}`;
          void vscode.window.showErrorMessage(`FTPilot: ${message}`);
          return { ok: false, message };
        }
      } else if (choice !== "Deploy This Branch") {
        return { ok: false, message: "Cancelled (not on deploy branch)." };
      }
    }
  } catch {
    // not a git repo, or git not available — skip the branch check silently
  }

  const kind: DeployState["kind"] = options.onlyTargetId ? "target" : options.forceFull ? "full" : "deploy";
  const useFull = !!options.forceFull || config.uploadMode === "full";
  const tracker = new DeployTracker(
    {
      kind,
      phase: "preparing",
      startedAt: Date.now(),
      project: path.basename(workspaceRoot),
      branch: await getCurrentBranch(workspaceRoot).catch(() => undefined),
      commit: await getShortCommit(workspaceRoot),
      host: `${config.host}:${config.port} (${config.secure ? "FTPS" : "FTP"})`,
      strategy: useFull ? "full" : "incremental",
      targets: config.targets.map((t) => ({
        name: t.name, buildCommand: t.buildCommand, localDir: t.localDir, remoteDir: t.remoteDir,
        status: "pending", toUpload: 0, uploaded: 0, toRemove: 0, removed: 0, unchanged: 0,
        uploadedFiles: [], removedFiles: [],
      })),
      totalOps: 0,
      doneOps: 0,
    },
    options.onProgress
  );
  const s = tracker.state;

  // Tee everything written to the Output channel into a per-run log file.
  const logLines: string[] = [];
  const log: LogSink = {
    append: (v: string) => { output.append(v); logLines.push(v); },
    appendLine: (v: string) => { output.appendLine(v); logLines.push(v + "\n"); },
  };

  output.clear();
  log.appendLine(`FTPilot ${kind} — ${new Date(s.startedAt).toLocaleString()} — ${s.project} @ ${s.branch ?? "?"}${s.commit ? ` (${s.commit})` : ""}`);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "FTPilot" },
    async (vsProgress) => {
      let lastPct = 0;
      const say = (message: string) => {
        const pct = s.totalOps ? Math.floor((s.doneOps / s.totalOps) * 100) : 0;
        vsProgress.report({ message, increment: Math.max(0, pct - lastPct) });
        lastPct = Math.max(lastPct, pct);
        statusBar.text = `$(sync~spin) FTPilot: ${message}`;
      };

      let client: Awaited<ReturnType<typeof ftpClient.connect>> | undefined;
      let currentAccount = "";

      try {
        // 1. Fail fast on any missing secret env var before building anything.
        say("Checking settings…");
        await validateEnvSecrets(context, workspaceRoot, config.targets);

        // 2. Build each target. If the output folder is missing afterwards, fall back to
        // whichever folder the build just created/touched and persist the fix.
        tracker.update((st) => { st.phase = "building"; });
        for (const target of config.targets) {
          const tp = tracker.target(target.name)!;
          tracker.update((st) => { st.currentTarget = target.name; st.lastLine = undefined; tp.status = "building"; });
          say(`Building ${target.name}…`);
          log.appendLine(`\n=== Building: ${target.name} ===`);
          const buildCwd = target.cwd ? path.join(workspaceRoot, target.cwd) : workspaceRoot;
          const before = target.buildCommand ? snapshotTopLevelDirs(buildCwd) : undefined;
          const t0 = Date.now();

          await runBuild(context, target, workspaceRoot, log, (line) => tracker.update((st) => { st.lastLine = line; }));

          const localDir = path.join(workspaceRoot, target.localDir);
          if (target.buildCommand && !fs.existsSync(localDir)) {
            const after = snapshotTopLevelDirs(buildCwd);
            const [guess] = diffTopLevelDirs(before ?? {}, after);
            if (!guess) {
              throw new Error(
                `[${target.name}] build finished but output folder '${target.localDir}' doesn't exist, and no changed folder could be detected in '${target.cwd ?? "."}'.`
              );
            }
            const correctedLocalDir = target.cwd ? `${target.cwd}/${guess}` : guess;
            log.appendLine(
              `[${target.name}] configured output folder '${target.localDir}' not found — detected '${guess}' was created by the build instead. Using it and updating .ftbdeploy/config.json.`
            );
            target.localDir = correctedLocalDir;
            tp.localDir = correctedLocalDir;
            updateTargetLocalDir(workspaceRoot, target.name, correctedLocalDir);
          }
          tracker.update(() => { tp.buildMs = Date.now() - t0; tp.status = "built"; });
        }

        // 3. Hash build output and work out exactly what each target will upload/remove,
        // so the progress bar has a real total before the first byte goes out.
        tracker.update((st) => { st.phase = "comparing"; st.currentTarget = undefined; st.lastLine = undefined; });
        say("Comparing files…");
        const newManifest: Manifest = {};
        for (const target of config.targets) {
          Object.assign(newManifest, hashTarget(target.name, path.join(workspaceRoot, target.localDir)));
        }
        const mPath = manifestPath(workspaceRoot);
        const oldManifest = options.forceFull ? {} : loadManifest(mPath);
        const plans = config.targets.map((target) => {
          const localDir = path.join(workspaceRoot, target.localDir);
          const all = walkDir(localDir);
          const diff = useFull ? { toUpload: all, toRemove: [] as string[] } : diffTarget(target.name, oldManifest, newManifest);
          const tp = tracker.target(target.name)!;
          tp.toUpload = diff.toUpload.length;
          tp.toRemove = diff.toRemove.length;
          tp.unchanged = all.length - diff.toUpload.length;
          return { target, localDir, tp, ...diff };
        });
        tracker.update((st) => { st.totalOps = plans.reduce((n, p) => n + p.toUpload.length + p.toRemove.length, 0); });

        // 4. Upload (connecting/reconnecting per FTP account as needed)
        tracker.update((st) => { st.phase = "uploading"; });
        for (const { target, localDir, tp, toUpload, toRemove } of plans) {
          const account = target.ftpUser ?? "default";
          const creds = await getCredentials(context, workspaceRoot, account);
          if (!creds) {
            throw new Error(
              account === "default"
                ? "No FTP login saved for this project. Open the FTPilot configuration and use Update Credentials."
                : `No password saved for FTP account '${account}'. Open the FTPilot configuration and use Update Credentials on that target.`
            );
          }
          tracker.update((st) => { st.currentTarget = target.name; st.currentFile = undefined; tp.status = "uploading"; });

          if (!client || account !== currentAccount) {
            client?.close();
            say(`Connecting to ${config.host}…`);
            log.appendLine(`\nConnecting to ${config.host}:${config.port} as ${creds.user}...`);
            client = await ftpClient.connect(config, creds);
            currentAccount = account;
          }

          log.appendLine(`\n=== Uploading: ${target.name} -> ${target.remoteDir} (${useFull ? "full" : "incremental"}) ===`);
          const t0 = Date.now();
          if (!toUpload.length && !toRemove.length) say(`${target.name}: nothing changed`);
          await ftpClient.uploadFiles(client, localDir, target.remoteDir, toUpload, (relPath) => {
            log.appendLine(`  + ${relPath}`);
            tracker.update((st) => { tp.uploaded++; tp.uploadedFiles.push(relPath); st.doneOps++; st.currentFile = relPath; });
            say(`Uploading ${target.name}: ${tp.uploaded} / ${tp.toUpload}`);
          });
          for (const relPath of toRemove) {
            log.appendLine(`  - ${relPath}`);
            await ftpClient.removeOne(client, target.remoteDir, relPath);
            tracker.update((st) => { tp.removed++; tp.removedFiles.push(relPath); st.doneOps++; st.currentFile = relPath; });
            say(`Cleaning up ${target.name}: ${tp.removed} / ${tp.toRemove}`);
          }
          log.appendLine(`Uploaded ${tp.uploaded}, removed ${tp.removed}, unchanged ${tp.unchanged}.`);

          const targetChanged = useFull || toUpload.length > 0 || toRemove.length > 0;
          if (target.restartFile && targetChanged) {
            say(`Restarting ${target.name}…`);
            log.appendLine(`Restarting app: touching ${target.restartFile}`);
            await ftpClient.touchRestartFile(client, target.restartFile);
            tp.restarted = true;
          }
          tracker.update(() => { tp.uploadMs = Date.now() - t0; tp.status = "done"; });
        }

        // A single-target deploy must keep the other targets' manifest entries, or their
        // next incremental deploy would think every file is new.
        if (options.onlyTargetId) {
          const prefixes = config.targets.map((t) => `${t.name}/`);
          for (const [key, hash] of Object.entries(loadManifest(mPath))) {
            if (!prefixes.some((p) => key.startsWith(p))) newManifest[key] = hash;
          }
        }
        saveManifest(mPath, newManifest);

        tracker.update((st) => { st.phase = "done"; st.finishedAt = Date.now(); st.currentTarget = undefined; st.currentFile = undefined; });
        const up = s.targets.reduce((n, t) => n + t.uploaded, 0);
        const rm = s.targets.reduce((n, t) => n + t.removed, 0);
        const message = `Done in ${formatMs(s.finishedAt! - s.startedAt)} (${up} uploaded, ${rm} removed).`;
        log.appendLine(`\n${message}`);
        finish(workspaceRoot, tracker, logLines);
        void vscode.window.showInformationMessage(`FTPilot: ${message}`, "Open Report").then((c) => {
          if (c) void vscode.env.openExternal(vscode.Uri.file(s.reportPath!));
        });
        return { ok: true, message };
      } catch (err) {
        const message = (err as Error).message;
        const detail = err instanceof BuildError ? err.detail : undefined;
        log.appendLine(`\nERROR: ${message}`);
        // Build failures already have their output above; a stack trace only helps for FTPilot/FTP errors.
        if (!detail && (err as Error).stack) log.appendLine((err as Error).stack!);
        tracker.update((st) => {
          st.phase = "failed";
          st.finishedAt = Date.now();
          st.error = { message, detail };
          const current = st.targets.find((t) => t.name === st.currentTarget && t.status !== "done");
          if (current) current.status = "failed";
        });
        finish(workspaceRoot, tracker, logLines);
        void vscode.window.showErrorMessage(`FTPilot failed: ${message}`, "Open Report", "Show Output").then((c) => {
          if (c === "Open Report") void vscode.env.openExternal(vscode.Uri.file(s.reportPath!));
          if (c === "Show Output") output.show(true);
        });
        return { ok: false, message };
      } finally {
        client?.close();
        statusBar.text = "$(cloud-upload) Deploy";
      }
    }
  );
}

/** Writes the log + HTML report, records their paths on the state, and pushes the final snapshot. */
function finish(workspaceRoot: string, tracker: DeployTracker, logLines: string[]): void {
  const s = tracker.state;
  try {
    s.logPath = writeLog(workspaceRoot, s, logLines.join(""));
    s.reportPath = writeReport(workspaceRoot, s);
  } catch (err) {
    // Never let report writing mask the real deploy result.
    console.error("FTPilot: couldn't write report/log", err);
  }
  tracker.emitNow();
}
