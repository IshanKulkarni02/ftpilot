import * as fs from "fs";
import * as path from "path";

export type PackageManager = "npm" | "yarn" | "pnpm";

export function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readPackageJson(cwd: string): any | undefined {
  const p = path.join(cwd, "package.json");
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** Looks at package.json's scripts for a "build" script and suggests the run command for the detected package manager. */
export function detectBuildCommand(cwd: string): string | undefined {
  const pkg = readPackageJson(cwd);
  if (!pkg?.scripts?.build) return undefined;
  const pm = detectPackageManager(cwd);
  return pm === "npm" ? "npm run build" : `${pm} build`;
}

const FRAMEWORK_OUTPUT_HINTS: Array<{ dep: string; dir: string }> = [
  { dep: "vite", dir: "dist" },
  { dep: "react-scripts", dir: "build" },
  { dep: "@angular/cli", dir: "dist" },
  { dep: "parcel", dir: "dist" },
  { dep: "vue-cli-service", dir: "dist" },
  { dep: "@vue/cli-service", dir: "dist" },
];

const COMMON_OUTPUT_DIRS = ["dist", "build", "out"];

function stripJsonComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Static (no build needed) best guess at the output folder: tsconfig outDir, then known framework conventions, then an already-built common folder. */
export function detectOutputDir(cwd: string): string | undefined {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(stripJsonComments(fs.readFileSync(tsconfigPath, "utf8")));
      const outDir = tsconfig?.compilerOptions?.outDir;
      if (typeof outDir === "string" && outDir.length > 0) {
        return outDir.replace(/^\.\//, "");
      }
    } catch {
      // malformed tsconfig — fall through to other heuristics
    }
  }

  const pkg = readPackageJson(cwd);
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const hint of FRAMEWORK_OUTPUT_HINTS) {
      if (deps?.[hint.dep]) return hint.dir;
    }
  }

  for (const name of COMMON_OUTPUT_DIRS) {
    const full = path.join(cwd, name);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory() && fs.readdirSync(full).length > 0) {
      return name;
    }
  }

  return undefined;
}

const IGNORE_TOP_LEVEL = new Set(["node_modules", ".git", ".vscode", ".ftbdeploy"]);

export type DirSnapshot = Record<string, number>;

function latestMtime(dir: string, depth = 0): number {
  let latest = fs.statSync(dir).mtimeMs;
  if (depth > 4) return latest;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const m = entry.isDirectory() ? latestMtime(full, depth + 1) : fs.statSync(full).mtimeMs;
    if (m > latest) latest = m;
  }
  return latest;
}

/** Top-level dir name -> latest mtime found anywhere inside it. Used to detect which folder a build just touched. */
export function snapshotTopLevelDirs(cwd: string): DirSnapshot {
  const snap: DirSnapshot = {};
  if (!fs.existsSync(cwd)) return snap;
  for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORE_TOP_LEVEL.has(entry.name) || entry.name.startsWith(".")) continue;
    snap[entry.name] = latestMtime(path.join(cwd, entry.name));
  }
  return snap;
}

/** Dirs that are new or whose contents changed between two snapshots, most-likely-output-folder first. */
export function diffTopLevelDirs(before: DirSnapshot, after: DirSnapshot): string[] {
  const changed: string[] = [];
  for (const [name, mtime] of Object.entries(after)) {
    if (!(name in before) || before[name] !== mtime) {
      changed.push(name);
    }
  }
  return changed.sort((a, b) => {
    const rank = (n: string) => {
      const i = COMMON_OUTPUT_DIRS.indexOf(n);
      return i === -1 ? 99 : i;
    };
    return rank(a) - rank(b);
  });
}
