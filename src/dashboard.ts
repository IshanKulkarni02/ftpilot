import * as vscode from "vscode";
import * as path from "path";
import { DeployState } from "./progress";
import { Metrics, FileRec } from "./metrics";
import { gauge, timeSeries, lanes, sizeVsTime, timeHistogram, phaseTimeline, rates, percentile, CHART_CSS } from "./charts";

import { esc, formatMs as fmtMs, formatBytes as fmtBytes } from "./format";

function table(head: string[], rows: string[][], numericFrom = 1): string {
  if (!rows.length) return `<p class="muted">Nothing yet.</p>`;
  return `<table><thead><tr>${head.map((h, i) => `<th${i >= numericFrom ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i >= numericFrom ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/** Uploads (and rollback restores) are what the speed analysis is about; snapshot downloads and deletes are shown in the lanes only. */
const transfer = (f: FileRec) => f.kind === "upload" || f.kind === "restore";
const KIND_NAME: Record<FileRec["kind"], string> = { upload: "upload", remove: "delete", snapshot: "rollback copy", restore: "restore" };

/** Bytes/sec in the most readable unit for this run (tiny test files would read 0.00 MB/s). */
function throughputUnit(peakMbPerSec: number): { label: string; scale: number } {
  return peakMbPerSec >= 1 ? { label: "MB/s", scale: 1 } : { label: "KB/s", scale: 1024 };
}

/** Every dashboard section as HTML, keyed by section id. Used live (webview) and by the report. */
export function dashboardSections(s: DeployState, m: Metrics): Record<string, string> {
  const now = (s.finishedAt ?? Date.now()) - s.startedAt;
  const { files: fps, mb } = rates(m.samples);
  const lastFps = fps.length ? fps[fps.length - 1].v : 0;
  const lastMb = mb.length ? mb[mb.length - 1].v : 0;
  const peakFps = Math.max(0, ...fps.map((p) => p.v));
  const peakMb = Math.max(0, ...mb.map((p) => p.v));
  const moved = m.files.filter(transfer);
  const recent = moved.slice(-50).map((f) => f.t1 - f.t0);
  const avgRecent = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const allMs = moved.map((f) => f.t1 - f.t0).sort((a, b) => a - b);
  const unit = throughputUnit(peakMb);
  const done = s.doneOps + (s.snapDone ?? 0);
  const total = s.totalOps + (s.snapTotal ?? 0);
  const pct = total ? Math.round((done / total) * 100) : s.phase === "done" ? 100 : 0;
  const running = s.phase !== "done" && s.phase !== "failed";
  const eta = running && lastFps > 0 && total > done ? `~${fmtMs(((total - done) / lastFps) * 1000)} left` : running ? "estimating…" : fmtMs(now) + " total";
  const errors = (s.retries ?? 0) + (s.error ? 1 : 0) + s.targets.filter((t) => t.health && !t.health.ok).length;

  // Only present when "Save a rollback copy before each deploy" is on for this run — shown as
  // its own gauge (not folded into the combined Progress %) so the backup step is visible on
  // its own, not just implied by a slower overall bar.
  const takingBackup = s.phase === "snapshot";
  const backupDone = s.snapDone ?? 0;
  const backupTotal = s.snapTotal ?? 0;
  const backupGauge = backupTotal > 0
    ? [gauge({
        label: "Backup (rollback copy)", value: backupDone, max: backupTotal, display: `${backupDone} / ${backupTotal}`,
        sub: takingBackup ? "downloading now…" : backupDone >= backupTotal ? "done" : "pending", status: takingBackup ? "warn" : backupDone >= backupTotal ? "ok" : undefined,
      })]
    : [];

  const gauges = [
    gauge({ label: "Files / sec", value: lastFps, max: Math.max(10, peakFps * 1.2), display: lastFps.toFixed(1), sub: `peak ${peakFps.toFixed(1)}` }),
    gauge({ label: unit.label.replace("/", " / "), value: lastMb, max: Math.max(peakMb * 1.2, 1e-9), display: (lastMb * unit.scale).toFixed(1), sub: `peak ${(peakMb * unit.scale).toFixed(1)}` }),
    gauge({ label: "Connections", value: s.connections, max: s.maxConnections ?? 8, display: `${s.connections} / ${s.maxConnections ?? 8}`, sub: `peak ${s.peakConnections ?? 0}` }),
    gauge({ label: "Progress", value: pct, max: 100, display: `${pct}%`, sub: `${done} / ${total} · ${eta}` }),
    ...backupGauge,
    gauge({ label: "Avg file time", value: avgRecent, max: Math.max(500, percentile(allMs, 0.95) * 1.5), display: avgRecent ? fmtMs(avgRecent) : "–", sub: allMs.length ? `median ${fmtMs(percentile(allMs, 0.5))}` : "last 50 files" }),
    gauge({ label: "Errors / retries", value: errors, max: 10, display: String(errors), sub: s.error ? "run failed" : `${s.retries ?? 0} retries`, status: s.error ? "crit" : errors ? "warn" : "ok" }),
  ].join("");

  const markers = s.events
    .filter((e) => e.kind === "limit" || e.kind === "scale-down" || e.kind === "error")
    .map((e) => ({ t: e.t - s.startedAt, label: e.message }));

  // Per-target rollup from metrics.
  const byTarget = new Map<string, { bytes: number; ms: number; n: number }>();
  for (const f of moved.filter((f) => f.kind === "upload" || f.kind === "restore")) {
    const r = byTarget.get(f.target) ?? { bytes: 0, ms: 0, n: 0 };
    r.bytes += f.bytes; r.ms += f.t1 - f.t0; r.n++;
    byTarget.set(f.target, r);
  }
  const targetRows = s.targets.map((t) => {
    const r = byTarget.get(t.name);
    const speed = t.uploadMs && t.uploaded ? (t.uploaded / (t.uploadMs / 1000)).toFixed(1) : "–";
    return [
      `<strong>${esc(t.name)}</strong><div class="muted">${esc(t.status)}</div>`,
      `${t.uploaded} / ${t.toUpload}`, String(t.removed), String(t.unchanged), fmtBytes(r?.bytes ?? 0),
      t.buildMs !== undefined ? fmtMs(t.buildMs) : "–", t.uploadMs !== undefined ? fmtMs(t.uploadMs) : "–", speed,
      t.health ? (t.health.ok ? `HTTP ${t.health.status}, ${t.health.ms} ms` : `<span class="bad">${esc(t.health.error)}</span>`) : "–",
    ];
  });

  const byType = new Map<string, { n: number; bytes: number; ms: number }>();
  for (const f of moved) {
    const ext = path.extname(f.rel).toLowerCase() || "(none)";
    const r = byType.get(ext) ?? { n: 0, bytes: 0, ms: 0 };
    r.n++; r.bytes += f.bytes; r.ms += f.t1 - f.t0;
    byType.set(ext, r);
  }
  const typeRows = [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)
    .map(([ext, r]) => [esc(ext), String(r.n), fmtBytes(r.bytes), fmtMs(r.ms / r.n)]);

  const fileRow = (f: FileRec) => [`<code>${esc(f.rel)}</code><div class="muted">${esc(f.target)} · ${KIND_NAME[f.kind]} · connection #${f.worker + 1}</div>`, fmtBytes(f.bytes), fmtMs(f.t1 - f.t0)];
  const slowest = [...moved].sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0)).slice(0, 10).map(fileRow);
  const largest = [...moved].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map(fileRow);

  const events = [...s.events].reverse().slice(0, 60)
    .map((e) => `<li><span class="muted">${esc(fmtMs(e.t - s.startedAt))}</span> <span class="ev ev-${esc(e.kind)}">${esc(e.kind)}</span> ${esc(e.message)}</li>`).join("");

  // A visible, human-readable line for the backup step itself (not just the gauge/chart numbers),
  // and the same Roll Back action the sidebar offers, so Geek Mode doesn't need a switch back to
  // the sidebar to see or undo what a deploy did. Kept forgiving like the sidebar's own button:
  // the rollback command re-checks eligibility itself and reports a clear message if it's stale.
  const actions = takingBackup
    ? `<div class="backup-note"><span class="codicon codicon-archive"></span> Backing up the server's current files before uploading, so this deploy can be undone (${backupDone} / ${backupTotal})…</div>`
    : !running && s.rollbackId
      ? `<button class="action-btn ${s.healthFailed || s.phase === "failed" ? "danger" : "secondary"}" data-action="rollback"><span class="codicon codicon-discard"></span> Roll Back This Deploy</button>`
      : "";

  const session: [string, string][] = [
    ["Run", s.kind + (s.dryRun ? " (preview)" : "")],
    ["Status", s.phase + (s.cancelled ? " (cancelled)" : "")],
    ["Server", s.host],
    ["Branch", `${s.branch ?? "?"}${s.commit ? ` @ ${s.commit}` : ""}`],
    ["Strategy", s.strategy],
    ["Started", new Date(s.startedAt).toLocaleTimeString()],
    ["Elapsed", fmtMs(now)],
    ["Transferred", `${fmtBytes(s.doneBytes)} of ${fmtBytes(s.totalBytes)}`],
    ["Files uploaded", String(moved.length)],
    ["Rollback copies", String(m.files.filter((f) => f.kind === "snapshot").length)],
    ["Deletes", String(m.files.filter((f) => f.kind === "remove").length)],
    ["Peak connections", String(s.peakConnections ?? 0)],
    ["p50 / p95 / max file", allMs.length ? `${fmtMs(percentile(allMs, 0.5))} / ${fmtMs(percentile(allMs, 0.95))} / ${fmtMs(allMs[allMs.length - 1])}` : "–"],
  ];

  return {
    gauges,
    actions,
    speed: timeSeries({ label: "files/s", points: fps, xMax: now, fmt: (v) => v.toFixed(v < 10 ? 1 : 0) }),
    mb: timeSeries({ label: unit.label, points: mb.map((p) => ({ t: p.t, v: p.v * unit.scale })), xMax: now, fmt: (v) => v.toFixed(v < 10 ? 1 : 0), color: "var(--s1)" }),
    mbTitle: `Throughput (${unit.label})`,
    conns: timeSeries({ label: "connections", points: m.samples.map((p) => ({ t: p.t, v: p.connections })), xMax: now, fmt: (v) => String(Math.round(v)), step: true, color: "var(--ink2)", markers }),
    // Full-width panel: a wider viewBox keeps its text at the same size as the other charts.
    lanes: lanes(m.files, now, 1120),
    scatter: sizeVsTime(m.files),
    hist: timeHistogram(m.files),
    phases: phaseTimeline(m.phases, now),
    targets: table(["Target", "Uploaded", "Removed", "Same", "Bytes", "Build", "Upload", "Files/s", "Health"], targetRows),
    types: table(["Type", "Files", "Bytes", "Avg time"], typeRows),
    slowest: table(["Slowest files", "Size", "Time"], slowest),
    largest: table(["Largest files", "Size", "Time"], largest),
    events: events ? `<ul class="events">${events}</ul>` : `<p class="muted">No connection events yet.</p>`,
    build: m.buildLines.length ? `<pre>${esc(m.buildLines.slice(-60).join("\n"))}</pre>` : `<p class="muted">No build output.</p>`,
    session: `<dl>${session.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`,
    title: `${s.dryRun ? "Preview" : s.kind === "rollback" ? "Rollback" : "Deploy"}: ${running ? "running" : s.phase === "done" ? (s.healthFailed ? "done, health check failed" : "done") : "failed"}`,
  };
}

