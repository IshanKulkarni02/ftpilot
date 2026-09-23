import * as fs from "fs";
import * as path from "path";

/**
 * Ships a "ready to deploy" assistant into the *user's project* (not this extension's own
 * repo): a Claude Code skill plus a plain-markdown doc other coding agents (Copilot, Cursor,
 * Antigravity, ...) can be pointed at. Both are generated from the one body below so they can
 * never drift apart. Pure fs/path module (no `vscode`) — the interactive parts (confirming an
 * overwrite, showing the result) live in extension.ts/panel.ts, same split as config.ts vs.
 * secrets.ts.
 */

export const SKILL_RELATIVE_PATH = path.join(".claude", "skills", "ftpilot-target-setup", "SKILL.md");
export const AGENTS_DOC_RELATIVE_PATH = path.join(".ftbdeploy", "AGENTS.md");

const POINTER_MARKER_START = "<!-- ftpilot:agent-instructions:start -->";
const POINTER_MARKER_END = "<!-- ftpilot:agent-instructions:end -->";

const SKILL_DESCRIPTION =
  "Use when the user says this project is ready to deploy/upload/ship (e.g. \"this is ready to upload\", " +
  "\"ready to deploy\", \"set up FTPilot for this\", \"add a deploy target\", \"match the server folders\"). " +
  "Detects the build tool and output folder, then writes/updates the Target Name, Working Directory (cwd) " +
  "and Build Command in .ftbdeploy/config.json \u2014 and, only when .ftbdeploy/remote-tree.json exists (from " +
  "'FTPilot: Scan Server Folder Structure'), proposes remoteDir by matching target names to scanned server " +
  "folder names. Never touches host, port, or credentials \u2014 those stay the user's job via the FTPilot panel.";

/**
 * Shared instruction body (no frontmatter). Kept in sync with the extension's own detection
 * heuristics (src/detect.ts) so a chat agent and the panel's "Detect" button reach the same
 * answer for the same project.
 */
