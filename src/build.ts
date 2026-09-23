import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import { DeployTarget } from "./config";
import { getEnvSecret } from "./secrets";

async function resolveEnv(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  target: DeployTarget
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const secretsId = target.id || target.name;
  for (const v of target.env ?? []) {
    if (v.secret) {
      const stored = await getEnvSecret(context, workspaceRoot, secretsId, v.key);
      if (!stored) {
        throw new Error(
          `[${target.name}] env var '${v.key}' is marked secret but has no value saved. Set it in the FTPilot panel first.`
        );
      }
      env[v.key] = stored;
    } else {
      // Every entry here was explicitly declared in the panel, even ones the user left
      // blank — inject it as-is rather than silently falling through to the ambient shell env.
      env[v.key] = v.value ?? "";
    }
  }
  return env;
}

/**
 * Checks every target's declared secret env vars exist in SecretStorage before any target
 * builds. Without this, a deploy builds targets one by one and only discovers a missing
 * secret partway through — by then earlier targets already built (wasted work) and the
 * whole deploy still aborts, uploading nothing, even for targets with no env vars at all.
 */
export async function validateEnvSecrets(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  targets: DeployTarget[]
): Promise<void> {
  const missing: string[] = [];
  for (const target of targets) {
    const secretsId = target.id || target.name;
    for (const v of target.env ?? []) {
      if (!v.secret) continue;
      const stored = await getEnvSecret(context, workspaceRoot, secretsId, v.key);
      if (!stored) missing.push(`${target.name}: ${v.key}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `Missing env secret value(s) — set these in the FTPilot panel before deploying:\n  ${missing.join("\n  ")}`
    );
  }
}

/** Where build output goes: the Output channel, optionally teed into a log file buffer. */
export type LogSink = Pick<vscode.OutputChannel, "append" | "appendLine">;

/** A failed build, carrying the tail of its output so the UI/report can show *why*. */
export class BuildError extends Error {
  constructor(message: string, public readonly detail: string) {
    super(message);
  }
}

const TAIL_LINES = 40;

export async function runBuild(
  context: vscode.ExtensionContext,
  target: DeployTarget,
  workspaceRoot: string,
  output: LogSink,
  onLine?: (line: string) => void,
  /** Receives a function that kills the build (used by Cancel). */
  onSpawn?: (kill: () => void) => void
): Promise<void> {
  if (!target.buildCommand) {
    return;
  }
  const cwd = target.cwd ? path.join(workspaceRoot, target.cwd) : workspaceRoot;
  const env = await resolveEnv(context, workspaceRoot, target);

  output.appendLine(`\n[${target.name}] $ ${target.buildCommand}  (cwd: ${cwd})`);

  return new Promise((resolve, reject) => {
    // Own process group on POSIX, so Cancel can stop npm *and* the compiler it spawned.
    const detached = process.platform !== "win32";
    const child = spawn(target.buildCommand as string, {
      cwd,
      shell: true,
      env,
      detached,
    });
    onSpawn?.(() => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill();
      } catch {
        // already exited
      }
    });

    const tail: string[] = [];
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output.append(text);
      // Strip ANSI colour codes so the panel/report show clean text.
      for (const raw of text.split(/\r?\n|\r/)) {
        const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        onLine?.(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new BuildError(`[${target.name}] build command exited with code ${code}`, tail.join("\n")));
      }
    });
  });
}
