import * as ftp from "basic-ftp";

/** One unit of FTP work; `run` must be safe to retry on a fresh connection. */
export interface Job {
  label: string;
  bytes: number;
  attempts: number;
  /** For metrics (Geek Mode / report charts). */
  meta?: { kind: "upload" | "remove" | "snapshot" | "restore"; target: string; rel: string };
  run: (client: ftp.Client) => Promise<void>;
}

export interface PoolEvent {
  t: number;
  kind: "connect" | "scale-up" | "scale-down" | "limit" | "retry" | "reconnect" | "error" | "hold";
  message: string;
}

export interface PoolStats {
  /** Connections currently doing work (or ready to). */
  active: number;
  /** How many connections the controller wants right now. */
  desired: number;
  /** Highest count reached this run. */
  peak: number;
  /** Server-imposed limit learned this run (or remembered), if any. */
  ceiling?: number;
  /** Files/sec over the last controller window. */
  rate: number;
  retries: number;
}

export interface PoolOptions {
  connect: () => Promise<ftp.Client>;
  /** Connections to open at the start (clamped to [1, max]). */
  start: number;
  max: number;
  /** Previously learned server limit, if any. */
  ceiling?: number;
  onEvent?: (e: PoolEvent) => void;
  onJobDone?: (job: Job, ms: number, workerId: number) => void;
  isCancelled?: () => boolean;
  /** Controller window; small in tests. */
  windowMs?: number;
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled by user.");
  }
}

// Network drops come in bursts; 5 tries on fresh connections rides out a bad patch.
const MAX_ATTEMPTS = 5;

/** 421, or 530 "too many connections"-style replies: the server's per-IP/per-user cap. */
export function isLimitError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  const msg = e?.message ?? "";
  return e?.code === 421 || /too many|maximum number|connection limit|max.*connections|clients? limit/i.test(msg);
}

/** Network blips worth retrying on a fresh connection (vs. e.g. 550 permission denied). */
export function isTransientError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  if (typeof e?.code === "string" && ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "ENOTCONN", "ECONNABORTED", "EHOSTUNREACH"].includes(e.code)) return true;
  if (typeof e?.code === "number" && [421, 425, 426, 450, 451].includes(e.code)) return true;
  // basic-ftp wording for a dropped control/data connection, e.g. "Server sent FIN packet
  // unexpectedly, closing connection.", "Client is closed", "Timeout (control socket)".
  return /timeout|closed|closing|socket|reset|ended|FIN packet|unexpectedly|EOF|not connected/i.test(e?.message ?? "");
}

interface Worker {
  id: number;
  client?: ftp.Client;
  running: boolean;
  /** Consecutive failed connects while no other connection was working. */
  connectFailures: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_SOLO_CONNECT_FAILURES = 3;

/**
 * Runs FTP jobs over several connections and adapts the connection count to the server:
 * starts small, adds a connection while throughput keeps improving (>10% per window),
 * holds when it stops helping, and backs off on connection-limit or network errors.
 * Connections stay open across run() calls, so one pool serves all phases of a target.
 */
export class AdaptivePool {
  private workers: Worker[] = [];
  private queue: Job[] = [];
  private desired: number;
  private peak = 0;
  private ceiling?: number;
  private ramping = true;
  private retries = 0;
  private doneInWindow = 0;
  private prevRate = 0;
  private rate = 0;
  private fatal?: unknown;
  private timer?: NodeJS.Timeout;
  private wake?: () => void;
  private readonly max: number;

  constructor(private readonly opts: PoolOptions) {
    this.max = Math.max(1, Math.min(opts.max, opts.ceiling ?? opts.max));
    this.ceiling = opts.ceiling;
    this.desired = Math.max(1, Math.min(opts.start, this.max));
    // Starting at a remembered best count means there's nothing left to probe.
    if (this.desired >= this.max) this.ramping = false;
  }

  stats(): PoolStats {
    return {
      active: this.workers.filter((w) => w.client).length,
      desired: this.desired,
      peak: this.peak,
      ceiling: this.ceiling,
      rate: this.rate,
      retries: this.retries,
    };
  }

  /** Best connection count to start with next time. */
  learnedStart(): number {
    return Math.max(1, Math.min(this.peak || this.desired, this.ceiling ?? this.max));
  }

  private event(kind: PoolEvent["kind"], message: string): void {
    this.opts.onEvent?.({ t: Date.now(), kind, message });
  }

  /** Runs `fn` on a single connection (e.g. creating dirs or touching a restart file). */
  async withClient<T>(fn: (c: ftp.Client) => Promise<T>): Promise<T> {
    const w = this.workers[0] ?? this.addWorker();
    if (!w.client) w.client = await this.connectWorker(w);
    try {
      return await fn(w.client);
    } catch (err) {
      if (!isTransientError(err)) throw err;
      w.client.close();
      w.client = await this.connectWorker(w);
      return fn(w.client);
    }
  }

  async run(jobs: Job[]): Promise<void> {
    if (!jobs.length) return;
    this.queue.push(...jobs);
    this.fatal = undefined;
    this.startController();
    try {
      await new Promise<void>((resolve, reject) => {
        this.wake = () => {
          const busy = this.workers.some((w) => w.running);
          // Never settle while a transfer is still in flight: the caller closes the pool (or
          // deletes the snapshot folder) as soon as this settles.
          if (busy) return;
          if (this.fatal) return reject(this.fatal);
          if (this.opts.isCancelled?.()) return reject(new CancelledError());
          if (!this.queue.length) return resolve();
          // Work left but nobody running (every worker stopped on a connect error): restart.
          this.fill();
          if (!this.workers.some((w) => w.running)) reject(new Error("No FTP connection could be kept open to finish the upload."));
        };
        this.fill();
        this.wake();
      });
    } finally {
      this.stopController();
      this.queue = [];
    }
  }

