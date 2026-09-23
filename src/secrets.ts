import * as vscode from "vscode";

export interface Credentials {
  user: string;
  password: string;
}

function userKey(workspaceRoot: string, account: string): string {
  return `ftpilot:${workspaceRoot}:${account}:user`;
}

function passKey(workspaceRoot: string, account: string): string {
  return `ftpilot:${workspaceRoot}:${account}:password`;
}

/**
 * `account` distinguishes credential sets when a target overrides ftpUser
 * (e.g. a subdomain with its own scoped FTP login). "default" is the
 * project-wide FTP account.
 */
export async function getCredentials(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  account: string
): Promise<Credentials | undefined> {
  const user = await context.secrets.get(userKey(workspaceRoot, account));
  const password = await context.secrets.get(passKey(workspaceRoot, account));
  if (!user || !password) {
    return undefined;
  }
  return { user, password };
}

export async function setCredentials(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  account: string,
  creds: Credentials
): Promise<void> {
  await context.secrets.store(userKey(workspaceRoot, account), creds.user);
  await context.secrets.store(passKey(workspaceRoot, account), creds.password);
}

function envKey(workspaceRoot: string, targetId: string, varKey: string): string {
  return `ftpilot:${workspaceRoot}:env:${targetId}:${varKey}`;
}

/**
 * Secret-flagged env var values, stored per target+key so each contributor sets their own
 * copy locally (same model as FTP credentials). `targetId` should be the target's stable
 * `id` (falling back to `name` only for targets saved before `id` existed) — keying by the
 * mutable display name would orphan the secret the moment someone renames the target.
 */
export async function getEnvSecret(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  targetId: string,
  varKey: string
): Promise<string | undefined> {
  return context.secrets.get(envKey(workspaceRoot, targetId, varKey));
}

export async function setEnvSecret(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  targetId: string,
  varKey: string,
  value: string
): Promise<void> {
  await context.secrets.store(envKey(workspaceRoot, targetId, varKey), value);
}

/** What the UI may show about a saved login: the username and whether a password exists — never the password. */
export async function getLoginStatus(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  account: string
): Promise<{ user?: string; hasPassword: boolean }> {
  const user = await context.secrets.get(userKey(workspaceRoot, account));
  const password = await context.secrets.get(passKey(workspaceRoot, account));
  return { user: user || undefined, hasPassword: !!password };
}
