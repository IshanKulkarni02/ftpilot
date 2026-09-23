import * as vscode from "vscode";
import { configExists, loadConfig, DeployTarget } from "./config";

class TargetItem extends vscode.TreeItem {
  constructor(target: DeployTarget) {
    super(target.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${target.localDir} → ${target.remoteDir}`;
    this.iconPath = new vscode.ThemeIcon("cloud-upload");
    this.contextValue = "ftpilotTarget";
    const lines = [
      target.buildCommand ? `Build: ${target.buildCommand}` : "Build: (none — files copied as-is)",
      `Local: ${target.localDir}`,
      `Remote: ${target.remoteDir}`,
    ];
    if (target.restartFile) lines.push(`Restart file: ${target.restartFile}`);
    if (target.ftpUser) lines.push(`FTP account: ${target.ftpUser}`);
    this.tooltip = lines.join("\n");
    this.command = { command: "ftpilot.deploy", title: "Deploy", arguments: [] };
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class FtpilotTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return [new InfoItem("Open a folder to use FTPilot", "folder-opened")];
    }
    if (!configExists(root)) {
      return [];
    }
    try {
      const config = loadConfig(root);
      const items: vscode.TreeItem[] = [
        new InfoItem(`Branch: ${config.deployBranch}`, "git-branch"),
        new InfoItem(`Upload mode: ${config.uploadMode}`, "sync"),
        ...config.targets.map((t) => new TargetItem(t)),
      ];
      return items;
    } catch (err) {
      const item = new InfoItem((err as Error).message, "error");
      item.tooltip = (err as Error).message;
      return [item];
    }
  }
}
