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

const MAX_ATTEMPTS = 3;

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
}

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
          if (this.fatal) return reject(this.fatal);
          if (this.opts.isCancelled?.() && !this.workers.some((w) => w.running)) return reject(new CancelledError());
          if (!this.queue.length && !this.workers.some((w) => w.running)) resolve();
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
    const w: Worker = { id: this.workers.length, running: false };
    this.workers.push(w);
    return w;
  }

  private async connectWorker(w: Worker): Promise<ftp.Client> {
    const client = await this.opts.connect();
    w.client = client;
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
            if (this.handleConnectError(w, err)) return;
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
      this.wake?.();
    }
  }

  /** Returns true when this worker should stop. */
  private handleConnectError(w: Worker, err: unknown): boolean {
    const others = this.workers.filter((o) => o !== w && o.client).length;
    if (isLimitError(err) && others > 0) {
      // The server just told us its cap: that's the number already connected.
      this.ceiling = others;
      this.desired = Math.min(this.desired, others);
      this.ramping = false;
      this.event("limit", `Server refused connection #${w.id + 1} (${(err as Error).message.trim()}); limiting to ${others}`);
      return true;
    }
    if (others === 0) {
      this.fatal = err; // can't connect at all: surface the real error
      return true;
    }
    this.desired = Math.max(1, this.desired - 1);
    this.ramping = false;
    this.event("scale-down", `Couldn't open connection #${w.id + 1} (${(err as Error).message}); using ${this.desired}`);
    return true;
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
