# FTPilot

<img src="media/logo-full.png" alt="FTPilot" width="360" />

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/IshanKulkarni.ftpilot?label=VS%20Marketplace&logo=visualstudiocode&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=IshanKulkarni.ftpilot) [![Installs](https://img.shields.io/visual-studio-marketplace/i/IshanKulkarni.ftpilot?color=007ACC)](https://marketplace.visualstudio.com/items?itemName=IshanKulkarni.ftpilot) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

### 👉 [Install FTPilot from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=IshanKulkarni.ftpilot)

Or in VS Code: `Ctrl/Cmd+P` → `ext install IshanKulkarni.ftpilot`

---

VS Code extension: build your project and FTP-deploy it to a cPanel server (or multiple domains/subdomains) with one click, from a dedicated `deploy` git branch.

## What it does

1. You work on a `deploy` branch (name configurable).
2. Click **Deploy** in the status bar (or run `FTPilot: Deploy / Redeploy`).
3. FTPilot runs each target's build command, diffs the output against the last deploy, and uploads only what changed over FTP — to as many domains/subdomains as you've configured (e.g. frontend on `app.example.com`, backend API on `api.example.com`).
4. If a target is a cPanel "Setup Node.js App" (Passenger) backend, it touches `tmp/restart.txt` after upload to restart it.

## Setup

1. Open your project folder in VS Code with this extension installed.
2. Run **FTPilot: Configure Project** from the Command Palette.
3. Answer the prompts: deploy branch name, FTP host/port/protocol, default FTP credentials, upload mode (incremental or full), then add one target per domain/subdomain (local build folder → remote folder, build command, optional Passenger restart file, optional separate FTP login for that subdomain).
4. This writes `.ftbdeploy/config.json` (safe to commit — no secrets in it) and opens it for review/editing.

Credentials are stored in VS Code's encrypted SecretStorage, never written to disk in the repo.

## Commands

- `FTPilot: Configure Project` — run the setup wizard
- `FTPilot: Deploy / Redeploy` — build + upload (also the status bar button)
- `FTPilot: Force Full Re-upload` — ignore the manifest, re-upload everything for every target
- `FTPilot: Set FTP Credentials` — set/update credentials for the default account or a per-target override account
- `FTPilot: Edit Config File` — open `.ftbdeploy/config.json`
- `FTPilot: Set Up AI Agent Deploy Skill (Claude Code, Copilot, …)` — see below
- `FTPilot: Scan Server Folder Structure` — see below

## AI agent setup (Claude Code, Copilot, …)

Run **FTPilot: Set Up AI Agent Deploy Skill** from the Command Palette (or the
banner in the FTPilot panel when it isn't set up yet). It writes two files
into your project, generated from the same source so they can't drift apart:

- `.claude/skills/ftpilot-target-setup/SKILL.md` — a Claude Code skill.
- `.ftbdeploy/AGENTS.md` — the same instructions in plain Markdown, for any
  other coding agent (Copilot, Cursor, Antigravity, …). If your project
  already has a root `AGENTS.md` and/or `CLAUDE.md`, a short pointer block is
  added there too (existing content is left untouched).

Once set up, telling your agent "this is ready to deploy" makes it fill in a
target's **Target Name**, **Working Directory** and **Build Command** in
`.ftbdeploy/config.json` by inspecting the project (package manager, build
script, framework output folder). It never touches `remoteDir`, `host`,
`port`, or FTP credentials — those stay your job, via the FTPilot panel or
`FTPilot: Set FTP Credentials`.

Both files are meant to be committed, so every contributor's coding agent —
and anyone who clones the repo later — gets the same behavior. Re-running the
command updates them to the latest version (it asks before overwriting local
edits).

### Filling in `remoteDir` too

`FTPilot: Scan Server Folder Structure` (Command Palette, or the list-tree
icon next to Connection in the panel) connects with your already-saved FTP
credentials and writes the server's **directory names only** — never file
contents, never the credentials themselves — to `.ftbdeploy/remote-tree.json`
(gitignored, since it reflects a live server at scan time).

The agent skill above reads that file if present and proposes `remoteDir` for
any target it can match unambiguously to a scanned folder, asking you to pick
when a match is ambiguous or missing. It never guesses a remote path without
that evidence. `host`/`port`/credentials are still entirely your job.

## Config reference (`.ftbdeploy/config.json`)

```jsonc
{
  "deployBranch": "deploy",
  "warnIfNotOnBranch": true,
  "host": "ftp.yourdomain.com",
  "port": 21,
  "secure": false,           // true = FTPS (explicit TLS)
  "uploadMode": "incremental", // or "full"
  "targets": [
    {
      "name": "Frontend (app.example.com)",
      "buildCommand": "npm run build",
      "cwd": "client",
      "localDir": "client/build",
      "remoteDir": "/app.example.com"
    },
    {
      "name": "Backend (api.example.com)",
      "buildCommand": "npm run build",
      "cwd": "server",
      "localDir": "server/dist",
      "remoteDir": "/api.example.com",
      "restartFile": "/api.example.com/tmp/restart.txt",
      "ftpUser": "api-subdomain-ftp-user"
    }
  ]
}
```

`ftpUser` is optional — set it only when that subdomain has its own separate FTP login. Set its password via `FTPilot: Set FTP Credentials` using that same username as the account name.

## Safety notes

- Incremental mode only ever deletes remote files that FTPilot itself uploaded in a previous deploy (tracked in `.ftbdeploy/manifest.json`, which is gitignored). It never wipes or clears a remote directory, so other projects/subdomains on the same cPanel account are never touched.
- Full mode overwrites files but also never deletes anything remote automatically.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press F5 in VS Code to launch an Extension Development Host and test commands there.

## Contributing

Bug reports, feature requests, and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow (open an issue before starting on anything non-trivial, so effort isn't wasted on something out of scope). Maintained by [@IshanKulkarni02](https://github.com/IshanKulkarni02).

## Status

Published on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=IshanKulkarni.ftpilot). Built for a MERN + TypeScript project deployed to Apache/cPanel over plain FTP. To run from source, press F5 in VS Code, or `npm run package` and "Install from VSIX".

## License

[MIT](LICENSE)
