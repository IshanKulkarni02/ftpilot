import * as fs from "fs";
import * as path from "path";

/** One env var this target's build needs. Plain values are committed in config.json; secret ones are looked up from SecretStorage at build time, keyed by target name + key. */
export interface EnvVar {
  key: string;
  value?: string;
  secret?: boolean;
}

export interface DeployTarget {
  /**
   * Stable id assigned when the target is created, used as the SecretStorage key for its
   * env secrets so they survive a rename. Targets saved before this field existed won't have
   * one — env-secret lookups fall back to `name` for those until the panel is opened and saved.
   */
  id?: string;
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
  /** Env vars injected into buildCommand's process env (on top of the inherited shell env). Lets the same source build differently for prod than `npm run dev` does locally. */
  env?: EnvVar[];
}

export interface DeployConfig {
  deployBranch: string;
  host: string;
  port: number;
  secure: boolean;
  uploadMode: "incremental" | "full";
  targets: DeployTarget[];
}

export const DEFAULT_CONFIG: DeployConfig = {
  deployBranch: "deploy",
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

/** `validate: false` is for the UI, which must still show an incomplete config so it can be fixed. */
export function loadConfig(workspaceRoot: string, validate = true): DeployConfig {
  const p = configPath(workspaceRoot);
  if (!fs.existsSync(p)) {
    throw new Error(
      "No .ftbdeploy/config.json found. Open the FTPilot panel in the Activity Bar to set it up."
    );
  }
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as DeployConfig;
  parsed.targets ??= [];
  if (!validate) return parsed;
  if (parsed.targets.length === 0) {
    throw new Error(
      ".ftbdeploy/config.json has no targets configured. Edit it to add at least one deploy target."
    );
  }
  const problems = validateTargets(parsed.targets);
  if (problems.length) {
    throw new Error(`.ftbdeploy/config.json is incomplete:\n  ${problems.join("\n  ")}`);
  }
  return parsed;
}

/**
 * Guards against uploading the wrong thing: an empty or "." localDir resolves to the whole
 * workspace, which would push source code and .env secrets to the server.
 */
export function validateTargets(targets: DeployTarget[]): string[] {
  const problems: string[] = [];
  targets.forEach((t, i) => {
    const label = t.name || `Target ${i + 1}`;
    const local = (t.localDir ?? "").trim().replace(/^\.(\/|$)/, "").replace(/\/+$/, "");
    if (!t.name?.trim()) problems.push(`${label}: Target Name is empty.`);
    if (!local) problems.push(`${label}: Build Output Directory is empty (or the project root). Pick the build folder, e.g. dist or out.`);
    else if (local.split("/").includes("..")) problems.push(`${label}: Build Output Directory must be inside the project.`);
    if (!t.remoteDir?.trim()) problems.push(`${label}: Server Destination Directory is empty.`);
  });
  return problems;
}

export function saveConfig(workspaceRoot: string, config: DeployConfig): void {
  fs.mkdirSync(configDir(workspaceRoot), { recursive: true });
  fs.writeFileSync(configPath(workspaceRoot), JSON.stringify(config, null, 2), "utf8");
}

/** Persists a corrected localDir for one target by name, e.g. after runtime output-folder auto-detection. */
export function updateTargetLocalDir(
  workspaceRoot: string,
  targetName: string,
  newLocalDir: string
): void {
  const config = loadConfig(workspaceRoot);
  const target = config.targets.find((t) => t.name === targetName);
  if (target) {
    target.localDir = newLocalDir;
    saveConfig(workspaceRoot, config);
  }
}
