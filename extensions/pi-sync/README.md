# ☁️ pi-sync — R2/S3 Pi Settings Sync

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync)](https://www.npmjs.com/package/@narumitw/pi-sync) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-sync` is a native [Pi coding agent](https://pi.dev) extension that syncs selected Pi configuration through Cloudflare R2 or other S3-compatible object storage.

It uses immutable snapshot bundles, a `latest.json` pointer, local locking, secret scanning, and pre-apply backups so multiple Pi processes and multiple machines fail safely instead of silently overwriting settings.

## ✨ Features

- Adds a `/pisync` command with `status`, `diff`, `push`, `pull`, `sync`, `history`, `rollback`, `doctor`, and `unlock` subcommands.
- Syncs allowlisted Pi configuration from `~/.pi/agent`:
  - `settings.json`
  - `keybindings.json`
  - `models.json`
  - `AGENTS.md`
  - `skills/`, `prompts/`, `themes/`, and `extensions/`
- Stores each remote version as an immutable gzip-compressed JSON snapshot bundle.
- Updates remote state through `latest.json`, guarded by S3 conditional writes when possible.
- Creates local backups before `pull` and `rollback` under `~/.pi/agent/.pisync/backups/`.
- Uses a local exclusive lock at `~/.pi/agent/.pisync/lock` for destructive sync operations.
- Refuses to push common secret patterns and denylisted paths such as `.env`, token/secret files, `.pisync`, `.git`, and `node_modules`.

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
/pisync init
```

Then edit:

```text
~/.pi/agent/pi-sync.local.json
```

Example:

```json
{
  "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
  "bucket": "pi-sync",
  "region": "auto",
  "accessKeyId": "<access-key-id>",
  "secretAccessKey": "<secret-access-key>",
  "profile": "default",
  "prefix": "pi-sync"
}
```

Environment variables override the local config file:

```bash
export PI_SYNC_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
export PI_SYNC_BUCKET="pi-sync"
export PI_SYNC_REGION="auto"
export PI_SYNC_ACCESS_KEY_ID="..."
export PI_SYNC_SECRET_ACCESS_KEY="..."
export PI_SYNC_PROFILE="default"
export PI_SYNC_PREFIX="pi-sync"
```

`PI_SYNC_ACCESS_KEY_ID` and `PI_SYNC_SECRET_ACCESS_KEY` are local-only credentials. Do not put them in files that pi-sync syncs.

## 🚀 Usage

```text
/pisync config
/pisync doctor
/pisync status
/pisync diff
/pisync push
/pisync pull
/pisync sync
/pisync history
/pisync rollback <snapshot-id>
/pisync unlock --stale
```

Useful flags:

- `--yes` / `-y`: skip confirmation prompts.
- `--force`: allow push or pull when both local and remote state changed.
- `--stale`: remove a stale local lock with `/pisync unlock --stale`.

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

## 🛡️ Safety notes

- pi-sync does not auto-apply remote changes on startup.
- pi-sync does not sync Pi sessions, OAuth state, npm caches, `.env`, `node_modules`, or `.pisync` state.
- If another Pi process is already syncing on the same machine, destructive commands stop at the local lock.
- If another machine updates remote state first, push is rejected unless you explicitly use `--force`.
- Pull and rollback create backups before writing local files.

## 🗂️ Package layout

```txt
extensions/pi-sync/
├── src/
│   └── sync.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/sync.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, settings sync, Cloudflare R2, S3-compatible storage, snapshot sync, dotfiles sync.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
