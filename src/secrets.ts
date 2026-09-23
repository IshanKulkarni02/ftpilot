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

function envKey(workspaceRoot: string, targetName: string, varKey: string): string {
  return `ftpilot:${workspaceRoot}:env:${targetName}:${varKey}`;
}

/** Secret-flagged env var values, stored per target+key so each contributor sets their own copy locally (same model as FTP credentials). */
export async function getEnvSecret(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  targetName: string,
  varKey: string
): Promise<string | undefined> {
  return context.secrets.get(envKey(workspaceRoot, targetName, varKey));
}

export async function setEnvSecret(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  targetName: string,
  varKey: string,
  value: string
): Promise<void> {
  await context.secrets.store(envKey(workspaceRoot, targetName, varKey), value);
}
