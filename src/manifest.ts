import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** Manifest key is "<targetName>/<relativePath>" -> sha1 hash of file contents. */
export type Manifest = Record<string, string>;

const DEFAULT_IGNORE_NAMES = new Set(["node_modules", ".git", ".DS_Store"]);

export function loadManifest(manifestFile: string): Manifest {
  if (!fs.existsSync(manifestFile)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest;
}

export function saveManifest(manifestFile: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
}

function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/**
 * Compiles gitignore-style globs into one predicate over posix relative paths.
 * `*` = within a path segment, `**` = any depth, `?` = one char; a pattern without "/"
 * matches the file name at any depth (so "*.map" == "**\/*.map").
 */
export function globMatcher(patterns: string[] = []): (relPath: string) => boolean {
  const res = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const anchored = p.includes("/") ? p.replace(/^\//, "") : `**/${p}`;
      const src = anchored
        .split(/(\*\*\/|\*\*|\*|\?)/)
        .map((tok) =>
          tok === "**/" ? "(?:.*/)?" : tok === "**" ? ".*" : tok === "*" ? "[^/]*" : tok === "?" ? "[^/]" : tok.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        )
        .join("");
      return new RegExp(`^${src}$`);
    });
  return (relPath) => res.some((re) => re.test(relPath));
}

/** Recursively lists files under `dir`, returned as paths relative to `dir` (posix separators). */
export function walkDir(dir: string, exclude?: (relPath: string) => boolean): string[] {
  const results: string[] = [];
  function walk(current: string, rel: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (DEFAULT_IGNORE_NAMES.has(entry.name)) {
        continue;
      }
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile() && !exclude?.(relPath)) {
        results.push(relPath);
      }
    }
  }
  if (fs.existsSync(dir)) {
    walk(dir, "");
  }
  return results;
}

/** Builds a manifest subset for one target by hashing every file under its local build dir. */
export function hashTarget(targetName: string, localDir: string, exclude?: (relPath: string) => boolean): Manifest {
  return hashFiles(targetName, localDir, walkDir(localDir, exclude));
}

/** Like hashTarget, for a file list the caller already walked. */
export function hashFiles(targetName: string, localDir: string, relPaths: string[]): Manifest {
  const manifest: Manifest = {};
  for (const relPath of relPaths) {
    const key = `${targetName}/${relPath}`;
    manifest[key] = hashFile(path.join(localDir, relPath));
  }
  return manifest;
}

export interface DiffResult {
  /** relative paths (within the target) that are new or changed */
  toUpload: string[];
  /** relative paths (within the target) that existed before but are gone now, and should be removed remotely */
  toRemove: string[];
}

/** Diffs old vs new manifest, scoped to one target's prefix. Returns paths relative to the target's localDir. */
export function diffTarget(
  targetName: string,
  oldManifest: Manifest,
  newManifest: Manifest
): DiffResult {
  const prefix = `${targetName}/`;
  const oldKeys = Object.keys(oldManifest).filter((k) => k.startsWith(prefix));
  const newKeys = Object.keys(newManifest).filter((k) => k.startsWith(prefix));

  const toUpload: string[] = [];
  for (const key of newKeys) {
    if (oldManifest[key] !== newManifest[key]) {
      toUpload.push(key.slice(prefix.length));
    }
  }

  const newKeySet = new Set(newKeys);
  const toRemove: string[] = [];
  for (const key of oldKeys) {
    if (!newKeySet.has(key)) {
      toRemove.push(key.slice(prefix.length));
    }
  }

  return { toUpload, toRemove };
}