const BODY = `# FTPilot target setup

Client-side half of a "ready to deploy" handoff. You fill in the parts that
come from the code (target name, working directory, build command, local
output folder). The user fills in the server-side parts (remote path, host,
credentials) themselves in the FTPilot panel \u2014 never do that part, and never
touch FTP credentials (they live only in VS Code SecretStorage, not this
file).

## When this fires

Natural-language triggers like: "this is ready to upload", "ready to deploy",
"set up FTPilot for this project", "add a deploy target", "hook this up to
FTPilot". Don't wait for a slash command.

## What NOT to touch

\`.ftbdeploy/config.json\` has fields you own and fields you must leave alone:

| You may set (per target) | Never set |
|---|---|
| \`name\`, \`cwd\`, \`buildCommand\`, \`localDir\` | \`restartFile\`, \`healthUrl\`, \`healthExpect\`, \`ftpUser\` |
| \`remoteDir\`, but **only** from an unambiguous match in \`.ftbdeploy/remote-tree.json\` (step 9) \u2014 never guessed | top-level: \`host\`, \`port\`, \`secure\`, \`allowInvalidCert\` |
| top-level: create the file with defaults if missing | \u2014 |
| \u2014 | any FTP username/password, any env var marked \`secret: true\` (those live in VS Code SecretStorage, not this file) |

If a field you must not touch is already set, leave it exactly as-is \u2014 only
add/update the fields you own. \`remoteDir\` starts out unset/empty; that's
expected \u2014 don't invent a value for it outside step 9.

## Steps

1. **Find or create the config file.**
   - Repo root is the VS Code workspace root (or ask if ambiguous in a
     multi-root/monorepo setup \u2014 see step 4).
   - If \`.ftbdeploy/config.json\` doesn't exist, create \`.ftbdeploy/\` and write
     a fresh config:
     \`\`\`json
     {
       "deployBranch": "deploy",
       "host": "",
       "port": 21,
       "secure": true,
       "uploadMode": "incremental",
       "exclude": ["*.map", "*.d.ts"],
       "targets": []
     }
     \`\`\`
     Leave \`host\` empty \u2014 that's the user's server-side step.
   - If it exists, read and parse it; you'll be editing in place.

2. **Detect the build**, the same way FTPilot's own "Detect" button does:
   - Package manager (for the run syntax): \`pnpm-lock.yaml\` \u2192 \`pnpm build\`,
     \`yarn.lock\` \u2192 \`yarn build\`, otherwise \u2192 \`npm run build\`. Only use this if
     \`package.json\` has a \`"build"\` script \u2014 if it doesn't, there's no build
     command to set.
   - **Output folder (\`localDir\`)**, in this order:
     1. \`tsconfig.json\`'s \`compilerOptions.outDir\`, if set.
     2. A known framework dependency in \`package.json\` (\`dependencies\` or
        \`devDependencies\`): \`vite\` \u2192 \`dist\`, \`react-scripts\` \u2192 \`build\`,
        \`@angular/cli\` \u2192 \`dist/<project-name>\`, \`parcel\` \u2192 \`dist\`,
        \`vue-cli-service\`/\`@vue/cli-service\` \u2192 \`dist\`. (Next.js static export
        \u2192 \`out\`.)
     3. Otherwise, an existing non-empty folder named \`dist\`, \`build\`, or \`out\`.
   - Plain static/PHP site with no build step \u2192 omit \`buildCommand\` entirely
     and set \`localDir\` to the folder actually served (e.g. \`public\` or the
     project root).
   - Genuinely ambiguous (no build script, multiple plausible output dirs)?
     Ask the user rather than guessing.

3. **Determine \`cwd\`.** Relative to the workspace root, the folder
   \`buildCommand\` should run from. Single-package repo \u2192 usually \`.\` (omit
   \`cwd\`, it defaults to workspace root). Monorepo \u2192 the sub-package folder
   (e.g. \`client\`, \`apps/web\`, \`frontend\`). Multiple deployable packages \u2192
   either ask which one(s) or set up one target per deployable package.

4. **Pick \`name\`.** Infer from \`package.json\`'s \`name\`, the folder name, or
   ask the user for a friendly label (e.g. \`"Frontend (app.example.com)"\`) \u2014
   the domain part is a placeholder since you don't know the real one yet.

5. **Generate a stable \`id\`** for the target (required so FTP-credential and
   env-secret lookups survive a rename): \`uuidgen\` on macOS/Linux, or
   \`node -e "console.log(require('crypto').randomUUID())"\`.

6. **Write the target.** If a target with the same \`cwd\`+\`localDir\` (or
   matching \`name\`) already exists, update its \`name\`/\`cwd\`/\`buildCommand\`/
   \`localDir\` in place rather than adding a duplicate. Otherwise append:
   \`\`\`json
   {
     "id": "<generated-uuid>",
     "name": "<inferred name>",
     "buildCommand": "npm run build",
     "cwd": "client",
     "localDir": "client/dist",
     "remoteDir": ""
   }
   \`\`\`
   Include \`remoteDir: ""\` as an explicit placeholder only when creating a
   brand-new target, so the user immediately sees it's the one field left for
   them in the FTPilot panel \u2014 but never fill in a guessed value.

7. **Validate the JSON** (it must stay hand-editable and diffable) and save.

8. **Check for \`.ftbdeploy/remote-tree.json\`** (written by
   \`FTPilot: Scan Server Folder Structure\`, not by you). If it's missing, skip
   to step 10 \u2014 \`remoteDir\` stays the user's job. Its shape:
   \`\`\`json
   {
     "scannedAt": "2026-...",
     "host": "ftp.example.com",
     "accounts": {
       "default": { "dirs": ["public_html", "public_html/app.example.com", "..."] },
       "api-subdomain-ftp-user": { "dirs": ["..."] }
     }
   }
   \`\`\`
   \`accounts\` is keyed by FTP account name (\`"default"\`, or a target's
   \`ftpUser\` for a scoped subaccount) \u2014 directory names only, no file
   contents, already scoped to what that login can see.

9. **Propose \`remoteDir\` from that scan \u2014 only on an unambiguous match.**
   For each target missing \`remoteDir\`, look under the account matching its
   \`ftpUser\` (or \`"default"\` if unset) for a folder whose name is an
   exact or near-exact match for the target's domain/subdomain (e.g. target
   \`"Frontend (app.example.com)"\` \u2192 folder \`public_html/app.example.com\`).
     - **Exactly one plausible match** \u2192 set \`remoteDir\` to that folder's
       full path (with a leading \`/\`) and say what you matched and why.
     - **Zero or multiple plausible matches** \u2192 leave \`remoteDir\` unset. List
       the candidate folder names you saw and ask the user to pick, rather
       than guessing \u2014 deploying to the wrong remote folder is not something
       to get wrong quietly.
   \`remote-tree.json\` is gitignored and reflects a point-in-time scan \u2014
   never treat it as current if it looks stale (check \`scannedAt\`) or if the
   user says the server layout changed; ask them to re-run the scan instead.

10. **Tell the user, briefly, what's left for them**: open the FTPilot panel
    (or \`.ftbdeploy/config.json\`) and fill in any \`remoteDir\` you couldn't
    match (and \`host\`/\`port\` at the top level if not set yet), then run
    \`FTPilot: Set FTP Credentials\`. Don't attempt any of that yourself.

## Notes

- \`.ftbdeploy/config.json\` is meant to be committed (no secrets in it) \u2014
  don't gitignore it.
- \`.ftbdeploy/manifest.json\` and \`.ftbdeploy/remote-tree.json\` are
  generated, per-machine/point-in-time files (gitignored) \u2014 never create or
  hand-edit either; the latter only ever comes from
  \`FTPilot: Scan Server Folder Structure\`.
- This file (and \`.ftbdeploy/AGENTS.md\`, its plain-markdown twin for
  non-Claude agents) is written by FTPilot's "Set up AI agent skill" action
  and is meant to be committed, so every contributor's coding agent \u2014 and
  everyone else's \u2014 gets the same behavior.
`;

