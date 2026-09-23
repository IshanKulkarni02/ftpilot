import { execFile } from "child_process";

export function getCurrentBranch(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

export function checkoutBranch(cwd: string, branch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["checkout", branch], { cwd }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve();
    });
  });
}

export function getShortCommit(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd }, (err, stdout) => resolve(err ? undefined : stdout.trim()));
  });
}