/** Palette slots 1–4 from the validated reference palette, stepped per theme. */
const THEME_CSS = `
  body { --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --warn:#fab219; --crit:#d03b3b; --on-fill:#fff;
    --surface: var(--vscode-editor-background); --ink: var(--vscode-foreground); --ink2: var(--vscode-descriptionForeground);
    --muted: var(--vscode-descriptionForeground); --grid: var(--vscode-editorWidget-border, rgba(128,128,128,.18));
    --axis: var(--vscode-editorWidget-border, rgba(128,128,128,.35)); --track: rgba(42,120,214,.16); }
  body.vscode-dark, body.vscode-high-contrast { --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --track: rgba(57,135,229,.22); }
`;

const PAGE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 16px 24px; font-family: var(--vscode-font-family); font-size: 13px; color: var(--ink); background: var(--surface); }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  header .spacer { flex: 1; }
  h1 { font-size: 16px; font-weight: 600; margin: 0; }
  .icon-btn { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: none; color: var(--ink2); cursor: pointer; padding: 2px 4px; border-radius: 3px; font-family: inherit; font-size: 12px; }
  .icon-btn:hover { color: var(--ink); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .actions:empty { display: none; }
  .actions { margin-bottom: 12px; }
  .backup-note { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--grid); border-radius: 2px; background: var(--vscode-editorWidget-background, transparent); color: var(--ink2); font-size: 12px; }
  .action-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; font-family: inherit; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .action-btn.danger { background: var(--vscode-errorForeground); color: #fff; }
  h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-sideBarSectionHeader-foreground, var(--ink)); margin: 0 0 8px; }
  .muted { color: var(--muted); }
  .bad { color: var(--vscode-errorForeground); }
  .gauges { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-bottom: 12px; }
  /* min(420px, 100%) instead of a bare 420px: in the sidebar tab the container can be far
     narrower than 420px, and a bare minmax() track floor forces horizontal scrolling instead
     of just collapsing to one column the way it does in the full-screen editor tab. */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 12px; }
  .panel { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); border-radius: 2px; padding: 10px 12px; min-width: 0; background: var(--vscode-editorWidget-background, transparent); }
  .panel.wide { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  th { color: var(--ink2); font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  code, pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  code { word-break: break-all; }
  pre { margin: 0; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--ink2); }
  ul.events { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow: auto; font-size: 12px; }
  ul.events li { padding: 2px 0; }
  .ev { display: inline-block; min-width: 72px; font-size: 11px; color: var(--ink2); }
  .ev-limit, .ev-error { color: var(--vscode-errorForeground); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 0; font-size: 12px; }
  dt { color: var(--ink2); } dd { margin: 0; font-variant-numeric: tabular-nums; }
`;

/**
 * Geek Mode: a live dashboard for the running (or last) deploy/backup/rollback, shown two ways
 * from one source of truth — a persistent tab in the FTPilot sidebar (visible by default
 * whenever Geek Mode is on, so nothing needs to be opened to see it) and, on request, the same
 * view "popped out" full screen into an editor tab (`open()` / the sidebar's own button).
 */
export class Dashboard implements vscode.Disposable, vscode.WebviewViewProvider {
  static readonly viewType = "ftpilotDashboardView";

  private panel?: vscode.WebviewPanel;
  private view?: vscode.WebviewView;
  private last?: { s: DeployState; m: Metrics };
  private timer?: NodeJS.Timeout;

  constructor(private context: vscode.ExtensionContext) {}

  static enabled(): boolean {
    return vscode.workspace.getConfiguration("ftpilot").get<boolean>("geekMode", false);
  }

  /** Called on every progress emit. Pushes to whichever of the sidebar tab / full-screen tab are currently open. */
  update(s: DeployState, m?: Metrics): void {
    if (!m) return;
    this.last = { s, m };
    // ~2 fps is plenty for charts and keeps SVG re-rendering cheap.
    if ((this.panel || this.view) && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.pushAll(); }, 500);
  }

  /** Opens (or reveals) the full-screen editor-tab copy of the dashboard. */
  open(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      this.pushTo(this.panel.webview);
      return;
    }
    this.panel = vscode.window.createWebviewPanel("ftpilotDashboard", "FTPilot Dashboard", { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.codiconRoot()],
    });
    this.panel.webview.html = this.shell(this.panel.webview, false);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.pushTo(this.panel.webview);
  }

  /** vscode.WebviewViewProvider: resolves the sidebar tab. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.codiconRoot()] };
    webviewView.webview.html = this.shell(webviewView.webview, true);
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    webviewView.onDidDispose(() => { this.view = undefined; });
    this.pushTo(webviewView.webview);
  }

  private handleMessage(msg: { type?: string }): void {
    if (msg?.type === "rollback") {
      if (this.last?.s.rollbackId) void vscode.commands.executeCommand("ftpilot.rollback", { snapshotId: this.last.s.rollbackId });
    } else if (msg?.type === "openFull") {
      this.open();
    }
  }

  private codiconRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "@vscode", "codicons", "dist");
  }

  private pushAll(): void {
    if (this.panel) this.pushTo(this.panel.webview);
    if (this.view) this.pushTo(this.view.webview);
  }

  private pushTo(webview: vscode.Webview): void {
    if (!this.last) {
      void webview.postMessage({ type: "sections", sections: { title: "No deploy yet", gauges: `<p class="muted">Start a deploy, preview, backup or rollback; its live metrics appear here.</p>` } });
      return;
    }
    void webview.postMessage({ type: "sections", sections: dashboardSections(this.last.s, this.last.m) });
  }

  private shell(webview: vscode.Webview, isSidebar: boolean): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const codiconCss = webview.asWebviewUri(vscode.Uri.joinPath(this.codiconRoot(), "codicon.css"));
    const box = (id: string, title: string, wide = false) => `<section class="panel${wide ? " wide" : ""}"><h2>${title}</h2><div data-s="${id}"></div></section>`;
    const fullScreenBtn = isSidebar
      ? `<button class="icon-btn" data-action="openFull" title="Open in full screen"><span class="codicon codicon-screen-full"></span></button>`
      : "";
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconCss}">
<style>${THEME_CSS}${PAGE_CSS}${CHART_CSS}</style></head><body>
<header><h1>FTPilot Dashboard</h1><span class="muted" data-s="title"></span><span class="spacer"></span>${fullScreenBtn}</header>
<div class="actions" data-s="actions"></div>
<div class="gauges" data-s="gauges"></div>
<div class="grid">
  ${box("speed", "Files per second")}
  <section class="panel"><h2 data-s="mbTitle">Throughput</h2><div data-s="mb"></div></section>
  ${box("conns", "Connections (markers: back-offs)")}
  ${box("phases", "Where the time went")}
  ${box("lanes", "Connection lanes", true)}
  ${box("scatter", "Time vs file size")}
  ${box("hist", "File time distribution")}
  ${box("targets", "Targets", true)}
  ${box("types", "By file type")}
  ${box("session", "Session")}
  ${box("slowest", "Slowest 10")}
  ${box("largest", "Largest 10")}
  ${box("events", "Connection events")}
  ${box("build", "Build output (tail)")}
</div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) vscodeApi.postMessage({ type: btn.dataset.action });
  });
  // Cheap fingerprint of the last HTML per section (not a second full copy of it in the DOM).
  const seen = {};
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return s.length + ":" + h; }
  window.addEventListener("message", (e) => {
    if (e.data.type !== "sections") return;
    for (const [id, html] of Object.entries(e.data.sections)) {
      const el = document.querySelector('[data-s="' + id + '"]');
      const sig = hash(html);
      if (!el || seen[id] === sig) continue;
      seen[id] = sig;
      // Keep scroll position of scrollable panes across updates.
      const sc = el.querySelector("pre, ul.events"), top = sc ? sc.scrollTop : 0;
      el.innerHTML = html;
      const sc2 = el.querySelector("pre, ul.events"); if (sc2) sc2.scrollTop = id === "build" ? sc2.scrollHeight : top;
    }
  });
</script></body></html>`;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.panel?.dispose();
  }
}
