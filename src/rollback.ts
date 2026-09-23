import * as fs from "fs";
import * as path from "path";
import { configDir, manifestPath } from "./config";

/** What one deploy changed on the server for one target, and how to undo it. */
export interface RollbackTarget {
  id: string;
  name: string;
  remoteDir: string;
  restartFile?: string;
  ftpUser?: string;
  healthUrl?: string;
  healthExpect?: string;
  /** Files that existed on the server before the deploy (overwritten or deleted by it); their old copies are saved. */
  restore: string[];
  /** Files the deploy created (didn't exist before); rolling back deletes them. */
  created: string[];
}

export interface RollbackInfo {
  id: string;
  createdAt: number;
  project: string;
  branch?: string;
  commit?: string;
  host: string;
  /** Set once the deploy has been rolled back; a snapshot is only used once. */
  rolledBackAt?: number;
  /** False until the snapshot finished; incomplete snapshots are never offered. */
  complete: boolean;
  targets: RollbackTarget[];
}

const KEEP = 3;

export function rollbackRoot(workspaceRoot: string): string {
  const dir = path.join(configDir(workspaceRoot), "rollback");
  fs.mkdirSync(dir, { recursive: true });
  // Server copies can include anything deployed (built bundles, uploads); never commit them.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf8");
  return dir;
}

export function snapshotDir(workspaceRoot: string, id: string): string {
  return path.join(rollbackRoot(workspaceRoot), id);
}

/** Where the saved server copy of `rel` for a target lives locally. */
export function savedFile(workspaceRoot: string, id: string, targetId: string, rel: string): string {
  return path.join(snapshotDir(workspaceRoot, id), "files", targetId.replace(/[^\w.-]/g, "_"), ...rel.split("/"));
}

/** Starts a snapshot: records the manifest as it was, so a rollback restores FTPilot's view too. */
export function beginSnapshot(workspaceRoot: string, info: RollbackInfo): void {
  const dir = snapshotDir(workspaceRoot, info.id);
  fs.mkdirSync(dir, { recursive: true });
  const m = manifestPath(workspaceRoot);
  if (fs.existsSync(m)) fs.copyFileSync(m, path.join(dir, "manifest.before.json"));
  saveSnapshot(workspaceRoot, info);
}

export function saveSnapshot(workspaceRoot: string, info: RollbackInfo): void {
  fs.writeFileSync(path.join(snapshotDir(workspaceRoot, info.id), "rollback.json"), JSON.stringify(info, null, 2), "utf8");
}

export function loadSnapshot(workspaceRoot: string, id: string): RollbackInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(snapshotDir(workspaceRoot, id), "rollback.json"), "utf8")) as RollbackInfo;
  } catch {
    return undefined;
  }
}

/** Newest first. */
export function listSnapshots(workspaceRoot: string): RollbackInfo[] {
  const root = rollbackRoot(workspaceRoot);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => loadSnapshot(workspaceRoot, e.name))
    .filter((i): i is RollbackInfo => !!i)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Puts back the manifest from before the rolled-back deploy (or removes it if there was none). */
export function restoreManifest(workspaceRoot: string, id: string): void {
  const before = path.join(snapshotDir(workspaceRoot, id), "manifest.before.json");
  const m = manifestPath(workspaceRoot);
  if (fs.existsSync(before)) fs.copyFileSync(before, m);
  else if (fs.existsSync(m)) fs.unlinkSync(m);
}

/** Keeps the newest KEEP snapshots; older ones (and failed partial ones) are deleted from disk. */
export function pruneSnapshots(workspaceRoot: string): void {
  const all = listSnapshots(workspaceRoot);
  for (const info of all.slice(KEEP)) {
    fs.rmSync(snapshotDir(workspaceRoot, info.id), { recursive: true, force: true });
  }
}

/*
 * Rollback order. Undoing an older deploy while a newer one is live would delete files the
 * newer deploy relies on and revert the manifest underneath it, so only the most recent deploy
 * that changed the server can be rolled back; after that, the one before it, and so on.
 * stack.json lists deploys that uploaded/deleted anything, oldest first; null = no snapshot
 * (snapshots were off), which blocks rolling back past it.
 */
const MAX_STACK = 20;

function stackFile(workspaceRoot: string): string {
  return path.join(rollbackRoot(workspaceRoot), "stack.json");
}

function readStack(workspaceRoot: string): (string | null)[] {
  try {
    const v = JSON.parse(fs.readFileSync(stackFile(workspaceRoot), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeStack(workspaceRoot: string, stack: (string | null)[]): void {
  fs.writeFileSync(stackFile(workspaceRoot), JSON.stringify(stack.slice(-MAX_STACK)), "utf8");
}

/** Record a deploy that changed the server (with its snapshot id, or null if none was taken). */
export function recordDeploy(workspaceRoot: string, snapshotId: string | null): void {
  writeStack(workspaceRoot, [...readStack(workspaceRoot), snapshotId]);
}

/** The only snapshot that may be rolled back right now, if any. */
export function rollbackableId(workspaceRoot: string): string | undefined {
  const top = readStack(workspaceRoot).at(-1);
  if (!top) return undefined;
  const info = loadSnapshot(workspaceRoot, top);
  return info?.complete && !info.rolledBackAt ? top : undefined;
}

/** After a successful rollback, the previous deploy becomes the one that can be undone. */
export function recordRollback(workspaceRoot: string, snapshotId: string): void {
  const stack = readStack(workspaceRoot);
  if (stack.at(-1) === snapshotId) writeStack(workspaceRoot, stack.slice(0, -1));
}
