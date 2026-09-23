import * as ftp from "basic-ftp";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { DeployConfig } from "./config";
import { Credentials } from "./secrets";
import { walkDir } from "./manifest";

export async function connect(
  config: DeployConfig,
  creds: Credentials
): Promise<ftp.Client> {
  const client = new ftp.Client(30_000);
  await client.access({
    host: config.host,
    port: config.port,
    user: creds.user,
    password: creds.password,
    secure: config.secure,
  });
  return client;
}

function remoteJoin(remoteDir: string, relPath: string): string {
  // Always use posix-style separators for FTP paths, regardless of host OS.
  const normalizedRel = relPath.split(path.sep).join("/");
  return `${remoteDir.replace(/\/+$/, "")}/${normalizedRel}`;
}

/**
 * Uploads the given relative paths one by one, reporting each finished file, so the UI can
 * show "37 / 120". Remote dirs are created once per run (cached), not once per file.
 */
export async function uploadFiles(
  client: ftp.Client,
  localDir: string,
  remoteDir: string,
  relPaths: string[],
  onFile: (relPath: string) => void
): Promise<void> {
  const ensured = new Set<string>();
  const home = await client.pwd();
  for (const relPath of relPaths) {
    const remotePath = remoteJoin(remoteDir, relPath);
    const dir = path.posix.dirname(remotePath);
    if (!ensured.has(dir)) {
      await client.ensureDir(dir);
      await client.cd(home);
      ensured.add(dir);
    }
    await client.uploadFrom(path.join(localDir, relPath), remotePath);
    onFile(relPath);
  }
}

export async function removeOne(
  client: ftp.Client,
  remoteDir: string,
  relPath: string
): Promise<void> {
  const remotePath = remoteJoin(remoteDir, relPath);
  try {
    await client.remove(remotePath);
  } catch {
    // already gone / never existed remotely — fine
  }
}

export async function touchRestartFile(
  client: ftp.Client,
  restartFilePath: string
): Promise<void> {
  const dir = path.posix.dirname(restartFilePath);
  await ensureRemoteDir(client, dir);
  const content = Readable.from(Buffer.from(new Date().toISOString()));
  await client.uploadFrom(content, restartFilePath);
}

/** Recursively downloads every file under remoteDir into localDestDir, preserving structure. Read-only on the server. */
export async function downloadDir(
  client: ftp.Client,
  remoteDir: string,
  localDestDir: string
): Promise<void> {
  fs.mkdirSync(localDestDir, { recursive: true });
  await client.downloadToDir(localDestDir, remoteDir);
}

async function ensureRemoteDir(client: ftp.Client, remoteDir: string): Promise<void> {
  const cwd = await client.pwd();
  await client.ensureDir(remoteDir);
  await client.cd(cwd);
}
