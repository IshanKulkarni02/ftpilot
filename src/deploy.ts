import * as vscode from "vscode";
import * as path from "path";
import { loadConfig, manifestPath, DeployTarget } from "./config";
import { getCredentials } from "./secrets";
import { getCurrentBranch } from "./git";
import { runBuild } from "./build";
import { loadManifest, saveManifest, hashTarget, diffTarget, Manifest } from "./manifest";
import * as ftpClient from "./ftpClient";

export interface DeployOptions {
  /** Force full re-upload of every target, ignoring uploadMode / manifest. */
  forceFull?: boolean;
}

export async function runDeploy(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  statusBar: vscode.StatusBarItem,
  options: DeployOptions = {}
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage("FTPilot: open a folder/workspace first.");
    return;
  }
  const workspaceRoot = folders[0].uri.fsPath;

  let config;
  try {
    config = loadConfig(workspaceRoot);
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      (err as Error).message,
      "Configure Now"
    );
    if (choice === "Configure Now") {
      await vscode.commands.executeCommand("ftpilot.setup");
    }
    return;
  }

  if (config.warnIfNotOnBranch) {
    try {
      const branch = await getCurrentBranch(workspaceRoot);
      if (branch !== config.deployBranch) {
        const choice = await vscode.window.showWarningMessage(
          `You're on branch '${branch}', but FTPilot is configured for '${config.deployBranch}'. Deploy anyway?`,
          { modal: true },
          "Deploy Anyway"
        );
        if (choice !== "Deploy Anyway") {
          return;
        }
      }
    } catch {
      // not a git repo, or git not available — skip the branch check silently
    }
  }

  output.clear();
  output.show(true);
  statusBar.text = "$(sync~spin) FTPilot: deploying...";

  const startedAt = Date.now();
  let client: Awaited<ReturnType<typeof ftpClient.connect>> | undefined;
  let currentAccount = "";

  try {
    // 1. Build each target
    for (const target of config.targets) {
      output.appendLine(`\n=== Building: ${target.name} ===`);
      await runBuild(target, workspaceRoot, output);
    }

    // 2. Hash all targets' build output into one combined manifest
    const newManifest: Manifest = {};
    for (const target of config.targets) {
      const localDir = path.join(workspaceRoot, target.localDir);
      Object.assign(newManifest, hashTarget(target.name, localDir));
    }

    const mPath = manifestPath(workspaceRoot);
    const oldManifest = options.forceFull ? {} : loadManifest(mPath);

    let totalUploaded = 0;
    let totalRemoved = 0;

    // 3. Upload each target (connecting/reconnecting per FTP account as needed)
    for (const target of config.targets) {
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

      const localDir = path.join(workspaceRoot, target.localDir);
      const useFull = options.forceFull || config.uploadMode === "full";

      output.appendLine(`\n=== Uploading: ${target.name} -> ${target.remoteDir} (${useFull ? "full" : "incremental"}) ===`);

      let targetChanged = useFull;

      if (useFull) {
        const count = await ftpClient.uploadFull(client, localDir, target.remoteDir);
        totalUploaded += count;
        output.appendLine(`Uploaded ${count} files.`);
      } else {
        const diff = diffTarget(target.name, oldManifest, newManifest);
        for (const relPath of diff.toUpload) {
          output.appendLine(`  + ${relPath}`);
          await ftpClient.uploadOne(client, localDir, target.remoteDir, relPath);
        }
        for (const relPath of diff.toRemove) {
          output.appendLine(`  - ${relPath}`);
          await ftpClient.removeOne(client, target.remoteDir, relPath);
        }
        totalUploaded += diff.toUpload.length;
        totalRemoved += diff.toRemove.length;
        targetChanged = diff.toUpload.length > 0 || diff.toRemove.length > 0;
        output.appendLine(`Uploaded ${diff.toUpload.length}, removed ${diff.toRemove.length}.`);
      }

      if (target.restartFile && targetChanged) {
        output.appendLine(`Restarting app: touching ${target.restartFile}`);
        await ftpClient.touchRestartFile(client, target.restartFile);
      }
    }

    saveManifest(mPath, newManifest);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    output.appendLine(`\nDone in ${seconds}s. ${totalUploaded} uploaded, ${totalRemoved} removed.`);
    statusBar.text = "$(cloud-upload) Deploy";
    void vscode.window.showInformationMessage(
      `FTPilot: done in ${seconds}s (${totalUploaded} uploaded, ${totalRemoved} removed).`
    );
  } catch (err) {
    const message = (err as Error).message;
    output.appendLine(`\nERROR: ${message}`);
    statusBar.text = "$(cloud-upload) Deploy";
    void vscode.window.showErrorMessage(`FTPilot failed: ${message}`);
  } finally {
    if (client) {
      client.close();
    }
  }
}

export function summarizeTarget(target: DeployTarget): string {
  return `${target.name}: ${target.localDir} -> ${target.remoteDir}`;
}
