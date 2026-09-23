# FTPilot Quick Reference

FTPilot builds your project and uploads it over FTP to one or more cPanel domains, from a dedicated git branch.

## Daily use (sidebar)

| Action | What it does |
|---|---|
| **Deploy All Targets** | Builds every target, then uploads what changed. |
| Cloud icon on a target | Builds and uploads only that target. |
| **Backup** | Downloads every target's remote files into `.ftbdeploy/backups/*.zip`. Changes nothing on the server. |
| **Full Re-upload** | Uploads every file again, ignoring what changed. |
| Pulse icon | Tests the FTP login and checks each target's remote folder exists. |
| Plug icon | Keeps a connection open (with keep-alive) until you disconnect. |

The branch row shows a check when you are on the deploy branch, and a warning when you are not. Deploying from another branch asks you first.

## Configuration (editor tab)

Open it with the gear icon. Changes are kept as a draft until you **Save Configuration**.

| Setting | Meaning |
|---|---|
| **Deploy Branch** | Deploys are meant to run from this branch only. |
| **Deployment Strategy** | *Incremental* uploads changed files and deletes files FTPilot uploaded earlier that no longer exist. *Full* overwrites everything and never deletes. |
| **Working Directory** | Folder where the build command runs, e.g. `apps/web`. |
| **Build Command** | e.g. `npm run build`. Leave blank if there is no build step. |
| **Build Output Directory** | Folder whose contents get uploaded, e.g. `apps/web/out`. |
| **Server Destination Directory** | Path on the FTP server, from the FTP account root, e.g. `/public_html`. |
| **cPanel / Passenger App Restart** | File touched after upload to restart a Node.js app, e.g. `/myapp/tmp/restart.txt`. |
| **Dedicated FTP Account** | For a subdomain with its own FTP login. |
| **Build Environment Variables** | Injected into the build. Secret values live in VS Code SecretStorage. |

## Where things are stored

- `.ftbdeploy/config.json`: settings, no secrets. Safe to commit.
- `.ftbdeploy/manifest.json`: what was uploaded last time. Gitignored automatically.
- Passwords and secret env values: VS Code SecretStorage, per project folder.

## Safety

- FTPilot never wipes a remote folder. Incremental mode only deletes files it uploaded itself.
- Other sites on the same cPanel account are never touched.
