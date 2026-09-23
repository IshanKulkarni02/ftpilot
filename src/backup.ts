import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ZipArchive } from "archiver";
import { loadConfig, configDir } from "./config";
import { getCredentials } from "./secrets";
import * as ftpClient from "./ftpClient";

export interface BackupResult {
  ok: boolean;
  message: string;
  archivePath?: string;
}

export async function runBackup(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<BackupResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
    return { ok: false, message: "No folder open." };
  }
  const workspaceRoot = folders[0].uri.fsPath;

  let config;
  try {
    config = loadConfig(workspaceRoot);
  } catch (err) {
    void vscode.window.showErrorMessage((err as Error).message);
    return { ok: false, message: (err as Error).message };
  }

  if (config.targets.length === 0) {
    void vscode.window.showWarningMessage("FTPilot: no targets configured, nothing to back up.");
    return { ok: false, message: "No targets configured." };
  }

  output.clear();
  output.show(true);

  const ftbDir = configDir(workspaceRoot);
  const backupsDir = path.join(ftbDir, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  ensureBackupsGitignored(ftbDir);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingDir = path.join(backupsDir, `.staging-${stamp}`);
  const archivePath = path.join(backupsDir, `backup-${stamp}.zip`);

  let client: Awaited<ReturnType<typeof ftpClient.connect>> | undefined;
  let currentAccount = "";

  try {
    for (let i = 0; i < config.targets.length; i++) {
      const target = config.targets[i];
      const account = target.ftpUser ?? "default";
      const creds = await getCredentials(context, workspaceRoot, account);
      if (!creds) {
        throw new Error(
          `No FTP credentials saved for account '${account}'. Run 'FTPilot: Set FTP Credentials'.`
        );
      }

      if (!client || account !== currentAccount) {
        if (client) {
          client.close();
        }
        output.appendLine(`\nConnecting to ${config.host}:${config.port} as ${creds.user}...`);
        client = await ftpClient.connect(config, creds);
        currentAccount = account;
      }

      const targetStagingDir = path.join(stagingDir, `${i}-${sanitizeName(target.name)}`);
      output.appendLine(`\n=== Backing up: ${target.name} (${target.remoteDir}) ===`);
      await ftpClient.downloadDir(client, target.remoteDir, targetStagingDir);
    }

    output.appendLine(`\nCompressing to ${path.relative(workspaceRoot, archivePath)} ...`);
    await compressDir(stagingDir, archivePath);
    fs.rmSync(stagingDir, { recursive: true, force: true });

    const sizeMb = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(1);
    const message = `Backup saved: ${path.relative(workspaceRoot, archivePath)} (${sizeMb} MB)`;
    output.appendLine(`\n${message}`);
    void vscode.window.showInformationMessage(`FTPilot: ${message}`);
    return { ok: true, message, archivePath };
  } catch (err) {
    const message = (err as Error).message;
    output.appendLine(`\nERROR: ${message}`);
    void vscode.window.showErrorMessage(`FTPilot backup failed: ${message}`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, message };
  } finally {
    if (client) {
      client.close();
    }
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "target";
}

function compressDir(sourceDir: string, destZip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destZip);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    out.on("close", () => resolve());
    out.on("error", (err: Error) => reject(err));
    archive.on("error", (err: Error) => reject(err));
    archive.pipe(out);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

/** Backups can get large and are purely local safety nets — make sure they never end up committed, regardless of the project's own .gitignore. */
function ensureBackupsGitignored(ftbDeployDir: string): void {
  const gitignorePath = path.join(ftbDeployDir, ".gitignore");
  const needed = ["backups/", "manifest.json"];
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split("\n").map((l) => l.trim());
  const missing = needed.filter((n) => !lines.includes(n));
  if (missing.length === 0) return;
  const updated = existing.trimEnd() + (existing.trim() ? "\n" : "") + missing.join("\n") + "\n";
  fs.writeFileSync(gitignorePath, updated, "utf8");
}
