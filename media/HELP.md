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
- Only the **most recent** deploy can be rolled back (then the one before it, and so on); undoing an older deploy while a newer one is live would break the site.
- **Roll Back This Deploy** appears on the finished card (success, failed health check, or a deploy that failed mid-upload). It puts those files back, deletes files the deploy created, restarts Node apps, restores FTPilot's upload record, and runs health checks.
- Also available from the Command Palette → **FTPilot: Roll Back a Deploy…** (copies kept for the last 3 deploys, in `.ftbdeploy/rollback/`, gitignored).
- If a file exists on the server but can't be downloaded, the deploy stops *before uploading anything*, so a rollback can never delete a file it didn't create.
- Database changes are not undone.

## Configuration (editor tab)

Open it with the gear icon. Changes are kept as a draft until you **Save Configuration**.

| Setting | Meaning |
|---|---|
| **Deploy Branch** | Deploys are meant to run from this branch only. |
| **Deployment Strategy** | *Incremental* uploads changed files and deletes files FTPilot uploaded earlier that no longer exist. *Full* overwrites everything and never deletes. |
| **Max Parallel Connections** | Upper limit for simultaneous uploads (1–10, default 8). FTPilot starts at 2, adds connections while it keeps getting faster, backs off if the server refuses, and remembers the best number per server. |
| **Exclude Patterns** | Files never uploaded, e.g. `*.map, *.d.ts` (the default). A pattern without `/` matches at any depth. Copies already on the server are left alone, never deleted. |
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

## Geek Mode (optional, off by default)

Turn on with Command Palette → **FTPilot: Toggle Geek Mode** (or Settings → `ftpilot.geekMode`). While it's off, no dashboard tab or buttons appear anywhere.

When on, a **Geek Mode Dashboard** tab appears in the FTPilot sidebar by itself — no need to open anything — and starts filling in live as soon as a deploy, backup, preview or rollback runs. Click the full-screen icon on that tab (or **FTPilot: Open Geek Mode Dashboard**) to pop the same live view out into a bigger editor tab instead.

- **Meters:** files/sec, throughput, connections in use, progress + ETA, average file time, errors/retries, and — whenever "Save a rollback copy before each deploy" is on for that run — a dedicated **Backup (rollback copy)** meter, separate from overall progress.
- **While a backup/rollback copy is being taken**, a callout above the meters spells it out in plain language ("Backing up the server's current files before uploading… (N / M)"), and the "Where the time went" chart marks that step in its own color.
- **Roll Back This Deploy** button, right on the dashboard, as soon as a run finishes — the same action as the sidebar's own button, so Geek Mode doesn't need a trip back to the sidebar to undo a bad deploy.
- **Charts:** files/sec and throughput over time, connections over time (with back-off markers), where the time went per target, connection lanes (every file on every connection), time vs file size, file-time distribution (median / p95)
- **Tables:** per target, by file type, slowest 10, largest 10, connection events, session details, build output tail

Hover any mark for exact values. The same charts are included in every deploy report, so they survive **Print → Save as PDF**.

## App Lock (on by default)

Protects against someone else picking up your unlocked laptop and clicking Deploy, or reading which logins are saved. On by default (`ftpilot.requireAuth`); asks again 15 minutes after your last unlock, or every time if you set `ftpilot.authTimeoutMinutes` to `0`.

- Gates: Deploy, Full Re-upload, Preview, Backup, Roll Back, Connect / Test, Test FTPS, and saving a new or changed FTP login or secret env value. Just *viewing* the configuration (including whether a login is saved) doesn't ask.
- **macOS:** Touch ID (or your configured biometric), via the same LocalAuthentication prompt macOS shows for System Settings.
- **Windows:** Windows Hello.
- **App password fallback:** used automatically if biometrics aren't available/enrolled, and always if you set the method to "App password only". It's a separate password from any FTP login, stored only as a salted hash (never in plain text, and never able to be read back — even by FTPilot).
- Turn off entirely with the "Require authentication…" toggle below — not recommended if anyone else can use this machine while it's unlocked.

### Changing App Lock settings

The shield icon in the panel title bar (or **FTPilot: App Lock Settings**) opens one menu for everything: turn App Lock on/off, switch between Touch ID/Windows Hello and app-password-only, set/change/remove the app password, change how long before it asks again, or lock right now. Picking an option applies it and reopens the menu so you can change more than one thing at once — press Escape to close it.

The first time FTPilot activates in a fresh install, it offers to open this menu directly — shown once, never again after that regardless of what you pick.

## Where things are stored

- `.ftbdeploy/config.json`: settings, no secrets. Safe to commit.
- `.ftbdeploy/manifest.json`: what was uploaded last time. Gitignored automatically.
- Passwords and secret env values: VS Code SecretStorage, per project folder — this is not a plain file. VS Code encrypts it with your OS's own credential store (macOS Keychain, Windows Credential Manager, or libsecret on Linux), the same mechanism apps like 1Password and browsers use, and it's tied to your OS login. FTPilot never writes a password to `config.json`, a log, or anywhere else on disk.
- The App Lock password (see above): also SecretStorage, but as a salted scrypt hash rather than the password itself.

## Safety

- FTPilot never wipes a remote folder. Incremental mode only deletes files it uploaded itself.
- Other sites on the same cPanel account are never touched.
