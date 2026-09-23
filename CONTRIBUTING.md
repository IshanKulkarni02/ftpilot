# Contributing to FTPilot

Thanks for looking at this. FTPilot is maintained by [@IshanKulkarni02](https://github.com/IshanKulkarni02) — all PRs are reviewed by hand.

## Before you write code

For anything bigger than a small bug fix (new commands, new config fields, protocol/transport changes, UI reshuffles), **open an issue first** describing what you want to do and why. This avoids spending time on a PR that doesn't fit the project's direction. Small fixes and typos can go straight to a PR.

## Local setup

```bash
npm install
npm run compile   # tsc + webview syntax check
```

Then press **F5** in VS Code to launch an Extension Development Host with FTPilot loaded, or `npm run package` to build a `.vsix` and install it with `code --install-extension ftpilot-<version>.vsix --force`.

There's no automated test suite yet (contributions welcome) — verification is currently: `npm run compile` passes, and manual exercise of the affected command(s) in an Extension Development Host.

## Making a change

1. Fork the repo, branch off `main`
2. Make your change
3. Run `npm run compile` — must pass clean
4. Manually verify the affected feature in an Extension Development Host (F5)
5. Open a PR against `main` describing what changed and why, and how you tested it

## Code conventions

- TypeScript, strict mode (see `tsconfig.json`)
- No secrets ever written to disk — FTP credentials and secret-flagged env values go through `src/secrets.ts` (VS Code `SecretStorage`, OS-keychain backed). If your change touches credentials, keep it that way.
- Webview UI lives in `src/panel.ts` / `src/dashboard.ts` as template-literal HTML/JS — `scripts/check-webview.js` catches unescaped-quote breakage in that string at compile time; keep it passing.
- Match existing naming: commands are `ftpilot.*`, per-project config lives in `.ftbdeploy/`.

## Reporting bugs / requesting features

Use the issue templates. Include VS Code version, OS, and (for bugs) steps to reproduce. Don't paste real FTP hosts/credentials into an issue — redact them.

## Scope notes

Some things are deliberately out of scope right now (see project memory / past issue discussions) — e.g. SFTP/SSH is **not** planned; FTPilot targets plain-FTP and FTPS-capable cPanel hosts specifically. If you want to propose expanding scope, open an issue first.

## Code of conduct

Be respectful, assume good faith, keep discussion focused on the technical problem. Maintainer reserves the right to close issues/PRs that are off-topic, abusive, or out of scope.
