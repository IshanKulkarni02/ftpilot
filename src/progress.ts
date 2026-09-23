import type { HealthResult } from "./health";

export type TargetStatus = "pending" | "building" | "built" | "uploading" | "done" | "failed";

export interface TargetProgress {
  name: string;
  buildCommand?: string;
  localDir: string;
  remoteDir: string;
  status: TargetStatus;
  buildMs?: number;
  uploadMs?: number;
  /** Files this run will upload (all files in full mode, only changed ones in incremental). */
  toUpload: number;
  uploaded: number;
  toRemove: number;
  removed: number;
  unchanged: number;
  restarted?: boolean;
  health?: HealthResult;
  /** Preview breakdown: files new vs. changed since the last deploy. */
  newCount?: number;
  changedCount?: number;
  /** Compare-with-server: files FTPilot thinks are current but differ/are missing on the server. */
  driftCount?: number;
  /** Compare-with-server: files on the server that aren't in the build (never touched). */
  extraCount?: number;
  newFiles?: string[];
  changedFiles?: string[];
  driftFiles?: string[];
  /** Kept for the report only; stripped before sending to the webview. */
  uploadedFiles: string[];
  removedFiles: string[];
}

export interface DeployState {
  kind: "deploy" | "full" | "target" | "preview";
  /** Preview only: nothing was uploaded. */
  dryRun?: boolean;
  compareRemote?: boolean;
  /** Target the run was limited to, so "Deploy These Changes" can repeat the same scope. */
  onlyTargetId?: string;
  /** Preview: expected upload time from this server's last measured speed. */
  estimateMs?: number;
  phase: "preparing" | "building" | "comparing" | "uploading" | "checking" | "done" | "failed";
  /** Upload succeeded but at least one health check didn't. */
  healthFailed?: boolean;
  startedAt: number;
  finishedAt?: number;
  project: string;
  branch?: string;
  commit?: string;
  host: string;
  strategy: "incremental" | "full";
  targets: TargetProgress[];
  currentTarget?: string;
  currentFile?: string;
  /** Latest line of build output, so "building..." isn't a black box. */
  lastLine?: string;
  totalOps: number;
  doneOps: number;
  totalBytes: number;
  doneBytes: number;
  /** Parallel upload connections: live, cap, peak reached; files/sec over the last window. */
  connections: number;
  maxConnections?: number;
  peakConnections?: number;
  rate?: number;
  retries?: number;
  events: { t: number; kind: string; message: string }[];
  cancelled?: boolean;
  error?: { message: string; detail?: string };
  reportPath?: string;
  logPath?: string;
}

/** Holds live deploy state and pushes throttled snapshots to a listener (the panel). */
export class DeployTracker {
  private timer?: NodeJS.Timeout;

  constructor(public readonly state: DeployState, private readonly listener?: (s: DeployState) => void) {
    this.emitNow();
  }

  target(name: string): TargetProgress | undefined {
    return this.state.targets.find((t) => t.name === name);
  }

  update(fn: (s: DeployState) => void): void {
    fn(this.state);
    // Per-file uploads can fire hundreds of times a second; the UI only needs ~6 fps.
    if (!this.timer) this.timer = setTimeout(() => this.emitNow(), 150);
  }

  emitNow(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.listener?.(this.state);
  }
}

/** Snapshot for the webview: everything except the (potentially huge) file lists. */
export function slimState(s: DeployState): DeployState {
  return { ...s, targets: s.targets.map((t) => ({ ...t, uploadedFiles: [], removedFiles: [], newFiles: [], changedFiles: [], driftFiles: [] })) };
}
