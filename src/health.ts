export interface HealthResult {
  url: string;
  ok: boolean;
  /** Final HTTP status (after redirects). */
  status?: number;
  /** Response time of the last attempt. */
  ms?: number;
  /** Why it failed, in plain words. */
  error?: string;
  attempts: number;
  checkedAt: number;
}

export interface HealthOptions {
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  onAttempt?: (attempt: number, of: number) => void;
  isCancelled?: () => boolean;
}

/** Only http(s) URLs are fetched; anything else is a config mistake worth flagging. */
export function validHealthUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? undefined : "Health check URL must start with http:// or https://";
  } catch {
    return "Health check URL isn't a valid URL (e.g. https://example.com/health)";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GETs `url` until it answers 200–399 (and contains `expectText`, if given). Retries because a
 * Passenger app that was just restarted can take a few seconds to come back.
 */
export async function checkHealth(url: string, expectText: string | undefined, opts: HealthOptions = {}): Promise<HealthResult> {
  const attempts = opts.attempts ?? 3;
  const invalid = validHealthUrl(url);
  if (invalid) return { url, ok: false, error: invalid, attempts: 0, checkedAt: Date.now() };

  let last: HealthResult = { url, ok: false, attempts: 0, checkedAt: Date.now() };
  for (let i = 1; i <= attempts; i++) {
    if (opts.isCancelled?.()) break;
    opts.onAttempt?.(i, attempts);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        redirect: "follow",
        // Bypass caches/CDNs so we see what was just deployed.
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache", "User-Agent": "FTPilot health check" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      const ms = Date.now() - t0;
      const body = expectText ? await res.text() : "";
      if (res.status < 200 || res.status >= 400) {
        last = { url, ok: false, status: res.status, ms, attempts: i, checkedAt: Date.now(), error: `HTTP ${res.status} ${res.statusText}`.trim() };
      } else if (expectText && !body.includes(expectText)) {
        last = { url, ok: false, status: res.status, ms, attempts: i, checkedAt: Date.now(), error: `Page loaded (HTTP ${res.status}) but doesn't contain "${expectText}"` };
      } else {
        return { url, ok: true, status: res.status, ms, attempts: i, checkedAt: Date.now() };
      }
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      const why =
        e.name === "TimeoutError" ? `No response within ${Math.round((opts.timeoutMs ?? 10_000) / 1000)}s`
        : e.cause?.code === "ENOTFOUND" ? "Domain not found (DNS)"
        : e.cause?.code === "ECONNREFUSED" ? "Connection refused"
        : e.cause?.code?.startsWith("ERR_TLS") || /certificate/i.test(e.cause?.message ?? "") ? `HTTPS certificate problem (${e.cause?.code ?? e.cause?.message})`
        : e.cause?.message ?? e.message ?? String(err);
      last = { url, ok: false, ms: Date.now() - t0, attempts: i, checkedAt: Date.now(), error: why };
    }
    if (i < attempts) await sleep(opts.delayMs ?? 5000);
  }
  return last;
}