  close(): void {
    this.stopController();
    for (const w of this.workers) w.client?.close();
    this.workers = [];
  }

  private addWorker(): Worker {
    const w: Worker = { id: this.workers.length, running: false, connectFailures: 0 };
    this.workers.push(w);
    return w;
  }

  private async connectWorker(w: Worker): Promise<ftp.Client> {
    const client = await this.opts.connect();
    w.client = client;
    w.connectFailures = 0;
    this.peak = Math.max(this.peak, this.stats().active);
    this.event("connect", `Connection #${w.id + 1} opened`);
    return client;
  }

  /** Starts idle workers up to `desired`. */
  private fill(): void {
    while (this.workers.length < this.desired) this.addWorker();
    for (const w of this.workers) {
      if (w.id < this.desired && !w.running && this.queue.length && !this.fatal && !this.opts.isCancelled?.()) {
        void this.loop(w);
      }
    }
  }

  private async loop(w: Worker): Promise<void> {
    w.running = true;
    try {
      while (this.queue.length && w.id < this.desired && !this.fatal && !this.opts.isCancelled?.()) {
        if (!w.client) {
          try {
            w.client = await this.connectWorker(w);
          } catch (err) {
            if (await this.handleConnectError(w, err)) return;
            continue;
          }
        }
        const job = this.queue.shift();
        if (!job) break;
        const t0 = Date.now();
        try {
          await job.run(w.client);
          this.doneInWindow++;
          this.opts.onJobDone?.(job, Date.now() - t0, w.id);
        } catch (err) {
          this.handleJobError(w, job, err);
        }
      }
    } finally {
      w.running = false;
      // A worker parked by a scale-down must not keep holding one of the server's connection
      // slots (it would count toward the per-IP limit and time out server-side anyway).
      if (w.id >= this.desired && w.client) {
        w.client.close();
        w.client = undefined;
      }
      this.wake?.();
    }
  }

  /** Returns true when this worker should stop; false to try connecting again. */
  private async handleConnectError(w: Worker, err: unknown): Promise<boolean> {
    const msg = (err as Error).message.trim();
    // Only connections actively working count: they will carry on with the queue.
    const working = this.workers.filter((o) => o !== w && o.running && o.client).length;
    if (working > 0) {
      if (isLimitError(err)) {
        // The server just told us its cap: that's the number already working.
        this.ceiling = working;
        this.event("limit", `Server refused connection #${w.id + 1} (${msg}); limiting to ${working}`);
      } else {
        this.event("scale-down", `Couldn't open connection #${w.id + 1} (${msg}); using ${working}`);
      }
      this.desired = Math.max(1, Math.min(this.desired, working));
      this.ramping = false;
      return true;
    }
    // Nobody else is working, so this worker must carry on or the run can't finish.
    w.connectFailures++;
    if (w.connectFailures >= MAX_SOLO_CONNECT_FAILURES) {
      this.fatal = err; // surface the real error (wrong password, host down, ...)
      return true;
    }
    if (!isLimitError(err) && !isTransientError(err)) {
      this.fatal = err; // e.g. 530 wrong password: retrying won't help
      return true;
    }
    this.event("reconnect", `Couldn't connect (${msg}); retrying in 2s (${w.connectFailures}/${MAX_SOLO_CONNECT_FAILURES})`);
    await sleep(2000);
    return false;
  }

  private handleJobError(w: Worker, job: Job, err: unknown): void {
    w.client?.close();
    w.client = undefined;
    job.attempts++;
    if (!isTransientError(err) || job.attempts >= MAX_ATTEMPTS) {
      const msg = (err as Error).message;
      this.fatal = new Error(`${job.label}: ${msg}${job.attempts >= MAX_ATTEMPTS ? ` (after ${job.attempts} attempts)` : ""}`);
      this.event("error", `${job.label} failed: ${msg}`);
      return;
    }
    this.retries++;
    this.queue.unshift(job);
    this.event("retry", `${job.label}: ${(err as Error).message} (attempt ${job.attempts + 1}/${MAX_ATTEMPTS})`);
    // A dropped connection under load is a hint we're pushing too hard.
    if (this.desired > 1 && isLimitError(err)) {
      this.desired--;
      this.ceiling = this.desired;
      this.ramping = false;
      this.event("limit", `Server limit hit; limiting to ${this.desired}`);
    }
  }

  private startController(): void {
    const windowMs = this.opts.windowMs ?? 3000;
    this.doneInWindow = 0;
    this.timer = setInterval(() => {
      this.rate = (this.doneInWindow * 1000) / windowMs;
      this.doneInWindow = 0;
      const cap = Math.min(this.max, this.ceiling ?? this.max);
      // Only worth probing while there's enough work left for another connection.
      const enoughWork = this.queue.length > this.desired * 4;
      if (this.ramping && enoughWork && this.desired < cap && (this.prevRate === 0 || this.rate > this.prevRate * 1.1)) {
        this.desired++;
        this.event("scale-up", `${this.rate.toFixed(1)} files/s; adding connection (${this.desired})`);
        this.fill();
      } else if (this.ramping && this.prevRate > 0 && this.rate <= this.prevRate * 1.1) {
        this.ramping = false;
        if (this.rate < this.prevRate * 0.9 && this.desired > 1) {
          this.desired--;
          this.event("scale-down", `Last connection made it slower (${this.rate.toFixed(1)} vs ${this.prevRate.toFixed(1)} files/s); back to ${this.desired}`);
        } else {
          this.event("hold", `No gain from more connections; holding at ${this.desired}`);
        }
      }
      if (this.rate > 0) this.prevRate = this.rate;
    }, windowMs);
  }

  private stopController(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
