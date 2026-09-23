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
  for (const v of target.env ?? []) {
    if (v.secret) {
      const stored = await getEnvSecret(context, workspaceRoot, target.name, v.key);
      if (!stored) {
        throw new Error(
          `[${target.name}] env var '${v.key}' is marked secret but has no value saved. Set it in the FTPilot panel first.`
        );
      }
      env[v.key] = stored;
    } else if (v.value) {
      env[v.key] = v.value;
    }
  }
  return env;
}

export async function runBuild(
  context: vscode.ExtensionContext,
  target: DeployTarget,
  workspaceRoot: string,
  output: vscode.OutputChannel
): Promise<void> {
  if (!target.buildCommand) {
    return;
  }
  const cwd = target.cwd ? path.join(workspaceRoot, target.cwd) : workspaceRoot;
  const env = await resolveEnv(context, workspaceRoot, target);

  output.appendLine(`\n[${target.name}] $ ${target.buildCommand}  (cwd: ${cwd})`);

  return new Promise((resolve, reject) => {
    const child = spawn(target.buildCommand as string, {
      cwd,
      shell: true,
      env,
    });

    child.stdout.on("data", (chunk) => output.append(chunk.toString()));
    child.stderr.on("data", (chunk) => output.append(chunk.toString()));

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`[${target.name}] build command exited with code ${code}`));
      }
    });
  });
}
