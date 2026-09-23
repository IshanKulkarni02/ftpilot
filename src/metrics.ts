/** Fine-grained timing for Geek Mode and the report's charts. Lives outside DeployState (which goes to the sidebar several times a second). */

export type FileKind = "upload" | "remove" | "snapshot" | "restore";

export interface FileRec {
  /** ms since run start */
  t0: number;
  t1: number;
  bytes: number;
  /** Which pooled connection did it (0-based). */
  worker: number;
  kind: FileKind;
  target: string;
  rel: string;
}

export interface Sample {
  /** ms since run start */
  t: number;
  doneOps: number;
  doneBytes: number;
  connections: number;
}

export interface PhaseRec {
  name: "build" | "compare" | "snapshot" | "upload" | "restore" | "check";
  target?: string;
  /** ms since run start */
  start: number;
  end?: number;
}

export class Metrics {
  readonly files: FileRec[] = [];
  readonly samples: Sample[] = [];
  readonly phases: PhaseRec[] = [];
  readonly buildLines: string[] = [];
  private open?: PhaseRec;

  constructor(readonly startedAt: number) {}

  now(): number {
    return Date.now() - this.startedAt;
  }

  /** Closes the current phase (if any) and opens the next. */
  phase(name: PhaseRec["name"], target?: string): void {
    this.endPhase();
    this.open = { name, target, start: this.now() };
    this.phases.push(this.open);
  }

  endPhase(): void {
    if (this.open && this.open.end === undefined) this.open.end = this.now();
    this.open = undefined;
  }

  file(rec: Omit<FileRec, "t0" | "t1">, ms: number): void {
    const t1 = this.now();
    this.files.push({ ...rec, t0: Math.max(0, t1 - ms), t1 });
  }

  sample(s: Omit<Sample, "t">): void {
    this.samples.push({ ...s, t: this.now() });
    // One hour at 1 Hz; older points are dropped.
    if (this.samples.length > 3600) this.samples.shift();
  }

  line(l: string): void {
    this.buildLines.push(l);
    if (this.buildLines.length > 200) this.buildLines.shift();
  }
}
