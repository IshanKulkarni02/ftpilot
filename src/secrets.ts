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
