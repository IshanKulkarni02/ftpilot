/**
 * SVG chart builders shared by the Geek Mode dashboard (live) and the HTML report (static).
 * They return markup that references CSS custom properties for every colour, so each host
 * page decides light/dark: --s1..--s4 (categorical, fixed order), --ink / --ink2 / --muted
 * (text), --grid / --axis (chrome), --track (meter track), --warn / --crit (status).
 * Every mark carries a <title>, which is the hover tooltip in both the webview and a browser.
 */
import type { FileRec, PhaseRec, Sample } from "./metrics";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s < 10 ? s.toFixed(1) : Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 1 : 0);
}

/** Clean axis steps (1 / 2 / 2.5 / 5 × 10^k) covering 0..max. */
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function timeTicks(xMax: number, count = 5): number[] {
  const secs = niceTicks(Math.max(1, xMax / 1000), count);
  return secs.map((s) => s * 1000);
}

const PAD = { l: 44, r: 16, t: 12, b: 24 };

function frame(w: number, h: number, body: string, label: string): string {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMinYMin meet">${body}</svg>`;
}

function yAxis(ticks: number[], y: (v: number) => number, x0: number, x1: number, fmt: (v: number) => string): string {
  return ticks
    .map((t) => `<line x1="${x0}" x2="${x1}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/>` +
      `<text x="${x0 - 6}" y="${y(t) + 3}" text-anchor="end" class="tick">${esc(fmt(t))}</text>`)
    .join("");
}

function xTimeAxis(xMax: number, x: (v: number) => number, yBase: number): string {
  return timeTicks(xMax)
    .filter((t) => t <= xMax * 1.001)
    .map((t) => `<text x="${x(t)}" y="${yBase + 16}" text-anchor="middle" class="tick">${esc(fmtMs(t).replace(" ms", "ms"))}</text>`)
    .join("") + `<line x1="${x(0)}" x2="${x(xMax)}" y1="${yBase}" y2="${yBase}" stroke="var(--axis)" stroke-width="1"/>`;
}

