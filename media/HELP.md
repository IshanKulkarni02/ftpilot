# FTPilot Quick Reference

FTPilot builds your project and uploads it over FTP to one or more cPanel domains, from a dedicated git branch.

## Daily use (sidebar)

| Action | What it does |
|---|---|
| **Deploy All Targets** | Builds every target, then uploads what changed. |
| Cloud icon on a target | Builds and uploads only that target. |
| **Preview** (or eye icon on a target) | Builds and shows what a deploy *would* upload or remove (new / changed / deleted, size, estimated time). Uploads nothing. |
| **Compare with server** (on the preview card) | Also lists the server's files to catch edits made outside FTPilot (e.g. FileZilla). Such files aren't resent by a normal deploy; use Full Re-upload. Extra server files are never touched. |
| **Deploy These Changes** (on the preview card) | Uploads exactly what the preview showed, using the same build (no rebuild). |
| **Backup** | Downloads every target's remote files into `.ftbdeploy/backups/*.zip`. Changes nothing on the server. |
| **Full Re-upload** | Uploads every file again, ignoring what changed. |
| Pulse icon | Tests the FTP login and checks each target's remote folder exists. |
| **Cancel** (progress card) | Stops after the files currently uploading, or kills the running build. |
| Plug icon | Keeps a connection open (with keep-alive) until you disconnect. |

The branch row shows a check when you are on the deploy branch, and a warning when you are not. Deploying from another branch asks you first.

## Roll back

- Before uploading, FTPilot saves the server's current copy of every file the deploy will overwrite or delete (setting: **Save a rollback copy before each deploy**, on by default).
- **Roll Back This Deploy** appears on the finished card (success, failed health check, or a deploy that failed mid-upload). It puts those files back, deletes files the deploy created, restarts Node apps, restores FTPilot's upload record, and runs health checks.
- Older deploys: Command Palette → **FTPilot: Roll Back a Deploy…** (last 3 kept, in `.ftbdeploy/rollback/`, gitignored).
- If a file exists on the server but can't be downloaded, the deploy stops *before uploading anything*, so a rollback can never delete a file it didn't create.
- Database changes are not undone.

## Configuration (editor tab)

Open it with the gear icon. Changes are kept as a draft until you **Save Configuration**.

| Setting | Meaning |
|---|---|
| **Deploy Branch** | Deploys are meant to run from this branch only. |
| **Deployment Strategy** | *Incremental* uploads changed files and deletes files FTPilot uploaded earlier that no longer exist. *Full* overwrites everything and never deletes. |
| **Max Parallel Connections** | Upper limit for simultaneous uploads (1–10, default 8). FTPilot starts at 2, adds connections while it keeps getting faster, backs off if the server refuses, and remembers the best number per server. |
| **Exclude Patterns** | Files never uploaded, e.g. `*.map, *.d.ts` (the default). A pattern without `/` matches at any depth. |
| **Working Directory** | Folder where the build command runs, e.g. `apps/web`. |
| **Build Command** | e.g. `npm run build`. Leave blank if there is no build step. |
| **Build Output Directory** | Folder whose contents get uploaded, e.g. `apps/web/out`. |
| **Server Destination Directory** | Path on the FTP server, from the FTP account root, e.g. `/public_html`. |
| **cPanel / Passenger App Restart** | File touched after upload to restart a Node.js app, e.g. `/myapp/tmp/restart.txt`. |
| **Health Check URL** | Fetched after every deploy (3 tries, 5 s apart). Passes on HTTP 200–399. **Test** fetches it now. Optional "must contain" text is under Advanced options. |
| **Dedicated FTP Account** | For a subdomain with its own FTP login. |
| **Build Environment Variables** | Injected into the build. Secret values live in VS Code SecretStorage. |

## Encryption (FTPS)

- New projects use **FTPS (explicit TLS)**. Plain FTP sends your password and files unencrypted, so the sidebar marks it **Unencrypted**.
- On plain FTP, **Test FTPS** (in the configuration tab, under Protocol) tries an encrypted login with your saved credentials.
- Shared cPanel hosts often have a certificate for the *server's* hostname, not `ftp.yourdomain`. The test reads the certificate and offers **Use &lt;that hostname&gt;**, which is the safe fix.
- **Allow invalid or mismatched certificate** only appears after a certificate problem. It keeps encryption but skips verification, so use it only as a last resort.

## Where things are stored

- `.ftbdeploy/config.json`: settings, no secrets. Safe to commit.
- `.ftbdeploy/manifest.json`: what was uploaded last time. Gitignored automatically.
- Passwords and secret env values: VS Code SecretStorage, per project folder.

## Safety

- FTPilot never wipes a remote folder. Incremental mode only deletes files it uploaded itself.
- Other sites on the same cPanel account are never touched.