function skillFrontmatter(): string {
  return `---\nname: ftpilot-target-setup\ndescription: "${SKILL_DESCRIPTION.replace(/"/g, '\\"')}"\n---\n\n`;
}

export function skillFileContents(): string {
  return skillFrontmatter() + BODY;
}

export function agentsDocContents(): string {
  return BODY;
}

function pointerBlock(): string {
  return (
    `${POINTER_MARKER_START}\n` +
    `## FTPilot deploy target setup\n\n` +
    `When this project is ready to deploy/upload, follow [\`.ftbdeploy/AGENTS.md\`](.ftbdeploy/AGENTS.md) ` +
    `(Claude Code: the \`ftpilot-target-setup\` skill) to fill in the deploy target's name, working ` +
    `directory and build command. Never set \`remoteDir\`, \`host\`, \`port\`, or FTP credentials \u2014 those ` +
    `stay the user's job in the FTPilot panel.\n` +
    `${POINTER_MARKER_END}`
  );
}

export type WriteAction = "created" | "updated" | "unchanged" | "skipped-differs";

export interface WriteResult {
  relativePath: string;
  action: WriteAction;
}

function writeFileIfDifferent(absPath: string, contents: string, overwrite: boolean, relativePath: string): WriteResult {
  const exists = fs.existsSync(absPath);
  if (exists) {
    const current = fs.readFileSync(absPath, "utf8");
    if (current === contents) return { relativePath, action: "unchanged" };
    if (!overwrite) return { relativePath, action: "skipped-differs" };
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, contents, "utf8");
  return { relativePath, action: exists ? "updated" : "created" };
}

/** True once both files are present and hold exactly what we'd write today (i.e. no setup/update needed). */
export function isAgentSkillUpToDate(workspaceRoot: string): boolean {
  const skillPath = path.join(workspaceRoot, SKILL_RELATIVE_PATH);
  const docPath = path.join(workspaceRoot, AGENTS_DOC_RELATIVE_PATH);
  if (!fs.existsSync(skillPath) || !fs.existsSync(docPath)) return false;
  try {
    return (
      fs.readFileSync(skillPath, "utf8") === skillFileContents() &&
      fs.readFileSync(docPath, "utf8") === agentsDocContents()
    );
  } catch {
    return false;
  }
}

/** True if either file exists at all (even stale) \u2014 used to decide whether an overwrite needs confirming. */
export function agentSkillFilesExist(workspaceRoot: string): boolean {
  return (
    fs.existsSync(path.join(workspaceRoot, SKILL_RELATIVE_PATH)) ||
    fs.existsSync(path.join(workspaceRoot, AGENTS_DOC_RELATIVE_PATH))
  );
}

/** Inserts/updates the pointer block in a root AGENTS.md or CLAUDE.md, only if that file already exists \u2014 FTPilot doesn't create project-wide docs it doesn't own. */
function upsertPointerIn(absPath: string): WriteAction | "absent" {
  if (!fs.existsSync(absPath)) return "absent";
  const current = fs.readFileSync(absPath, "utf8");
  const block = pointerBlock();
  const startIdx = current.indexOf(POINTER_MARKER_START);
  const endIdx = current.indexOf(POINTER_MARKER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = current.slice(0, startIdx);
    const after = current.slice(endIdx + POINTER_MARKER_END.length);
    const next = before + block + after;
    if (next === current) return "unchanged";
    fs.writeFileSync(absPath, next, "utf8");
    return "updated";
  }
  const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(absPath, current + sep + block + "\n", "utf8");
  return "updated";
}

export interface SetupResult {
  results: WriteResult[];
  pointers: { relativePath: string; action: WriteAction | "absent" }[];
}

/**
 * Writes the Claude Code skill + the agent-agnostic doc, and refreshes the pointer block in
 * root AGENTS.md/CLAUDE.md if either already exists. `overwrite` controls whether files that
 * already exist with *different* content get replaced (the caller confirms with the user first
 * when `agentSkillFilesExist` was true).
 */
export function setupAgentSkill(workspaceRoot: string, overwrite: boolean): SetupResult {
  const results = [
    writeFileIfDifferent(path.join(workspaceRoot, SKILL_RELATIVE_PATH), skillFileContents(), overwrite, SKILL_RELATIVE_PATH),
    writeFileIfDifferent(path.join(workspaceRoot, AGENTS_DOC_RELATIVE_PATH), agentsDocContents(), overwrite, AGENTS_DOC_RELATIVE_PATH),
  ];
  const pointers = ["AGENTS.md", "CLAUDE.md"].map((name) => ({
    relativePath: name,
    action: upsertPointerIn(path.join(workspaceRoot, name)),
  }));
  return { results, pointers };
}
