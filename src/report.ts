import * as fs from "fs";
import * as path from "path";
import { configDir } from "./config";
import { DeployState } from "./progress";

const MAX_FILES_LISTED = 2000;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function formatMs(ms?: number): string {
  if (ms === undefined) return "-";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fileList(title: string, files: string[]): string {
  if (!files.length) return "";
  const shown = files.slice(0, MAX_FILES_LISTED);
  const more = files.length - shown.length;
  return `<h4>${esc(title)} (${files.length})</h4><ul class="files">${shown.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>${more > 0 ? `<p class="muted">…and ${more} more.</p>` : ""}`;
}

/** Full build + upload output for one run, next to the reports (same gitignored folder). */
export function writeLog(workspaceRoot: string, s: DeployState, text: string): string {
  const dir = reportsDir(workspaceRoot);
  const file = path.join(dir, `deploy-${stampOf(s)}.log`);
  const header = `Result: ${s.phase === "done" ? "SUCCEEDED" : "FAILED"}${s.error ? ` — ${s.error.message}` : ""}

`;
  fs.writeFileSync(file, header + text, "utf8");
  return file;
}

function reportsDir(workspaceRoot: string): string {
  const dir = path.join(configDir(workspaceRoot), "reports");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf8");
  return dir;
}

function stampOf(s: DeployState): string {
  return new Date(s.startedAt).toISOString().replace(/[:T]/g, "-").slice(0, 19);
}

/**
 * Writes a self-contained, print-ready HTML report (open in a browser, Print → Save as PDF)
 * to .ftbdeploy/reports/, which gets its own "*" .gitignore so reports never get committed.
 */
export function writeReport(workspaceRoot: string, s: DeployState): string {
  const started = new Date(s.startedAt);
  const file = path.join(reportsDir(workspaceRoot), `deploy-${stampOf(s)}.html`);
  const ok = s.phase === "done";
  const totals = s.targets.reduce(
    (a, t) => ({ up: a.up + t.uploaded, rm: a.rm + t.removed, same: a.same + t.unchanged }),
    { up: 0, rm: 0, same: 0 }
  );
  const kindLabel = s.kind === "full" ? "Full re-upload" : s.kind === "target" ? "Single target" : "Deploy all targets";

  const rows = s.targets.map((t) => `
      <tr>
        <td><strong>${esc(t.name)}</strong><div class="muted">${esc(t.localDir)} → ${esc(t.remoteDir)}</div></td>
        <td class="st st-${t.status}">${esc(t.status)}</td>
        <td>${esc(t.buildCommand || "(none)")}<div class="muted">${formatMs(t.buildMs)}</div></td>
        <td class="num">${t.uploaded}${t.toUpload !== t.uploaded ? ` / ${t.toUpload}` : ""}</td>
        <td class="num">${t.removed}</td>
        <td class="num">${t.unchanged}</td>
        <td>${formatMs(t.uploadMs)}</td>
        <td>${t.restarted ? "yes" : "-"}</td>
      </tr>`).join("");

  const details = s.targets.map((t) => {
    const lists = fileList("Uploaded", t.uploadedFiles) + fileList("Removed from server", t.removedFiles);
    return lists ? `<section class="target"><h3>${esc(t.name)}</h3>${lists}</section>` : "";
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>FTPilot report: ${esc(s.project)} ${esc(started.toLocaleString())}</title>
<style>
  :root { --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --ok:#1a7f37; --bad:#cf222e; --bg-ok:#dafbe1; --bg-bad:#ffebe9; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--fg); max-width: 960px; margin: 24px auto; padding: 0 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 8px; } h3 { font-size: 14px; margin: 16px 0 4px; } h4 { font-size: 12px; margin: 10px 0 4px; color: var(--muted); }
  .muted { color: var(--muted); font-size: 12px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-weight: 600; font-size: 12px; }
  .badge.ok { background: var(--bg-ok); color: var(--ok); } .badge.bad { background: var(--bg-bad); color: var(--bad); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 12px 0; }
  dt { color: var(--muted); } dd { margin: 0; }
  .stats { display: flex; gap: 24px; margin: 12px 0; } .stats div { font-size: 22px; font-weight: 600; } .stats span { display: block; font-size: 12px; font-weight: 400; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; } .num { text-align: right; font-variant-numeric: tabular-nums; }
  .st-done { color: var(--ok); } .st-failed { color: var(--bad); font-weight: 600; }
  .error { border: 1px solid var(--bad); background: var(--bg-bad); border-radius: 6px; padding: 10px 12px; }
  pre { white-space: pre-wrap; word-break: break-word; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 8px 0 0; }
  ul.files { columns: 2; column-gap: 24px; margin: 0; padding-left: 18px; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .hint { margin-top: 32px; } @media print { .hint { display: none; } body { margin: 0; max-width: none; } section.target { break-inside: avoid-page; } }
</style></head>
<body>
  <h1>FTPilot deploy report <span class="badge ${ok ? "ok" : "bad"}">${ok ? "Succeeded" : "Failed"}</span></h1>
  <div class="muted">${esc(s.project)} · ${esc(started.toLocaleString())}</div>
  <div class="stats">
    <div>${totals.up}<span>files uploaded</span></div>
    <div>${totals.rm}<span>removed</span></div>
    <div>${totals.same}<span>unchanged</span></div>
    <div>${formatMs((s.finishedAt ?? Date.now()) - s.startedAt)}<span>total time</span></div>
  </div>
  <dl>
    <dt>Type</dt><dd>${esc(kindLabel)}</dd>
    <dt>Branch</dt><dd>${esc(s.branch ?? "(not a git repo)")}${s.commit ? ` @ ${esc(s.commit)}` : ""}</dd>
    <dt>Server</dt><dd>${esc(s.host)}</dd>
    <dt>Strategy</dt><dd>${s.strategy === "full" ? "Full (overwrite remote files)" : "Incremental (changed files only)"}</dd>
    <dt>Started</dt><dd>${esc(started.toLocaleString())}</dd>
    <dt>Finished</dt><dd>${s.finishedAt ? esc(new Date(s.finishedAt).toLocaleString()) : "-"}</dd>
  </dl>
  ${s.error ? `<h2>Error</h2><div class="error"><strong>${esc(s.error.message)}</strong>${s.error.detail ? `<pre>${esc(s.error.detail)}</pre>` : ""}</div>` : ""}
  <h2>Targets</h2>
  <table>
    <thead><tr><th>Target</th><th>Status</th><th>Build</th><th class="num">Uploaded</th><th class="num">Removed</th><th class="num">Unchanged</th><th>Upload time</th><th>Restarted</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${details ? `<h2>Files</h2>${details}` : ""}
  ${s.logPath ? `<p class="muted">Full log: <a href="${esc(path.basename(s.logPath))}">${esc(path.basename(s.logPath))}</a></p>` : ""}
  <p class="hint muted">To save as PDF: File → Print (Cmd/Ctrl+P) → Save as PDF.</p>
</body></html>`;
  fs.writeFileSync(file, html, "utf8");
  return file;
}
