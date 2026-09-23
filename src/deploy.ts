import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { loadConfig, manifestPath, updateTargetLocalDir, DeployTarget, DeployConfig, DEFAULT_MAX_CONNECTIONS, DEFAULT_EXCLUDE } from "./config";
import { getCredentials } from "./secrets";
import { getCurrentBranch, checkoutBranch, getShortCommit } from "./git";
import { runBuild, validateEnvSecrets, BuildError, LogSink } from "./build";
import { loadManifest, saveManifest, hashTarget, diffTarget, walkDir, globMatcher, Manifest } from "./manifest";
import { DeployState, DeployTracker, TargetProgress } from "./progress";
import { AdaptivePool, CancelledError, Job } from "./parallel";
import { checkHealth } from "./health";
import { RollbackInfo, beginSnapshot, saveSnapshot, pruneSnapshots, savedFile, snapshotDir, loadSnapshot, restoreManifest } from "./rollback";
import { writeReport, writeLog, formatMs } from "./report";
import { snapshotTopLevelDirs, diffTopLevelDirs } from "./detect";
import * as ftpClient from "./ftpClient";

export interface DeployOptions {
  /** Force full re-upload of every target, ignoring uploadMode / manifest. */
  forceFull?: boolean;
  /** Build + upload only this target (matched by id, falling back to name). */
  onlyTargetId?: string;
  /** Build + compare only; upload nothing. */
  dryRun?: boolean;
  /** Preview only: also list the server's files to catch changes made outside FTPilot. */
  compareRemote?: boolean;
  /** Reuse existing build output (e.g. "Deploy These Changes" right after a preview). */
  skipBuild?: boolean;
  /** Live progress snapshots (throttled) for the panel. */
  onProgress?: (state: DeployState) => void;
}

/** One deploy at a time: two concurrent runs would race on the manifest and the FTP server. */
let running = false;
let cancelRequested = false;
/** Kills the in-flight build process, if any. */
let killBuild: (() => void) | undefined;

/** Stops the running deploy at the next safe point (after in-flight files; kills an active build). */
export function cancelDeploy(): void {
  if (!running) return;
  cancelRequested = true;
  killBuild?.();
}

interface PoolEntry {
  pool: AdaptivePool;
  key: string;
}

/**
 * The adaptive connection pool for a target's FTP account (one per account per run),
 * starting from the connection count remembered for this host+user.
 */
async function openPool(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  config: DeployConfig,
  target: { ftpUser?: string },
  pools: Map<string, PoolEntry>,
  tracker: DeployTracker,
  log: LogSink,
  say: (m: string) => void
): Promise<PoolEntry> {
  const account = target.ftpUser ?? "default";
  const existing = pools.get(account);
  if (existing) return existing;
  const creds = await getCredentials(context, workspaceRoot, account);
  if (!creds) {
    throw new Error(
      account === "default"
        ? "No FTP login saved for this project. Open the FTPilot configuration and use Update Credentials."
        : `No password saved for FTP account '${account}'. Open the FTPilot configuration and use Update Credentials on that target.`
    );
  }
  const maxConnections = Math.max(1, Math.min(10, config.maxConnections ?? DEFAULT_MAX_CONNECTIONS));
  const key = `ftpilot.connections:${config.host}:${config.port}:${creds.user}`;
  const learned = context.globalState.get<{ start: number; ceiling?: number }>(key);
  const pool = new AdaptivePool({
    connect: () => ftpClient.connect(config, creds),
    start: learned?.start ?? 2,
    max: maxConnections,
    ceiling: learned?.ceiling,
    isCancelled: () => cancelRequested,
    onEvent: (e) => {
      log.appendLine(`[connections] ${e.message}`);
      tracker.update((st) => { st.events.push(e); if (st.events.length > 200) st.events.shift(); });
    },
  });
  const entry = { pool, key };
  pools.set(account, entry);
  say(`Connecting to ${config.host}…`);
  log.appendLine(`\nConnecting to ${config.host}:${config.port} as ${creds.user} (start ${learned?.start ?? 2}, max ${maxConnections} connections)...`);
  return entry;
}

/** Mirrors pool stats into the progress state once a second; returns a stop function. */
function trackPool(pool: AdaptivePool, tracker: DeployTracker): () => void {
  const sync = () => tracker.update((st) => {
    const ps = pool.stats();
    st.connections = ps.active;
    st.peakConnections = Math.max(st.peakConnections ?? 0, ps.peak);
    st.rate = ps.rate;
    st.retries = ps.retries;
  });
  const timer = setInterval(sync, 1000);
  return () => { clearInterval(timer); sync(); };
}

