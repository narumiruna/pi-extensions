# ☁️ pi-sync — R2/S3 Pi Settings Sync

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync)](https://www.npmjs.com/package/@narumitw/pi-sync) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-sync` is a native [Pi coding agent](https://pi.dev) extension that syncs selected Pi configuration through Cloudflare R2 or other S3-compatible object storage.

It syncs automatically by default when Pi starts, then uses immutable snapshot bundles, a `latest.json` pointer, local locking, secret scanning, and pre-apply backups. Conversation/session syncing is opt-in because session JSONL can contain prompts, tool output, paths, screenshots, and secrets. Cross-machine pushes use a best-effort remote re-read guard because R2 rejected conditional `latest.json` writes during testing.

## ✨ Features

- Opens every pi-sync action from the bare `/sync` menu and keeps direct `help`, `init`, `config`, `status`, `diff`, `doctor`, `push`, `pull`, `sync`, `history`, `rollback`, and `unlock` subcommands for automation and advanced flags.
- Syncs allowlisted Pi configuration from `~/.pi/agent`:
  - `settings.json`
  - `keybindings.json`
  - `models.json`
  - `AGENTS.md`
  - `APPEND_SYSTEM.md`
  - `skills/`, `prompts/`, `themes/`, and `extensions/`
  - optionally denylist-filtered `sessions/**/*.jsonl` when `syncSessions` is enabled
- Stores each remote version as an immutable gzip-compressed JSON snapshot bundle.
- Updates remote state through `latest.json` after re-reading remote state to reject already-visible remote changes.
- Creates local backups before `pull` and `rollback` under `~/.pi/agent/.pisync/backups/`.
- Runs `/sync sync` automatically on Pi startup when R2/S3 config is present.
- Uses a local exclusive lock at `~/.pi/agent/.pisync/lock` for destructive sync operations and only treats locks as stale after checking process liveness.
- Refuses to push common secret patterns and denylisted paths such as `.env`, `.env.local`, token/secret files, `.pisync`, `.git`, and `node_modules`.
- Preflights snapshot apply operations before mutating local files, refuses symlink path escapes, and rejects writes over symlinks or directories.

## 📦 Install

```bash
pi install npm:@narumitw/pi-sync
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-sync
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-sync
```

## ⚙️ Configuration

Run:

```text
/sync init
```

Then edit:

```text
~/.pi/agent/pi-sync.local.json
```

If `PI_CODING_AGENT_DIR` is set, pi-sync uses that directory instead of `~/.pi/agent` for config, state, backups, and synced files.

Example:

```json
{
  "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
  "bucket": "pi-sync",
  "region": "auto",
  "accessKeyId": "<access-key-id>",
  "secretAccessKey": "<secret-access-key>",
  "profile": "default",
  "prefix": "pi-sync",
  "autoSync": true,
  "syncSessions": false,
  "extraFiles": []
}
```

Environment variables override the local config file:

```bash
export PI_SYNC_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
export PI_SYNC_BUCKET="pi-sync"
export PI_SYNC_REGION="auto"
export PI_SYNC_ACCESS_KEY_ID="..."
export PI_SYNC_SECRET_ACCESS_KEY="..."
export PI_SYNC_SESSION_TOKEN="..." # optional, for temporary credentials that require a session token
export PI_SYNC_PROFILE="default"
export PI_SYNC_PREFIX="pi-sync"
export PI_SYNC_AUTO_SYNC="true"
export PI_SYNC_SESSIONS="false" # opt in with true to sync Pi conversation JSONL files
```

Set `extraFiles` to additional top-level file names to include beyond the default allowlist. Machines without a matching `extraFiles` entry preserve those remote files but do not apply or delete them locally.

`PI_SYNC_ACCESS_KEY_ID`, `PI_SYNC_SECRET_ACCESS_KEY`, and `PI_SYNC_SESSION_TOKEN` are local-only credentials. Do not put them in files that pi-sync syncs. `PI_SYNC_SESSION_TOKEN` is optional and only needed for temporary credentials such as AWS STS, AWS SSO, assumed roles, or S3-compatible providers that issue short-lived credentials.

Cloudflare R2 static access keys do not use a session token and usually reject requests signed with `X-Amz-Security-Token`. R2 temporary credentials that require a token are still supported. For R2 endpoints (`*.r2.cloudflarestorage.com`), pi-sync first sends the configured session token; if R2 rejects it with `InvalidArgument: X-Amz-Security-Token`, pi-sync retries that request once without the token and omits the token for the rest of the same command after a successful retry.

pi-sync also reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `R2_ENDPOINT`, and `R2_BUCKET` as compatibility aliases when the matching `PI_SYNC_*` variable is not set.

### Session syncing

`syncSessions` defaults to `false`. Set it to `true`, or set `PI_SYNC_SESSIONS=true`, to include Pi's configured session JSONL files in snapshots. pi-sync uses `PI_CODING_AGENT_SESSION_DIR`, Pi's `sessionDir` setting, or the default `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/**/*.jsonl` storage. Empty or misspelled `PI_SYNC_SESSIONS` values stay disabled. Only JSONL session files are included; other session-directory files and denylisted paths such as `.env*`, `.pisync`, `node_modules`, and names containing `token` or `secret` are ignored.

Session sync is snapshot-based, not live collaboration. If the same session changes on two machines, `/sync sync` uses the same conflict rules as settings sync and skips when both local and remote changed. Run `/sync diff`, then choose `/sync pull --force` or `/sync push --force` if needed.

When both `autoSync` and `syncSessions` are enabled, pi-sync syncs on startup and attempts a quiet session push on shutdown when local files changed. Startup session pulls happen after Pi has already selected the current session, so restart Pi or resume a pulled session to use newly synced conversations. If the remote changed first, the shutdown push is skipped with a warning instead of overwriting it.

Session files can contain prompts, model output, tool results, file paths, images, and secrets. Use trusted R2/S3 storage, keep credentials local, and recover local files from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/.pisync/backups/` if a pull or rollback overwrites something unexpectedly.

## 🚀 Usage

Run `/sync` without arguments to open the interactive menu containing every pi-sync action. Choosing rollback asks for the snapshot id before showing the existing confirmation. Cancelling either selection leaves sync state unchanged.

```text
/sync
```

The same actions remain available as direct routes for automation, non-interactive use, and advanced flags:

```text
/sync help
/sync init
/sync config
/sync status
/sync diff
/sync doctor
/sync push
/sync pull
/sync sync
/sync history
/sync rollback <snapshot-id>
/sync unlock --stale
```

Bare `/sync` reports command usage when an interactive UI is unavailable; use a direct route for the desired operation.

Useful flags:

- `--yes` / `-y`: skip confirmation prompts.
- `--force`: allow push or pull when both local and remote state changed.
- `--stale`: remove a stale local lock with `/sync unlock --stale`.

## 🔄 Automatic sync

`autoSync` defaults to `true`. When Pi starts, pi-sync runs the same conservative decision logic as `/sync sync`:

- only local changed or remote is empty → push
- first sync with existing local settings and an identical remote snapshot → initialize local sync state without rewriting files
- first sync with existing local settings and a different remote snapshot → skip and show a warning so you manually choose `/sync pull` or `/sync push`
- only remote changed after an established sync → pull with a backup
- both local and remote changed after a previous sync → skip and show a warning
- no config present → do nothing

Disable startup sync with either:

```json
{
  "autoSync": false
}
```

or:

```bash
export PI_SYNC_AUTO_SYNC=false
```

## 🧠 Sync model

Remote layout:

```txt
pi-sync/
└── profiles/
    └── default/
        ├── latest.json
        ├── history.json
        └── snapshots/
            └── 2026-05-21T12-00-00-000Z-abcd1234.json.gz
```

Each snapshot contains the selected file tree and SHA-256 hashes. `latest.json` points to the active snapshot. Rollback applies an older snapshot locally and moves `latest.json` back to that snapshot.

Before updating `latest.json`, pi-sync re-reads the current pointer and rejects the push if it already differs from the version seen at the start of the command. This prevents overwriting changes that are visible before the final write. It is not a true atomic cross-machine compare-and-swap on R2, so two machines that push at the same instant can still race; run `/sync status` before important manual pushes if you use multiple machines heavily.

## 🛡️ Safety notes

- pi-sync auto-syncs on startup by default, but skips instead of overwriting when first-run local settings and a remote snapshot both exist, or when both local and remote changed after a previous sync.
- With `syncSessions`/`PI_SYNC_SESSIONS` disabled, pi-sync does not collect or apply local Pi sessions, though settings-only pushes may preserve session files already present in remote snapshots. It never syncs OAuth state, npm caches, `.env`, `.env.local`, `node_modules`, or `.pisync` state.
- If another Pi process is already syncing on the same machine, destructive commands stop at the local lock. `/sync unlock --stale` is intended for locks whose process is gone or invalid.
- If another machine's update is visible before this machine updates `latest.json`, push is rejected unless you explicitly use `--force`.
- Pull and rollback create backups before writing local files, then preflight deletes and writes before mutating the local settings tree.
- Pull and rollback refuse to follow symlinked parent paths during snapshot apply and refuse to overwrite a symlink or directory with file content.

## 🗂️ Package layout

```txt
extensions/pi-sync/
├── src/
│   ├── index.ts       # Pi package entrypoint
│   ├── sync.ts        # Extension registration and command orchestration
│   └── *.ts           # Package-local config, snapshot, path, and S3 modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `sync.ts`; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, settings sync, Cloudflare R2, S3-compatible storage, snapshot sync, dotfiles sync.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
