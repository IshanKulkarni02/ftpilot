import * as vscode from "vscode";
import { spawn } from "child_process";
import * as crypto from "crypto";

/**
 * App Lock: gates every action that touches saved FTP/env secrets behind an OS biometric
 * check (Touch ID on macOS, Windows Hello on Windows) or an app password, so a second person
 * with physical/session access to an unlocked machine can't just click Deploy or read out
 * saved logins. This is on top of (not instead of) SecretStorage's own OS-keychain encryption
 * in secrets.ts — that protects the data at rest on disk; this protects the *action* from
 * anyone currently sitting at the keyboard.
 */

const APP_PASSWORD_HASH_KEY = "ftpilot:applock:hash"; // global (not per-workspace): one device-level lock
const SCRYPT_KEYLEN = 64;

let lastAuthAt = 0; // in-memory only — never persisted, so a VS Code restart always re-locks

export function configuredAuth(): { require: boolean; method: "auto" | "password"; timeoutMinutes: number } {
  const cfg = vscode.workspace.getConfiguration("ftpilot");
  return {
    require: cfg.get<boolean>("requireAuth", true),
    method: cfg.get<"auto" | "password">("authMethod", "auto"),
    timeoutMinutes: Math.max(0, cfg.get<number>("authTimeoutMinutes", 15)),
  };
}

/** Forces the next `ensureAuthorized` call to prompt again, regardless of the timeout window. */
export function lockNow(): void {
  lastAuthAt = 0;
}

function withinTimeout(timeoutMinutes: number): boolean {
  if (timeoutMinutes <= 0) return false; // 0 = always ask
  return Date.now() - lastAuthAt < timeoutMinutes * 60_000;
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
}

async function getStoredHash(context: vscode.ExtensionContext): Promise<{ salt: Buffer; hash: Buffer } | undefined> {
  const raw = await context.secrets.get(APP_PASSWORD_HASH_KEY);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as { salt: string; hash: string };
  return { salt: Buffer.from(parsed.salt, "hex"), hash: Buffer.from(parsed.hash, "hex") };
}

async function storeHash(context: vscode.ExtensionContext, password: string): Promise<void> {
  const salt = crypto.randomBytes(16);
  const hash = hashPassword(password, salt);
  // Even though SecretStorage already encrypts values at rest via the OS keychain, we store a
  // salted scrypt hash rather than the plaintext app password — belt and suspenders, and it
  // means the app password is never held in memory or on disk anywhere after entry.
  await context.secrets.store(APP_PASSWORD_HASH_KEY, JSON.stringify({ salt: salt.toString("hex"), hash: hash.toString("hex") }));
}

export async function hasAppPassword(context: vscode.ExtensionContext): Promise<boolean> {
  return !!(await getStoredHash(context));
}

export async function clearAppPassword(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(APP_PASSWORD_HASH_KEY);
}

/** Prompts to create (or replace) the app password. Returns false if the user cancels or the two entries don't match. */
export async function setAppPassword(context: vscode.ExtensionContext): Promise<boolean> {
  const pw1 = await vscode.window.showInputBox({
    title: "FTPilot: Set App Password",
    prompt: "Choose a password required to deploy or view saved logins (separate from any FTP password)",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length >= 4 ? undefined : "Use at least 4 characters"),
  });
  if (!pw1) return false;
  const pw2 = await vscode.window.showInputBox({
    title: "FTPilot: Confirm App Password",
    prompt: "Re-enter the password",
    password: true,
    ignoreFocusOut: true,
  });
  if (pw2 !== pw1) {
    void vscode.window.showErrorMessage("FTPilot: passwords didn't match. Not saved.");
    return false;
  }
  await storeHash(context, pw1);
  lockNow();
  void vscode.window.showInformationMessage("FTPilot: app password saved.");
  return true;
}