function runId(): string {
  return new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

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
  cancelRequested = false;
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

  const kind: DeployState["kind"] = options.dryRun ? "preview" : options.onlyTargetId ? "target" : options.forceFull ? "full" : "deploy";
  const rateKey = `ftpilot.rate:${config.host}:${config.port}`;
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
      dryRun: options.dryRun,
      compareRemote: options.compareRemote,
      onlyTargetId: options.onlyTargetId,
      totalOps: 0,
      doneOps: 0,
      totalBytes: 0,
      doneBytes: 0,
      connections: 0,
      events: [],
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
    { location: vscode.ProgressLocation.Notification, title: "FTPilot", cancellable: true },
    async (vsProgress, token) => {
      let lastPct = 0;
      const say = (message: string) => {
        const pct = s.totalOps ? Math.floor((s.doneOps / s.totalOps) * 100) : 0;
        vsProgress.report({ message, increment: Math.max(0, pct - lastPct) });
        lastPct = Math.max(lastPct, pct);
        statusBar.text = `$(sync~spin) FTPilot: ${message}`;
      };

      // One adaptive pool per FTP account, reused across that account's targets.
      const pools = new Map<string, PoolEntry>();
      const maxConnections = Math.max(1, Math.min(10, config.maxConnections ?? DEFAULT_MAX_CONNECTIONS));
      const exclude = globMatcher(config.exclude ?? DEFAULT_EXCLUDE);
      token.onCancellationRequested(() => { cancelRequested = true; });

      type Plan = { target: DeployTarget; localDir: string; tp: TargetProgress; all: string[]; toUpload: string[]; toRemove: string[] };

      // Preview: report what a deploy would do, optionally checked against the server's real
      // file list, then stop. Nothing is uploaded and the manifest is left untouched.
      const finishPreview = async (plans: Plan[]): Promise<DeployResult> => {
        if (options.compareRemote) {
          tracker.update((st) => { st.phase = "comparing"; });
          for (const { target, localDir, tp, all, toUpload } of plans) {
            const account = target.ftpUser ?? "default";
            const creds = await getCredentials(context, workspaceRoot, account);
            if (!creds) throw new Error(`No FTP login saved for '${account}'. Use Update Credentials first.`);
            say(`Reading server files for ${target.name}…`);
            tracker.update((st) => { st.currentTarget = target.name; });
            const client = await ftpClient.connect(config, creds);
            try {
              const remote = await ftpClient.listRemoteFiles(client, target.remoteDir);
              const pending = new Set(toUpload);
              const local = new Set(all);
              // Files FTPilot believes are current, but the server has a different size or lacks.
              tp.driftFiles = all.filter((rel) => !pending.has(rel) && remote.get(rel) !== fileSize(path.join(localDir, rel)));
              tp.driftCount = tp.driftFiles.length;
              tp.extraCount = [...remote.keys()].filter((rel) => !local.has(rel)).length;
              log.appendLine(`[${target.name}] server has ${remote.size} files; ${tp.driftCount} differ from FTPilot's record; ${tp.extraCount} extra (left untouched).`);
            } finally {
              client.close();
            }
          }
        }
        // The report's "Would remove" list reads removedFiles; nothing was actually removed.
        for (const { tp, toRemove } of plans) tp.removedFiles = [...toRemove];
        const rate = context.globalState.get<number>(rateKey);
        tracker.update((st) => {
          st.phase = "done";
          st.finishedAt = Date.now();
          st.currentTarget = undefined;
          if (rate && st.totalOps) st.estimateMs = (st.totalOps / rate) * 1000;
        });
        const message = s.totalOps
          ? `Preview: ${s.totalOps} file operation(s) pending, nothing uploaded.`
          : "Preview: nothing to deploy; everything matches the last deploy.";
        log.appendLine(`\n${message}`);
        finish(workspaceRoot, tracker, logLines);
        return { ok: true, message };
      };

      try {
        // 1. Fail fast on any missing secret env var before building anything.
        say("Checking settings…");
        await validateEnvSecrets(context, workspaceRoot, config.targets);

        // 2. Build each target. If the output folder is missing afterwards, fall back to
        // whichever folder the build just created/touched and persist the fix.
        tracker.update((st) => { st.phase = "building"; });
        for (const target of config.targets) {
          if (cancelRequested) throw new CancelledError();
          const tp = tracker.target(target.name)!;
          tracker.update((st) => { st.currentTarget = target.name; st.lastLine = undefined; tp.status = "building"; });
          say(`Building ${target.name}…`);
          log.appendLine(`\n=== Building: ${target.name} ===`);
          const buildCwd = target.cwd ? path.join(workspaceRoot, target.cwd) : workspaceRoot;
          const before = target.buildCommand ? snapshotTopLevelDirs(buildCwd) : undefined;
          const t0 = Date.now();

          if (options.skipBuild) {
            if (!fs.existsSync(path.join(workspaceRoot, target.localDir))) {
              throw new Error(`[${target.name}] build output '${target.localDir}' is gone. Run Preview again.`);
            }
            log.appendLine(`Using the existing build output from the preview (no rebuild).`);
          } else {
            await runBuild(context, target, workspaceRoot, log, (line) => tracker.update((st) => { st.lastLine = line; }), (kill) => { killBuild = kill; });
          }
          killBuild = undefined;
          if (cancelRequested) throw new CancelledError();

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
          Object.assign(newManifest, hashTarget(target.name, path.join(workspaceRoot, target.localDir), exclude));
        }
        const mPath = manifestPath(workspaceRoot);
        const oldManifest = options.forceFull ? {} : loadManifest(mPath);
        let excludedCount = 0;
        const plans = config.targets.map((target) => {
          const localDir = path.join(workspaceRoot, target.localDir);
          const all = walkDir(localDir, exclude);
          excludedCount += walkDir(localDir).length - all.length;
          const diff = useFull ? { toUpload: all, toRemove: [] as string[] } : diffTarget(target.name, oldManifest, newManifest);
          const tp = tracker.target(target.name)!;
          tp.toUpload = diff.toUpload.length;
          tp.toRemove = diff.toRemove.length;
          tp.unchanged = all.length - diff.toUpload.length;
          tp.newFiles = diff.toUpload.filter((rel) => !(`${target.name}/${rel}` in oldManifest));
          tp.changedFiles = diff.toUpload.filter((rel) => `${target.name}/${rel}` in oldManifest);
          tp.newCount = tp.newFiles.length;
          tp.changedCount = tp.changedFiles.length;
          return { target, localDir, tp, all, ...diff };
        });
        if (excludedCount) log.appendLine(`Skipping ${excludedCount} file(s) matching exclude patterns: ${(config.exclude ?? DEFAULT_EXCLUDE).join(", ")}`);
        tracker.update((st) => {
          st.totalOps = plans.reduce((n, p) => n + p.toUpload.length + p.toRemove.length, 0);
          st.totalBytes = plans.reduce((n, p) => n + p.toUpload.reduce((b, rel) => b + fileSize(path.join(p.localDir, rel)), 0), 0);
          st.maxConnections = maxConnections;
        });

        if (options.dryRun) {
          return await finishPreview(plans);
        }

        // 4a. Rollback snapshot: download the server's current copy of everything this deploy
        // will overwrite or delete (files that don't exist yet are recorded as "created").
        // If this fails, nothing has been uploaded yet, so the deploy stops safely.
        if (config.rollbackSnapshots !== false && s.totalOps > 0) {
          const info: RollbackInfo = {
            id: runId(), createdAt: Date.now(), project: s.project, branch: s.branch, commit: s.commit, host: s.host, complete: false,
            targets: plans.map((p) => ({
              id: p.target.id ?? p.target.name, name: p.target.name, remoteDir: p.target.remoteDir, restartFile: p.target.restartFile,
              ftpUser: p.target.ftpUser, healthUrl: p.target.healthUrl, healthExpect: p.target.healthExpect, restore: [], created: [],
            })),
          };
          beginSnapshot(workspaceRoot, info);
          tracker.update((st) => { st.phase = "snapshot"; st.snapTotal = st.totalOps; st.snapDone = 0; });
          log.appendLine(`\n=== Saving rollback copy (${s.totalOps} file(s)) ===`);
          try {
            for (const [i, { target, toUpload, toRemove }] of plans.entries()) {
              if (cancelRequested) throw new CancelledError();
              const rt = info.targets[i];
              const removing = new Set(toRemove);
              tracker.update((st) => { st.currentTarget = target.name; });
              const { pool } = await openPool(context, workspaceRoot, config, target, pools, tracker, log, say);
              const stopTracking = trackPool(pool, tracker);
              try {
                await pool.run([...toUpload, ...toRemove].map((rel): Job => ({
                  label: `rollback copy of ${rel}`,
                  bytes: 0,
                  attempts: 0,
                  run: async (c) => {
                    const dest = savedFile(workspaceRoot, info.id, rt.id, rel);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    try {
                      await c.downloadTo(dest, ftpClient.remoteJoin(target.remoteDir, rel));
                      rt.restore.push(rel);
                    } catch (err) {
                      if ((err as { code?: unknown }).code !== 550) throw err;
                      fs.rmSync(dest, { force: true });
                      // 550 means "not found" *or* "not allowed". Only a confirmed-missing file may be
                      // recorded as created, because rolling back deletes created files.
                      const remote = ftpClient.remoteJoin(target.remoteDir, rel);
                      let exists: boolean;
                      try {
                        await c.size(remote);
                        exists = true;
                      } catch (sizeErr) {
                        if ((sizeErr as { code?: unknown }).code !== 550) {
                          throw new Error(`can't tell whether ${rel} already exists on the server (${(err as Error).message.trim()})`);
                        }
                        exists = false;
                      }
                      if (exists) throw new Error(`${rel} exists on the server but couldn't be downloaded (${(err as Error).message.trim()})`);
                      if (!removing.has(rel)) rt.created.push(rel);
                    }
                    tracker.update((st) => { st.snapDone = (st.snapDone ?? 0) + 1; st.currentFile = rel; });
                    say(`Saving rollback copy: ${s.snapDone} / ${s.snapTotal}`);
                  },
                })));
              } finally {
                stopTracking();
              }
            }
          } catch (err) {
            fs.rmSync(snapshotDir(workspaceRoot, info.id), { recursive: true, force: true });
            if (err instanceof CancelledError) throw err;
            throw new Error(`Couldn't save the rollback copy, so nothing was uploaded: ${(err as Error).message}. Turn off rollback snapshots in the configuration to deploy without one.`);
          }
          info.complete = true;
          saveSnapshot(workspaceRoot, info);
          pruneSnapshots(workspaceRoot);
          tracker.update((st) => { st.rollbackId = info.id; });
          const saved = info.targets.reduce((n, t) => n + t.restore.length, 0);
          const created = info.targets.reduce((n, t) => n + t.created.length, 0);
          log.appendLine(`Rollback copy saved: ${saved} existing file(s); ${created} file(s) will be new.`);
        }

        // 4. Upload over an adaptive pool of connections: folders first (so parallel
        // connections never race to create one), then assets, then HTML last so pages only
        // ever reference assets that are already on the server, then deletions.
        tracker.update((st) => { st.phase = "uploading"; });
        for (const { target, localDir, tp, toUpload, toRemove } of plans) {
          if (cancelRequested) throw new CancelledError();
          tracker.update((st) => { st.currentTarget = target.name; st.currentFile = undefined; tp.status = "uploading"; });
          const { pool } = await openPool(context, workspaceRoot, config, target, pools, tracker, log, say);
          const stopTracking = trackPool(pool, tracker);

          log.appendLine(`\n=== Uploading: ${target.name} -> ${target.remoteDir} (${useFull ? "full" : "incremental"}) ===`);
          const t0 = Date.now();
          try {
            if (!toUpload.length && !toRemove.length) say(`${target.name}: nothing changed`);

            const dirs = [...new Set(toUpload.map((rel) => path.posix.dirname(ftpClient.remoteJoin(target.remoteDir, rel))))].sort();
            if (dirs.length) {
              say(`Preparing ${dirs.length} folder(s) on the server…`);
              await pool.withClient((c) => ftpClient.ensureDirs(c, dirs));
            }

            const uploadJob = (rel: string): Job => {
              const bytes = fileSize(path.join(localDir, rel));
              return {
                label: rel,
                bytes,
                attempts: 0,
                run: async (c) => {
                  await c.uploadFrom(path.join(localDir, rel), ftpClient.remoteJoin(target.remoteDir, rel));
                  log.appendLine(`  + ${rel}`);
                  tracker.update((st) => { tp.uploaded++; tp.uploadedFiles.push(rel); st.doneOps++; st.doneBytes = (st.doneBytes ?? 0) + bytes; st.currentFile = rel; });
                  say(`Uploading ${target.name}: ${tp.uploaded} / ${tp.toUpload}`);
                },
              };
            };
            const isHtml = (rel: string) => /\.html?$/i.test(rel);
            await pool.run(toUpload.filter((r) => !isHtml(r)).map(uploadJob));
            await pool.run(toUpload.filter(isHtml).map(uploadJob));
            await pool.run(toRemove.map((rel): Job => ({
              label: rel,
              bytes: 0,
              attempts: 0,
              run: async (c) => {
                await ftpClient.removeOne(c, target.remoteDir, rel);
                log.appendLine(`  - ${rel}`);
                tracker.update((st) => { tp.removed++; tp.removedFiles.push(rel); st.doneOps++; st.currentFile = rel; });
                say(`Cleaning up ${target.name}: ${tp.removed} / ${tp.toRemove}`);
              },
            })));
            log.appendLine(`Uploaded ${tp.uploaded}, removed ${tp.removed}, unchanged ${tp.unchanged}.`);

            const targetChanged = useFull || toUpload.length > 0 || toRemove.length > 0;
            if (target.restartFile && targetChanged) {
              say(`Restarting ${target.name}…`);
              log.appendLine(`Restarting app: touching ${target.restartFile}`);
              await pool.withClient((c) => ftpClient.touchRestartFile(c, target.restartFile!));
              tp.restarted = true;
            }
          } finally {
            stopTracking();
          }
          tracker.update(() => { tp.uploadMs = Date.now() - t0; tp.status = "done"; });
        }

        // 5. Health checks: after every target is up (the frontend may call the API), fetch each
        // target's URL. A just-restarted Passenger app can take a few seconds, hence retries.
        const checks = plans.filter((p) => p.target.healthUrl?.trim());
        if (checks.length) {
          tracker.update((st) => { st.phase = "checking"; st.currentFile = undefined; });
          if (plans.some((p) => p.tp.restarted)) await new Promise((r) => setTimeout(r, 3000));
          for (const { target, tp } of checks) {
            tracker.update((st) => { st.currentTarget = target.name; });
            const url = target.healthUrl!.trim();
            log.appendLine(`\nHealth check: ${target.name} -> ${url}${target.healthExpect ? ` (must contain "${target.healthExpect}")` : ""}`);
            const result = await checkHealth(url, target.healthExpect || undefined, {
              isCancelled: () => cancelRequested,
              onAttempt: (i, n) => say(`Health check ${target.name} (${i}/${n})…`),
            });
            log.appendLine(result.ok ? `  OK: HTTP ${result.status} in ${result.ms} ms` : `  FAILED after ${result.attempts} attempt(s): ${result.error}`);
            tracker.update((st) => { tp.health = result; if (!result.ok) st.healthFailed = true; });
          }
        }

        // Remember what worked so the next deploy starts at full speed, and how fast it
        // went so a Preview can estimate the time.
        const uploadMs = s.targets.reduce((n, t) => n + (t.uploadMs ?? 0), 0);
        if (s.doneOps > 20 && uploadMs > 0) await context.globalState.update(rateKey, s.doneOps / (uploadMs / 1000));
        for (const { pool, key } of pools.values()) {
          const ps = pool.stats();
          await context.globalState.update(key, { start: pool.learnedStart(), ceiling: ps.ceiling });
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
        const failedChecks = s.targets.filter((t) => t.health && !t.health.ok);
        const message = `Done in ${formatMs(s.finishedAt! - s.startedAt)} (${up} uploaded, ${rm} removed)` +
          (failedChecks.length ? `, but health check failed: ${failedChecks.map((t) => `${t.name} (${t.health!.error})`).join("; ")}.` : ".");
        log.appendLine(`\n${message}`);
        finish(workspaceRoot, tracker, logLines);
        const notify = failedChecks.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        void notify(`FTPilot: ${message}`, "Open Report").then((c) => {
          if (c) void vscode.env.openExternal(vscode.Uri.file(s.reportPath!));
        });
        return { ok: true, message };
      } catch (err) {
        const cancelled = err instanceof CancelledError;
        const message = (err as Error).message;
        const detail = err instanceof BuildError ? err.detail : undefined;
        log.appendLine(`\nERROR: ${message}`);
        // Build failures already have their output above; a stack trace only helps for FTPilot/FTP errors.
        if (!detail && (err as Error).stack) log.appendLine((err as Error).stack!);
        tracker.update((st) => {
          st.phase = "failed";
          st.finishedAt = Date.now();
          st.error = { message, detail };
          st.cancelled = cancelled;
          const current = st.targets.find((t) => t.name === st.currentTarget && t.status !== "done");
          if (current) current.status = "failed";
        });
        finish(workspaceRoot, tracker, logLines);
        const show = cancelled ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
        void show(cancelled ? "FTPilot: deploy cancelled. Files already uploaded stay; the next deploy re-sends anything unconfirmed." : `FTPilot failed: ${message}`, "Open Report", "Show Output").then((c) => {
          if (c === "Open Report") void vscode.env.openExternal(vscode.Uri.file(s.reportPath!));
          if (c === "Show Output") output.show(true);
        });
        return { ok: false, message };
      } finally {
        for (const { pool } of pools.values()) pool.close();
        killBuild = undefined;
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

/**
 * Undoes one deploy using its snapshot: re-uploads the saved server copies, deletes files the
 * deploy created, restarts Passenger apps, restores FTPilot's manifest, then health-checks.
 */
export async function runRollback(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  statusBar: vscode.StatusBarItem,
  options: { snapshotId: string; onProgress?: (state: DeployState) => void }
): Promise<DeployResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return { ok: false, message: "No folder open." };
  if (running) {
    void vscode.window.showWarningMessage("FTPilot: a deploy is already running.");
    return { ok: false, message: "Already running." };
  }
  const info = loadSnapshot(workspaceRoot, options.snapshotId);
  const problem = !info ? "That rollback copy no longer exists (only the last 3 are kept)."
    : !info.complete ? "That rollback copy is incomplete and can't be used."
    : info.rolledBackAt ? "That deploy was already rolled back."
    : undefined;
  if (problem || !info) {
    void vscode.window.showErrorMessage(`FTPilot: ${problem}`);
    return { ok: false, message: problem! };
  }

  running = true;
  cancelRequested = false;
  try {
    const config = loadConfig(workspaceRoot, false);
    const tracker = new DeployTracker(
      {
        kind: "rollback",
        phase: "uploading",
        startedAt: Date.now(),
        project: info.project,
        branch: info.branch,
        commit: info.commit,
        host: `${config.host}:${config.port} (${config.secure ? "FTPS" : "FTP"})`,
        strategy: "incremental",
        rollbackOf: info.id,
        targets: info.targets.map((t) => ({
          name: t.name, localDir: "(rollback copy)", remoteDir: t.remoteDir, status: "pending",
          toUpload: t.restore.length, uploaded: 0, toRemove: t.created.length, removed: 0, unchanged: 0,
          uploadedFiles: [], removedFiles: [],
        })),
        totalOps: info.targets.reduce((n, t) => n + t.restore.length + t.created.length, 0),
        doneOps: 0,
        totalBytes: 0,
        doneBytes: 0,
        connections: 0,
        events: [],
      },
      options.onProgress
    );
    const s = tracker.state;
    const logLines: string[] = [];
    const log: LogSink = {
      append: (v: string) => { output.append(v); logLines.push(v); },
      appendLine: (v: string) => { output.appendLine(v); logLines.push(v + "\n"); },
    };
    output.clear();
    log.appendLine(`FTPilot rollback — ${new Date().toLocaleString()} — undoing deploy of ${new Date(info.createdAt).toLocaleString()}${info.commit ? ` (${info.commit})` : ""}`);

    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "FTPilot rollback", cancellable: true },
      async (vsProgress, token) => {
        token.onCancellationRequested(() => { cancelRequested = true; });
        const say = (message: string) => { vsProgress.report({ message }); statusBar.text = `$(sync~spin) FTPilot: ${message}`; };
        const pools = new Map<string, PoolEntry>();
        try {
          for (const [i, rt] of info.targets.entries()) {
            if (cancelRequested) throw new CancelledError();
            const tp = s.targets[i];
            tracker.update((st) => { st.currentTarget = rt.name; tp.status = "uploading"; });
            const { pool } = await openPool(context, workspaceRoot, config, rt, pools, tracker, log, say);
            const stopTracking = trackPool(pool, tracker);
            const t0 = Date.now();
            try {
              log.appendLine(`\n=== Restoring ${rt.name}: ${rt.restore.length} file(s) back, ${rt.created.length} to delete ===`);
              const dirs = [...new Set(rt.restore.map((rel) => path.posix.dirname(ftpClient.remoteJoin(rt.remoteDir, rel))))].sort();
              if (dirs.length) await pool.withClient((c) => ftpClient.ensureDirs(c, dirs));
              await pool.run(rt.restore.map((rel): Job => ({
                label: rel, bytes: 0, attempts: 0,
                run: async (c) => {
                  await c.uploadFrom(savedFile(workspaceRoot, info.id, rt.id, rel), ftpClient.remoteJoin(rt.remoteDir, rel));
                  log.appendLine(`  ↺ ${rel}`);
                  tracker.update((st) => { tp.uploaded++; tp.uploadedFiles.push(rel); st.doneOps++; st.currentFile = rel; });
                  say(`Restoring ${rt.name}: ${tp.uploaded} / ${tp.toUpload}`);
                },
              })));
              await pool.run(rt.created.map((rel): Job => ({
                label: rel, bytes: 0, attempts: 0,
                run: async (c) => {
                  await ftpClient.removeOne(c, rt.remoteDir, rel);
                  log.appendLine(`  - ${rel}`);
                  tracker.update((st) => { tp.removed++; tp.removedFiles.push(rel); st.doneOps++; st.currentFile = rel; });
                },
              })));
              if (rt.restartFile) {
                say(`Restarting ${rt.name}…`);
                await pool.withClient((c) => ftpClient.touchRestartFile(c, rt.restartFile!));
                tp.restarted = true;
              }
            } finally {
              stopTracking();
            }
            tracker.update(() => { tp.uploadMs = Date.now() - t0; tp.status = "done"; });
          }

          restoreManifest(workspaceRoot, info.id);
          info.rolledBackAt = Date.now();
          saveSnapshot(workspaceRoot, info);

          const checks = info.targets.map((rt, i) => ({ rt, tp: s.targets[i] })).filter(({ rt }) => rt.healthUrl);
          if (checks.length) {
            tracker.update((st) => { st.phase = "checking"; });
            if (info.targets.some((t) => t.restartFile)) await new Promise((r) => setTimeout(r, 3000));
            for (const { rt, tp } of checks) {
              const result = await checkHealth(rt.healthUrl!, rt.healthExpect || undefined, { isCancelled: () => cancelRequested, onAttempt: (a, n) => say(`Health check ${rt.name} (${a}/${n})…`) });
              log.appendLine(`Health check ${rt.name}: ${result.ok ? `OK (HTTP ${result.status})` : `FAILED: ${result.error}`}`);
              tracker.update((st) => { tp.health = result; if (!result.ok) st.healthFailed = true; });
            }
          }

          tracker.update((st) => { st.phase = "done"; st.finishedAt = Date.now(); st.currentTarget = undefined; st.currentFile = undefined; });
          const message = `Rolled back in ${formatMs(s.finishedAt! - s.startedAt)}: ${s.targets.reduce((n, t) => n + t.uploaded, 0)} file(s) restored, ${s.targets.reduce((n, t) => n + t.removed, 0)} removed.`;
          log.appendLine(`\n${message}`);
          finish(workspaceRoot, tracker, logLines);
          void vscode.window.showInformationMessage(`FTPilot: ${message}`, "Open Report").then((c) => {
            if (c) void vscode.env.openExternal(vscode.Uri.file(s.reportPath!));
          });
          return { ok: true, message };
        } catch (err) {
          const cancelled = err instanceof CancelledError;
          const message = (err as Error).message;
          log.appendLine(`\nERROR: ${message}`);
          tracker.update((st) => {
            st.phase = "failed"; st.finishedAt = Date.now(); st.error = { message: cancelled ? message : `Rollback incomplete: ${message}. You can run Roll Back again.` }; st.cancelled = cancelled;
            const current = st.targets.find((t) => t.name === st.currentTarget && t.status !== "done");
            if (current) current.status = "failed";
          });
          finish(workspaceRoot, tracker, logLines);
          void vscode.window.showErrorMessage(`FTPilot rollback ${cancelled ? "cancelled" : "failed"}: ${message}`, "Show Output").then((c) => { if (c) output.show(true); });
          return { ok: false, message };
        } finally {
          for (const { pool } of pools.values()) pool.close();
          statusBar.text = "$(cloud-upload) Deploy";
        }
      }
    );
  } finally {
    running = false;
  }
}
