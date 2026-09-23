import * as vscode from "vscode";
import { DeployConfig, DeployTarget, DEFAULT_CONFIG, saveConfig, configPath } from "./config";
import { setCredentials } from "./secrets";

async function ask(
  prompt: string,
  placeHolder: string,
  defaultValue?: string,
  password = false
): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, placeHolder, value: defaultValue, password });
}

interface CollectedTarget {
  target: DeployTarget;
  pendingCreds?: { user: string; password: string };
}

async function collectTarget(): Promise<CollectedTarget | undefined> {
  const name = await ask(
    "Target name (what this is), e.g. include the domain it goes to",
    "Frontend (app.example.com)"
  );
  if (!name) return undefined;

  const localDir = await ask(
    "Local build output folder to upload (relative to project root)",
    "client/build"
  );
  if (!localDir) return undefined;

  const remoteDir = await ask(
    "Remote folder on the server (full FTP path for this domain/subdomain's docroot)",
    "/public_html or /api.example.com"
  );
  if (!remoteDir) return undefined;

  const buildCommand = await ask(
    "Build command to run before upload (leave blank if none, e.g. plain PHP)",
    "npm run build"
  );

  const cwd = buildCommand
    ? await ask(
        "Local folder to run that build command in (relative to project root, blank = project root)",
        "client"
      )
    : undefined;

  const isBackend = await vscode.window.showQuickPick(["No", "Yes"], {
    placeHolder: "Is this a cPanel 'Setup Node.js App' (Passenger) backend that needs a restart after upload?",
  });

  let restartFile: string | undefined;
  if (isBackend === "Yes") {
    restartFile = await ask(
      "Remote path to the Passenger restart file (full FTP path)",
      "/nodeapp/tmp/restart.txt"
    );
  }

  const separateAccount = await vscode.window.showQuickPick(["No", "Yes"], {
    placeHolder: "Does this domain/subdomain use its own separate FTP login (not the default one)?",
  });

  let ftpUser: string | undefined;
  let pendingCreds: { user: string; password: string } | undefined;
  if (separateAccount === "Yes") {
    ftpUser = await ask("FTP username for this target", "subdomain-ftp-user");
    if (ftpUser) {
      const password = await ask(`FTP password for '${ftpUser}'`, "", undefined, true);
      if (password) {
        pendingCreds = { user: ftpUser, password };
      }
    }
  }

  const target: DeployTarget = { name, localDir, remoteDir, buildCommand, cwd, restartFile, ftpUser };
  return { target, pendingCreds };
}

export async function runSetupWizard(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  const deployBranch =
    (await ask("Git branch this tool deploys from", "deploy", DEFAULT_CONFIG.deployBranch)) ??
    DEFAULT_CONFIG.deployBranch;

  const host = await ask("FTP host", "ftp.yourdomain.com");
  if (!host) {
    void vscode.window.showWarningMessage("FTPilot setup cancelled (no host given).");
    return;
  }

  const portStr = (await ask("FTP port", "21", "21")) ?? "21";
  const port = parseInt(portStr, 10) || 21;

  const protocolChoice = await vscode.window.showQuickPick(
    ["Plain FTP", "FTPS (explicit TLS)"],
    { placeHolder: "Protocol (matches your FileZilla site setting)" }
  );
  const secure = protocolChoice === "FTPS (explicit TLS)";

  const defaultUser = await ask("Default FTP username", "cpanel-ftp-user");
  let defaultPassword: string | undefined;
  if (defaultUser) {
    defaultPassword = await ask(`FTP password for '${defaultUser}'`, "", undefined, true);
  }

  const uploadModeChoice = await vscode.window.showQuickPick(
    ["Incremental (only changed files, faster)", "Full (re-upload everything every time)"],
    { placeHolder: "Upload mode for this project" }
  );
  const uploadMode: DeployConfig["uploadMode"] =
    uploadModeChoice?.startsWith("Full") ? "full" : "incremental";

  const targets: DeployTarget[] = [];
  let addMore = "Yes";
  while (addMore === "Yes") {
    const collected = await collectTarget();
    if (collected) {
      targets.push(collected.target);
      if (collected.target.ftpUser && collected.pendingCreds) {
        await setCredentials(context, workspaceRoot, collected.target.ftpUser, collected.pendingCreds);
      }
    }
    if (targets.length > 0) {
      addMore =
        (await vscode.window.showQuickPick(["No", "Yes"], {
          placeHolder: `Add another target? (${targets.length} added so far)`,
        })) ?? "No";
    } else {
      addMore = "No";
    }
  }

  if (targets.length === 0) {
    void vscode.window.showWarningMessage(
      "FTPilot setup cancelled (no targets added)."
    );
    return;
  }

  const config: DeployConfig = {
    deployBranch,
    warnIfNotOnBranch: true,
    host,
    port,
    secure,
    uploadMode,
    targets,
  };

  saveConfig(workspaceRoot, config);

  if (defaultUser && defaultPassword) {
    await setCredentials(context, workspaceRoot, "default", {
      user: defaultUser,
      password: defaultPassword,
    });
  }

  const doc = await vscode.workspace.openTextDocument(configPath(workspaceRoot));
  await vscode.window.showTextDocument(doc);

  void vscode.window.showInformationMessage(
    `FTPilot configured with ${targets.length} target(s). Review .ftbdeploy/config.json, then run 'FTPilot: Deploy / Redeploy'.`
  );
}
