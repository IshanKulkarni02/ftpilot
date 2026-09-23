import * as fs from "fs";
import * as path from "path";

export interface DeployTarget {
  /** Friendly name, e.g. "Frontend (app.example.com)" */
  name: string;
  /** Shell command to build this target, run from `cwd`. Omit if no build step (e.g. plain PHP). */
  buildCommand?: string;
  /** Local folder (relative to workspace root) to run buildCommand in. Defaults to workspace root. */
  cwd?: string;
  /** Local folder (relative to workspace root) whose contents get uploaded, e.g. "client/build". */
  localDir: string;
  /** Remote folder (full path from the FTP account root) this target's files go to, e.g. "/public_html" or "/api.example.com". */
  remoteDir: string;
  /** Remote path (from FTP root) to touch after upload to restart a cPanel Passenger Node app, e.g. "/nodeapp/tmp/restart.txt". */
  restartFile?: string;
  /** Override FTP username for this target only (e.g. a subdomain with its own scoped FTP account). Password is looked up under the same override username. */
  ftpUser?: string;
}

export interface DeployConfig {
  deployBranch: string;
  warnIfNotOnBranch: boolean;
  host: string;
  port: number;
  secure: boolean;
  uploadMode: "incremental" | "full";
  targets: DeployTarget[];
}

export const DEFAULT_CONFIG: DeployConfig = {
  deployBranch: "deploy",
  warnIfNotOnBranch: true,
  host: "",
  port: 21,
  secure: false,
  uploadMode: "incremental",
  targets: [],
};

export function configDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".ftbdeploy");
}

export function configPath(workspaceRoot: string): string {
  return path.join(configDir(workspaceRoot), "config.json");
}

export function manifestPath(workspaceRoot: string): string {
  return path.join(configDir(workspaceRoot), "manifest.json");
}

export function configExists(workspaceRoot: string): boolean {
  return fs.existsSync(configPath(workspaceRoot));
}

export function loadConfig(workspaceRoot: string): DeployConfig {
  const p = configPath(workspaceRoot);
  if (!fs.existsSync(p)) {
    throw new Error(
      "No .ftbdeploy/config.json found. Run 'FTPilot: Configure Project' first."
    );
  }
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as DeployConfig;
  if (!parsed.targets || parsed.targets.length === 0) {
    throw new Error(
      ".ftbdeploy/config.json has no targets configured. Edit it to add at least one deploy target."
    );
  }
  return parsed;
}

export function saveConfig(workspaceRoot: string, config: DeployConfig): void {
  fs.mkdirSync(configDir(workspaceRoot), { recursive: true });
  fs.writeFileSync(configPath(workspaceRoot), JSON.stringify(config, null, 2), "utf8");
}
