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
    secureOptions: config.secure && config.allowInvalidCert ? { rejectUnauthorized: false } : undefined,
  });
  return client;
}

export interface TlsDiagnosis {
  /** Plain-language explanation. */
  message: string;
  /** The certificate is the problem (not login/network). */
  certIssue: boolean;
  /** Server doesn't offer FTPS at all. */
  unsupported?: boolean;
  /** A hostname the certificate *is* valid for, when that can be read from it. */
  suggestedHost?: string;
}

const CERT_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

/**
 * Explains an FTPS failure. Shared cPanel hosts commonly present a certificate for the
 * server's own hostname rather than ftp.<your-domain>; in that case the cert's names are
 * read so the UI can offer "use this hostname instead" rather than disabling verification.
 */
export function diagnoseTlsError(err: unknown): TlsDiagnosis | undefined {
  const e = err as { code?: string | number; message?: string; cert?: { subjectaltname?: string; subject?: { CN?: string } } };
  const msg = e?.message ?? "";
  if (typeof e?.code === "number" && e.code >= 500 && /AUTH|TLS|SSL/i.test(msg)) {
    return { message: `This server doesn't offer FTPS (${msg.trim()}).`, certIssue: false, unsupported: true };
  }
  const code = typeof e?.code === "string" ? e.code : "";
  if (!CERT_CODES.has(code) && !/certificate|altnames|self[- ]signed/i.test(msg)) return undefined;

  const names = (e.cert?.subjectaltname ?? "")
    .split(",")
    .map((n) => n.trim().replace(/^DNS:/, ""))
    .filter((n) => n && !n.startsWith("IP Address"));
  if (!names.length && e.cert?.subject?.CN) names.push(e.cert.subject.CN);
  // A wildcard can't be dialled directly; prefer a concrete name.
  const suggestedHost = names.find((n) => !n.startsWith("*."));

  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return {
      message: `The server's certificate isn't valid for this hostname${names.length ? `; it's issued for ${names.slice(0, 3).join(", ")}` : ""}.`,
      certIssue: true,
      suggestedHost,
    };
  }
  if (code === "CERT_HAS_EXPIRED") return { message: "The server's certificate has expired.", certIssue: true };
  if (/SELF_SIGNED/.test(code) || /self[- ]signed/i.test(msg)) {
    return { message: "The server uses a self-signed certificate, which can't be verified.", certIssue: true };
  }
  return { message: `The server's certificate couldn't be verified (${code || msg}).`, certIssue: true };
}

export function remoteJoin(remoteDir: string, relPath: string): string {
  // Always use posix-style separators for FTP paths, regardless of host OS.
  const normalizedRel = relPath.split(path.sep).join("/");
  return `${remoteDir.replace(/\/+$/, "")}/${normalizedRel}`;
}

/** Creates each remote directory (and parents) once; call before parallel uploads so connections never race on MKD. */
export async function ensureDirs(client: ftp.Client, dirs: string[]): Promise<void> {
  const home = await client.pwd();
  for (const dir of dirs) {
    await client.ensureDir(dir);
    await client.cd(home);
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
