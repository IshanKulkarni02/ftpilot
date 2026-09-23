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

/** Uploads every file under localDir to remoteDir, overwriting as needed. Never deletes anything remote. */
export async function uploadFull(
  client: ftp.Client,
  localDir: string,
  remoteDir: string
): Promise<number> {
  await ensureRemoteDir(client, remoteDir);
  await client.uploadFromDir(localDir, remoteDir);
  return walkDir(localDir).length;
}

/** Uploads a single relative file path from localDir to remoteDir, creating remote subdirs as needed. */
export async function uploadOne(
  client: ftp.Client,
  localDir: string,
  remoteDir: string,
  relPath: string
): Promise<void> {
  const localPath = path.join(localDir, relPath);
  const remotePath = remoteJoin(remoteDir, relPath);
  const remoteFileDir = path.posix.dirname(remotePath);
  await ensureRemoteDir(client, remoteFileDir);
  await client.uploadFrom(localPath, remotePath);
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