/** Downsample to at most n points, keeping the last one (the "now" value). */
function thin<T>(pts: T[], n: number): T[] {
  if (pts.length <= n) return pts;
  const step = pts.length / n;
  const out: T[] = [];
  for (let i = 0; i < n - 1; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}

/* ---------------- Meter (gauge) ---------------- */

export interface GaugeSpec {
  label: string;
  value: number;
  max: number;
  display: string;
  sub?: string;
  /** Severity drives the fill: accent normally, warn/crit when something is off. */
  status?: "ok" | "warn" | "crit";
}

export function gauge(g: GaugeSpec): string {
  const w = 160, h = 104, cx = 80, cy = 84, r = 64;
  const frac = Math.max(0, Math.min(1, g.max > 0 ? g.value / g.max : 0));
  const a0 = Math.PI, a1 = Math.PI + Math.PI * frac; // 180° arc, left -> right
  const pt = (a: number) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  const fill = g.status === "crit" ? "var(--crit)" : g.status === "warn" ? "var(--warn)" : "var(--s1)";
  const arc = frac > 0.001
    ? `<path d="M ${pt(a0)} A ${r} ${r} 0 0 1 ${pt(a1)}" fill="none" stroke="${fill}" stroke-width="10" stroke-linecap="round"/>`
    : "";
  return `<div class="gauge">
    <svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(g.label)}: ${esc(g.display)}">
      <title>${esc(g.label)}: ${esc(g.display)}${g.sub ? ` (${esc(g.sub)})` : ""}</title>
      <path d="M ${pt(Math.PI)} A ${r} ${r} 0 0 1 ${pt(2 * Math.PI)}" fill="none" stroke="var(--track)" stroke-width="10" stroke-linecap="round"/>
      ${arc}
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" class="gauge-value">${esc(g.display)}</text>
    </svg>
    <div class="gauge-label">${esc(g.label)}</div>
    ${g.sub ? `<div class="gauge-sub">${esc(g.sub)}</div>` : ""}
  </div>`;
}

/* ---------------- Line / step chart over time ---------------- */

export interface SeriesSpec {
  label: string;
  points: { t: number; v: number }[];
  xMax: number;
  fmt: (v: number) => string;
  step?: boolean;
  color?: string;
  /** Optional event markers (e.g. connection limit hit). */
  markers?: { t: number; label: string }[];
}

export function timeSeries(s: SeriesSpec, w = 560, h = 170): string {
  const pts = thin(s.points, 300);
  if (!pts.length) return empty(w, h, "No data yet");
  const color = s.color ?? "var(--s1)";
  const yMax = Math.max(...pts.map((p) => p.v), 0);
  const ticks = niceTicks(yMax || 1);
  const top = ticks[ticks.length - 1];
  const x = (t: number) => PAD.l + ((w - PAD.l - PAD.r) * t) / Math.max(1, s.xMax);
  const y = (v: number) => PAD.t + (h - PAD.t - PAD.b) * (1 - v / top);
  const base = y(0);
  let d = "";
  pts.forEach((p, i) => {
    if (i === 0) d = `M ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
    else if (s.step) d += ` H ${x(p.t).toFixed(1)} V ${y(p.v).toFixed(1)}`;
    else d += ` L ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
  });
  const last = pts[pts.length - 1];
  const area = `${d} V ${base} H ${x(pts[0].t).toFixed(1)} Z`;
  const hits = pts.map((p, i) => {
    const x0 = i === 0 ? x(p.t) : (x(pts[i - 1].t) + x(p.t)) / 2;
    const x1 = i === pts.length - 1 ? x(p.t) + 2 : (x(p.t) + x(pts[i + 1].t)) / 2;
    return `<rect x="${x0.toFixed(1)}" y="${PAD.t}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${(base - PAD.t).toFixed(1)}" fill="transparent"><title>${esc(fmtMs(p.t))}: ${esc(s.fmt(p.v))} ${esc(s.label)}</title></rect>`;
  }).join("");
  const markers = (s.markers ?? []).map((m) =>
    `<line x1="${x(m.t)}" x2="${x(m.t)}" y1="${PAD.t}" y2="${base}" stroke="var(--warn)" stroke-width="1"><title>${esc(fmtMs(m.t))}: ${esc(m.label)}</title></line>`).join("");
  const body =
    yAxis(ticks, y, PAD.l, w - PAD.r, s.fmt) +
    xTimeAxis(s.xMax, x, base) +
    `<path d="${area}" fill="${color}" opacity="0.1"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    markers +
    `<circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>` +
    hits;
  return frame(w, h, body, s.label);
}

/* ---------------- Connection lanes ---------------- */

const KIND_COLOR: Record<FileRec["kind"], string> = { upload: "var(--s1)", remove: "var(--muted)", snapshot: "var(--s3)", restore: "var(--s4)" };
const KIND_LABEL: Record<FileRec["kind"], string> = { upload: "Upload", remove: "Delete", snapshot: "Rollback copy", restore: "Restore" };

export function legend(items: { label: string; color: string }[]): string {
  return `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`).join("")}</div>`;
}

export function lanes(files: FileRec[], xMax: number, w = 560): string {
  if (!files.length) return empty(w, 80, "No transfers yet");
  const workers = Math.max(...files.map((f) => f.worker)) + 1;
  const row = 14, gap = 4;
  const h = PAD.t + workers * (row + gap) + PAD.b;
  const x = (t: number) => PAD.l + ((w - PAD.l - PAD.r) * t) / Math.max(1, xMax);
  const rows = Array.from({ length: workers }, (_, i) =>
    `<text x="${PAD.l - 6}" y="${PAD.t + i * (row + gap) + row - 3}" text-anchor="end" class="tick">#${i + 1}</text>`).join("");
  const rects = files.map((f) => {
    const x0 = x(f.t0);
    // 1px gap keeps back-to-back files distinguishable.
    const wd = Math.max(1, x(f.t1) - x0 - 1);
    return `<rect x="${x0.toFixed(1)}" y="${PAD.t + f.worker * (row + gap)}" width="${wd.toFixed(1)}" height="${row}" fill="${KIND_COLOR[f.kind]}"><title>${esc(KIND_LABEL[f.kind])} ${esc(f.rel)} · ${esc(fmtBytes(f.bytes))} · ${esc(fmtMs(f.t1 - f.t0))} · connection #${f.worker + 1}</title></rect>`;
  }).join("");
  const kinds = [...new Set(files.map((f) => f.kind))];
  return legend(kinds.map((k) => ({ label: KIND_LABEL[k], color: KIND_COLOR[k] }))) +
    frame(w, h, rows + rects + xTimeAxis(xMax, x, h - PAD.b), "Connection activity over time");
}

/* ---------------- Time vs size scatter ---------------- */

export function sizeVsTime(files: FileRec[], w = 560, h = 200): string {
  const pts = thin(files.filter((f) => f.kind === "upload" || f.kind === "restore"), 2000);
  if (!pts.length) return empty(w, h, "No transfers yet");
  const lx = (b: number) => Math.log10(Math.max(1, b));
  const xMaxL = Math.max(3, Math.ceil(Math.max(...pts.map((f) => lx(f.bytes)))));
  const ms = pts.map((f) => f.t1 - f.t0).sort((a, b) => a - b);
  // Clip the y-axis at the 99th percentile so one outlier doesn't flatten the rest.
  const yCap = ms[Math.floor(ms.length * 0.99)] || ms[ms.length - 1] || 1;
  const ticks = niceTicks(yCap);
  const top = ticks[ticks.length - 1];
  const x = (b: number) => PAD.l + ((w - PAD.l - PAD.r) * lx(b)) / xMaxL;
  const y = (v: number) => PAD.t + (h - PAD.t - PAD.b) * (1 - Math.min(v, top) / top);
  const base = y(0);
  const xTicks = Array.from({ length: xMaxL + 1 }, (_, i) => 10 ** i)
    .map((b) => `<text x="${x(b)}" y="${base + 16}" text-anchor="middle" class="tick">${esc(fmtBytes(b))}</text>`).join("");
  const dots = pts.map((f) => {
    const v = f.t1 - f.t0;
    return `<circle cx="${x(f.bytes).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${KIND_COLOR[f.kind]}" fill-opacity="0.55" stroke="var(--surface)" stroke-width="1"><title>${esc(f.rel)} · ${esc(fmtBytes(f.bytes))} · ${esc(fmtMs(v))}${v > top ? " (off scale)" : ""}</title></circle>`;
  }).join("");
  const body = yAxis(ticks, y, PAD.l, w - PAD.r, (v) => fmtMs(v)) +
    `<line x1="${PAD.l}" x2="${w - PAD.r}" y1="${base}" y2="${base}" stroke="var(--axis)"/>` + xTicks + dots;
  return frame(w, h, body, "Transfer time versus file size");
}

/* ---------------- Histogram of file times ---------------- */

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function timeHistogram(files: FileRec[], w = 560, h = 170): string {
  const ms = files.filter((f) => f.kind === "upload" || f.kind === "restore").map((f) => f.t1 - f.t0).sort((a, b) => a - b);
  if (!ms.length) return empty(w, h, "No transfers yet");
  const cap = percentile(ms, 0.99) || 1;
  const bins = 24;
  const counts = new Array(bins).fill(0);
  for (const v of ms) counts[Math.min(bins - 1, Math.floor((Math.min(v, cap) / cap) * bins))]++;
  const ticks = niceTicks(Math.max(...counts));
  const top = ticks[ticks.length - 1];
  const band = (w - PAD.l - PAD.r) / bins;
  const bw = Math.min(24, band - 2);
  const y = (v: number) => PAD.t + (h - PAD.t - PAD.b) * (1 - v / top);
  const base = y(0);
  const bars = counts.map((c, i) => {
    if (!c) return "";
    const x0 = PAD.l + i * band + (band - bw) / 2, yt = y(c), r = Math.min(4, (base - yt) / 2, bw / 2);
    const lo = (cap * i) / bins, hi = (cap * (i + 1)) / bins;
    // Rounded data end (top), square at the baseline.
    return `<path d="M ${x0} ${base} V ${yt + r} Q ${x0} ${yt} ${x0 + r} ${yt} H ${x0 + bw - r} Q ${x0 + bw} ${yt} ${x0 + bw} ${yt + r} V ${base} Z" fill="var(--s1)"><title>${c} file(s) took ${esc(fmtMs(lo))}–${esc(fmtMs(hi))}${i === bins - 1 ? " or more" : ""}</title></path>`;
  }).join("");
  const xAt = (v: number) => PAD.l + ((w - PAD.l - PAD.r) * Math.min(v, cap)) / cap;
  const p50 = percentile(ms, 0.5), p95 = percentile(ms, 0.95);
  // Labels sit on the side with room, and the p95 label drops a line when it would collide.
  const mark = (v: number, label: string, row: number) => {
    const xv = xAt(v), right = xv < w - PAD.r - 90;
    return `<line x1="${xv}" x2="${xv}" y1="${PAD.t}" y2="${base}" stroke="var(--ink2)" stroke-width="1"/>` +
      `<text x="${right ? xv + 4 : xv - 4}" y="${PAD.t + 10 + row * 12}" text-anchor="${right ? "start" : "end"}" class="tick strong">${esc(label)} ${esc(fmtMs(v))}</text>`;
  };
  const collide = Math.abs(xAt(p95) - xAt(p50)) < 90;
  const xTicks = [0, cap / 2, cap].map((v) => `<text x="${xAt(v)}" y="${base + 16}" text-anchor="middle" class="tick">${esc(fmtMs(v))}</text>`).join("");
  const body = yAxis(ticks, y, PAD.l, w - PAD.r, fmtNum) + `<line x1="${PAD.l}" x2="${w - PAD.r}" y1="${base}" y2="${base}" stroke="var(--axis)"/>` +
    bars + mark(p50, "median", 0) + mark(p95, "p95", collide ? 1 : 0) + xTicks;
  return frame(w, h, body, "Distribution of per-file transfer times");
}

/* ---------------- Phase timeline (Gantt) ---------------- */

// Same activity, same colour everywhere: upload = s1 in lanes, scatter and timeline alike.
const PHASE_COLOR: Record<PhaseRec["name"], string> = {
  build: "var(--s2)", compare: "var(--muted)", snapshot: "var(--s3)", upload: "var(--s1)", restore: "var(--s4)", check: "var(--ink2)",
};
const PHASE_LABEL: Record<PhaseRec["name"], string> = {
  build: "Build", compare: "Compare", snapshot: "Rollback copy", upload: "Upload", restore: "Restore", check: "Health check",
};

export function phaseTimeline(phases: PhaseRec[], nowMs: number, w = 560): string {
  if (!phases.length) return empty(w, 60, "Starting…");
  const rowsKeys = [...new Set(phases.map((p) => p.target ?? "All targets"))];
  const row = 18, gap = 6, labelW = 120;
  const h = PAD.t + rowsKeys.length * (row + gap) + PAD.b;
  const xMax = Math.max(nowMs, ...phases.map((p) => p.end ?? nowMs), 1);
  const x = (t: number) => labelW + ((w - labelW - PAD.r) * t) / xMax;
  const labels = rowsKeys.map((k, i) =>
    `<text x="${labelW - 8}" y="${PAD.t + i * (row + gap) + row - 5}" text-anchor="end" class="tick">${esc(k.length > 18 ? k.slice(0, 17) + "…" : k)}</text>`).join("");
  const bars = phases.map((p) => {
    const i = rowsKeys.indexOf(p.target ?? "All targets");
    const x0 = x(p.start), x1 = x(p.end ?? nowMs), wd = Math.max(2, x1 - x0 - 2); // 2px surface gap between phases
    const yy = PAD.t + i * (row + gap), r = Math.min(4, wd / 2);
    const dur = (p.end ?? nowMs) - p.start;
    const text = wd > 70 ? `<text x="${x0 + 6}" y="${yy + row - 5}" class="bar-label">${esc(PHASE_LABEL[p.name])} ${esc(fmtMs(dur))}</text>` : "";
    return `<path d="M ${x0} ${yy} H ${x0 + wd - r} Q ${x0 + wd} ${yy} ${x0 + wd} ${yy + r} V ${yy + row - r} Q ${x0 + wd} ${yy + row} ${x0 + wd - r} ${yy + row} H ${x0} Z" fill="${PHASE_COLOR[p.name]}"${p.end === undefined ? ' class="live"' : ""}><title>${esc(p.target ?? "")} ${esc(PHASE_LABEL[p.name])}: ${esc(fmtMs(dur))}${p.end === undefined ? " (running)" : ""}</title></path>${text}`;
  }).join("");
  const names = [...new Set(phases.map((p) => p.name))];
  return legend(names.map((n) => ({ label: PHASE_LABEL[n], color: PHASE_COLOR[n] }))) +
    frame(w, h, labels + bars + xTimeAxis(xMax, x, h - PAD.b), "Where the time went, per target");
}

function empty(w: number, h: number, text: string): string {
  return frame(w, h, `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="tick">${esc(text)}</text>`, text);
}

/* ---------------- Derived series ---------------- */

/** Files/sec and MB/sec per 1s sample (differences between consecutive samples). */
export function rates(samples: Sample[]): { files: { t: number; v: number }[]; mb: { t: number; v: number }[] } {
  const files: { t: number; v: number }[] = [];
  const mb: { t: number; v: number }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = Math.max(1, b.t - a.t) / 1000;
    files.push({ t: b.t, v: Math.max(0, (b.doneOps - a.doneOps) / dt) });
    mb.push({ t: b.t, v: Math.max(0, (b.doneBytes - a.doneBytes) / 1048576 / dt) });
  }
  return { files, mb };
}

/** Shared chart text/chrome styles; colours come from the host page's CSS variables. */
export const CHART_CSS = `
  svg.chart { display: block; overflow: visible; }
  svg .tick { font-size: 10px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  svg .tick.strong { fill: var(--ink2); }
  svg .bar-label { font-size: 10px; fill: var(--on-fill, #fff); pointer-events: none; }
  svg .live { opacity: 0.75; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--ink2); margin: 0 0 6px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .gauge { text-align: center; min-width: 0; }
  .gauge svg { max-width: 170px; }
  .gauge-value { font-size: 22px; font-weight: 600; fill: var(--ink); }
  .gauge-label { font-size: 12px; color: var(--ink2); margin-top: -6px; }
  .gauge-sub { font-size: 11px; color: var(--muted); }
`;