async function verifyAppPassword(context: vscode.ExtensionContext): Promise<boolean> {
  const stored = await getStoredHash(context);
  if (!stored) {
    // No app password set yet and biometrics aren't available/failed — asking the user to set
    // one now is the only way "password" fallback can mean anything.
    const choice = await vscode.window.showWarningMessage(
      "FTPilot: no app password set yet, and this device has no usable Touch ID / Windows Hello. Set one now to protect deploys and saved logins.",
      "Set App Password"
    );
    if (choice !== "Set App Password") return false;
    return setAppPassword(context);
  }
  const entered = await vscode.window.showInputBox({
    title: "FTPilot: Unlock",
    prompt: "App password required to continue",
    password: true,
    ignoreFocusOut: true,
  });
  if (!entered) return false;
  const candidate = hashPassword(entered, stored.salt);
  return crypto.timingSafeEqual(candidate, stored.hash);
}

/** Runs a short script via the given interpreter and resolves its trimmed stdout, or rejects on nonzero exit / spawn error. */
function runScript(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout: 60_000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `exited ${code}`));
    });
  });
}

/** Touch ID (or the Mac's configured biometric) via LocalAuthentication, invoked through JXA — no native module/build step needed. */
async function tryMacBiometric(reason: string): Promise<boolean> {
  const script = `
ObjC.import('LocalAuthentication');
ObjC.import('Foundation');
const ctx = $.LAContext.alloc.init;
const canErr = Ref();
if (!ctx.canEvaluatePolicyError(2, canErr)) { '' + 'unavailable'; }
else {
  let done = false, ok = false;
  ctx.evaluatePolicyLocalizedReasonReply(2, ${JSON.stringify(reason)}, (success, error) => { ok = !!success; done = true; });
  const end = Date.now() + 30000;
  while (!done && Date.now() < end) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  ok ? 'ok' : 'denied';
}
`;
  try {
    const out = await runScript("osascript", ["-l", "JavaScript", "-e", script]);
    return out.trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * Windows Hello via UserConsentVerifier (WinRT), invoked from PowerShell — same "no native
 * module" approach as the macOS path. NOTE: written against the documented WinRT interop
 * pattern for PowerShell but not verified on real Windows hardware in this session — if it
 * doesn't trigger a Hello prompt on your machine, it fails closed and falls back to the app
 * password automatically, so it can't accidentally let a deploy through unauthenticated.
 */
async function tryWindowsHello(reason: string): Promise<boolean> {
  const ps = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
  $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync(${JSON.stringify(reason)})
  $result = $op.GetResults()
  if ($result -eq [Windows.Security.Credentials.UI.UserConsentVerificationResult]::Verified) { Write-Output 'ok' } else { Write-Output 'denied' }
} catch {
  Write-Output 'unavailable'
}
`;
  try {
    const out = await runScript("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    return out.trim() === "ok";
  } catch {
    return false;
  }
}

const biometricLabel = process.platform === "darwin" ? "Touch ID" : process.platform === "win32" ? "Windows Hello" : "OS biometric (not available on this platform)";

/**
 * One place to see and change every App Lock setting — the "button" for it in the UI (a title
 * bar icon in the panel, and the first-run prompt below) opens this instead of sending someone
 * to hunt through Settings. Loops back to itself after each change so multiple settings can be
 * adjusted in one go; Escape closes it.
 */
export async function configureAppLock(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("ftpilot");
  const { require, method, timeoutMinutes } = configuredAuth();
  const hasPw = await hasAppPassword(context);

  type Item = vscode.QuickPickItem & { action: string };
  const items: Item[] = [
    {
      action: "toggleRequire",
      label: `$(${require ? "check" : "circle-large-outline"}) Require authentication to deploy or view saved logins`,
      description: require ? "On" : "Off",
    },
    {
      action: "method",
      label: "$(shield) Method",
      description: method === "auto" ? `${biometricLabel} (with app password fallback)` : "App password only",
    },
    {
      action: "password",
      label: hasPw ? "$(key) Change App Password" : "$(key) Set App Password",
      description: hasPw ? "A password is set" : "No password set yet",
    },
  ];
  if (hasPw) items.push({ action: "removePassword", label: "$(trash) Remove App Password" });
  items.push({ action: "timeout", label: "$(clock) Re-ask after", description: timeoutMinutes === 0 ? "Every time" : `${timeoutMinutes} minute(s)` });
  items.push({ action: "lockNow", label: "$(lock) Lock Now", description: "Ask again on the next gated action" });

  const picked = await vscode.window.showQuickPick(items, {
    title: "FTPilot: App Lock Settings",
    placeHolder: "Protects deploys, backups, rollbacks, and saved FTP logins from anyone else at your keyboard",
  });
  if (!picked) return;

  switch (picked.action) {
    case "toggleRequire":
      await cfg.update("requireAuth", !require, vscode.ConfigurationTarget.Global);
      break;
    case "method": {
      const options: (vscode.QuickPickItem & { value: "auto" | "password" })[] = [
        { value: "auto", label: `${method === "auto" ? "$(check) " : ""}${biometricLabel} first, app password as fallback`, description: "Recommended" },
        { value: "password", label: `${method === "password" ? "$(check) " : ""}App password only`, description: "Even if biometrics are available" },
      ];
      const choice = await vscode.window.showQuickPick(options, { title: "FTPilot: Authentication Method" });
      if (choice) await cfg.update("authMethod", choice.value, vscode.ConfigurationTarget.Global);
      break;
    }
    case "password":
      await setAppPassword(context);
      break;
    case "removePassword":
      if (await ensureAuthorized(context, "Remove the FTPilot app password")) {
        await clearAppPassword(context);
        void vscode.window.showInformationMessage(`FTPilot: app password removed. ${biometricLabel} will be used instead.`);
      }
      break;
    case "timeout": {
      const entered = await vscode.window.showInputBox({
        title: "FTPilot: Re-ask After (minutes)",
        prompt: "0 = ask every time",
        value: String(timeoutMinutes),
        validateInput: (v) => (/^\d+$/.test(v) ? undefined : "Enter a whole number of minutes"),
      });
      if (entered !== undefined) await cfg.update("authTimeoutMinutes", Number(entered), vscode.ConfigurationTarget.Global);
      break;
    }
    case "lockNow":
      lockNow();
      void vscode.window.showInformationMessage("FTPilot: locked. The next deploy or credential change will ask for authentication.");
      return; // nothing more to configure right now
  }
  await configureAppLock(context); // loop back with the updated state shown
}

const ONBOARDED_KEY = "ftpilot:applock:onboarded";

/**
 * Shown once, the first time FTPilot activates in a fresh install (never again after that,
 * regardless of the choice made) — introduces App Lock and offers to open the settings above
 * right away instead of leaving it to be discovered.
 */
export async function maybeShowFirstRunPrompt(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(ONBOARDED_KEY)) return;
  await context.globalState.update(ONBOARDED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    `FTPilot protects deploys and saved FTP logins with ${biometricLabel} (or an app password) by default, so a second person at your unlocked laptop can't just click Deploy. Set it up now?`,
    "Set Up App Lock",
    "Not Now"
  );
  if (choice === "Set Up App Lock") await configureAppLock(context);
}

/**
 * The main gate. Call this before any action that reads a saved FTP password, saved secret
 * env value, or that connects/uploads/deletes on the server. Returns true only after a fresh
 * OS biometric success or a correct app password (or if requireAuth is off, or the last
 * success is still within the configured timeout window).
 */
export async function ensureAuthorized(context: vscode.ExtensionContext, reason: string): Promise<boolean> {
  const { require, method, timeoutMinutes } = configuredAuth();
  if (!require) return true;
  if (withinTimeout(timeoutMinutes)) return true;

  let ok = false;
  if (method === "auto") {
    if (process.platform === "darwin") ok = await tryMacBiometric(reason);
    else if (process.platform === "win32") ok = await tryWindowsHello(reason);
  }
  if (!ok) ok = await verifyAppPassword(context);

  if (ok) lastAuthAt = Date.now();
  else void vscode.window.showWarningMessage("FTPilot: authentication failed or canceled. Action stopped.");
  return ok;
}
