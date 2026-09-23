import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import { DeployTarget } from "./config";

export function runBuild(
  target: DeployTarget,
  workspaceRoot: string,
  output: vscode.OutputChannel
): Promise<void> {
  if (!target.buildCommand) {
    return Promise.resolve();
  }
  const cwd = target.cwd ? path.join(workspaceRoot, target.cwd) : workspaceRoot;

  output.appendLine(`\n[${target.name}] $ ${target.buildCommand}  (cwd: ${cwd})`);

  return new Promise((resolve, reject) => {
    const child = spawn(target.buildCommand as string, {
      cwd,
      shell: true,
      env: process.env,
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
