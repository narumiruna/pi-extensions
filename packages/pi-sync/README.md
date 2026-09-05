# ☁️ pi-sync — Sync Pi Settings Across Machines

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync)](https://www.npmjs.com/package/@narumitw/pi-sync) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Sync synchronizes selected Pi settings and content across machines through Git, WebDAV, Cloudflare R2, or another S3-compatible store.
Reusable storage connections hold credentials, while named sync setups define exactly what to sync, where to store it, and whether to sync automatically.

## ✨ Features

- Manages Git, WebDAV, Cloudflare R2, and general S3-compatible storage through `/sync`.
- Bundles the `setting-up-pi-sync` skill for guided, safety-first installation and first sync.
- Separates reusable storage connections from named setups with exact reviewed remote paths.
- Uses one ordered list for Pi roots, safe agent-relative paths, and privacy-sensitive sessions.
- Protects changes with immutable snapshots, secret scanning, locks, conflict checks, pull backups, transactional apply, and recovery journals.
- Keeps snapshot selection portable and free of credentials.
- Writes settings atomically, preserves unknown fields, rejects stale edits, and fails closed on unsafe configuration.
- Loads a generated split runtime with lazy UI and backend chunks.

## 📦 Install

```bash
pi install npm:@narumitw/pi-sync
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-sync
```

Build the generated runtime and try a local checkout:

```bash
npm --workspace @narumitw/pi-sync run build
pi -e ./packages/pi-sync
```

The package declares `dist/index.ts`, so an unbuilt checkout must run the build before Pi loads the package directory.

Extensions run with Pi's permissions, so install only packages from sources you trust.

## 🚀 Quick start

Run `/sync` and choose **Set up sync**.
Before saving, review the storage connection, exact remote path, included content, automatic-sync choice, and masked credentials.

Buckets and remote repositories must already exist.
Git uses existing non-interactive SSH or credential-helper configuration and never stores Git credentials.

The package also loads a setup skill automatically.
Ask Pi to set up pi-sync, or invoke it explicitly with `/skill:setting-up-pi-sync`.
The skill guides backend preparation, validation, and the reviewed first push or pull without asking for credentials in chat.
Secret access keys, session tokens, and WebDAV passwords use masked prompts; access key IDs and WebDAV usernames remain visible during input, so avoid entering them during screen sharing or recording.
For temporary S3 or R2 credentials, choose **Store temporary credentials privately** to include the required session token; use the storage connection's **Change credential source** flow to replace expired credentials.

## 🧭 Manager, conflicts, and recovery

The `/sync` manager shows local state without contacting remote storage:

```text
Current sync setup: home
Storage: Cloudflare R2 · r2 · personal-pi
Included: 5 built-in groups · 0 extra files · Sessions off
Automatic sync: On
Remote status: Not checked
```

Primary actions include **Sync now**, **Switch sync setup**, **Status & changes**, **Settings**, and **More…**.

After Pi Sync detects an included-content mismatch, the manager shows **Sync status: Review needed** and puts **Review synced content (recommended)** first.
**Sync now** remains unavailable until you review the mismatch.
Opening the manager does not make another remote request.
The manager also provides setup and connection details, history, and recovery.

On secondary screens, **Back** and Escape return to the previous screen, while Ctrl+C closes the flow.
Specialized operation and masked-credential prompts show the effective cancellation bindings and keep Ctrl+C as a hard-cancel input when Back is remapped.
Destructive, credential-bearing, and externally visible operations show exact previews and confirmations.

### Restore sync access

While an operation is running, the manager shows its command and process ID, disables sync and settings changes, and puts **Refresh operation status** first.
When an active guard still protects lock metadata, the manager asks you to wait because another Pi Sync process may be starting or finishing.
It never offers lock removal while an owner or guard may still be active.

If a stopped operation leaves its local lock behind, the manager shows **Sync paused** and puts **Restore sync access… (recommended)** first.
Unreadable metadata receives a stronger warning because Pi Sync cannot verify its owner.
Close every other Pi session that may still be syncing, review the local-lock-only confirmation, and choose **Remove local lock and continue**.
Before removal, the guarded recovery path rechecks metadata and ownership.

Successful recovery changes no settings, local files, sync state, or remote data and returns to the normal manager.
Cancellation leaves the lock unchanged.
If ownership changes or a guard is still expiring, Pi Sync refuses removal and keeps refresh or retry available.
After the same no-other-sync verification, `/sync unlock --stale` provides a deterministic fallback.

### Resolve conflicts in the manager

When **Sync now**, **Pull from remote…**, or **Push to remote…** requires a direction choice, the manager opens **Resolve sync conflict**.
The flow names the current setup and explains whether local content, remote content, or the included-content policy changed.

An explicit remote content-list mismatch opens **Synced content differs** in the same manager flow.
Nothing changes until you choose an action.
Choose **Review all paths (recommended)** first to compare exact remote-only paths, device-only paths, and both ordered lists.
If membership matches but order differs, the review says that only ordering differs.
Then choose one action:

- **Use remote content list** revalidates the remote snapshot and reviewed local setup before saving only `sync.include`.
  **Remote content list saved** confirms that no files were pulled and offers a separate **Continue Sync/Pull/Push now…** action plus **Done**.
  Continue starts a fresh operation and exact preview for the captured setup rather than resuming stale work.
- **Keep this device's content list and update remote…** opens the existing `push --force` preparation and exact confirmation without `--yes`.
  Cancelling preparation or confirmation returns to the content-list choice without changing remote data.
- **Cancel** returns to the manager without changing settings, files, remote data, or sync state.
- **Later** appears when automatic startup sync detected the mismatch and returns immediately to the Pi editor without changing anything.

Choose **Review differences (recommended)** in an ordinary file-direction conflict to inspect the exact affected paths without changing local files, remote data, or sync state.
Then choose one reviewed direction:

- **Keep local content and replace remote…** uses the existing forced-push path.
  It scans managed local files for secrets, shows the exact remote publication effect, re-reads a changed remote head, and asks again if the reviewed plan changed.
- **Use remote content and replace local…** uses the existing forced-pull path.
  It shows exact local writes and deletions, protects the live session, and creates a local backup before applying.
- First sync uses **Use local as initial source…** and **Use remote as initial source…** labels.
  An empty remote offers **Push local content…** only.

Cancelling a preparation or confirmation returns to conflict resolution with no side effects.
Back returns to the sync manager, and Ctrl+C closes the complete flow.

When automatic startup sync detects an explicit content-list mismatch in TUI mode, it opens **Synced content differs** once for that session instead of ending at a warning.
Choosing **Later** or closing the flow leaves a compact **Pi Sync needs review** widget above the editor and a **review needed** footer status.
The attention state is in memory only, contains no credentials or file contents, and is revalidated before any settings or remote mutation.
It clears after verified resolution, invalidation, session replacement, or shutdown.

Interactive TUI `/sync sync`, `/sync pull`, and `/sync push` routes without `--yes` open the same review flow when they detect the mismatch.
Explicit `--yes` routes remain non-interactive and report exact remote-only, device-only, or order-only guidance while leaving visible attention for later review.
Shutdown automatic sync never opens a dialog because Pi is exiting.
RPC startup mismatch review remains read-only and notification-based.
Print and JSON modes do not support `/sync` because UI output is not observable there.

## ⚙️ Settings

Run `/sync` → **Set up sync** to create the canonical private user file at `<getAgentDir()>/pi-sync.json` (normally `~/.pi/agent/pi-sync.json`).
Use **Settings** to manage an existing setup.
Missing settings stay unconfigured without creating files or locks.

A minimal Git setup uses an existing private remote and keeps automatic sync off:

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "storageConnections": {
    "github": {
      "type": "git",
      "remote": "git@github.com:owner/private-pi-sync.git"
    }
  },
  "syncSetups": {
    "home": {
      "storage": {
        "connection": "github",
        "branch": "pi-sync/home",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
        "automatic": false
      }
    }
  }
}
```

Setup saves are atomic and private (`0600` on POSIX), preserve unknown fields, and coordinate across pi-sync processes.
Do not save from a lock-unaware editor during a pi-sync settings operation.
Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched.
Version 1, version 2, and non-empty unversioned settings require manual recovery rather than automatic migration.

Adding `sessions` can upload prompts, tool output, paths, images, and secrets; interactive flows require a privacy acknowledgement.
Automatic sync and pull pause when the remote included-content policy differs instead of silently expanding local scope.

Read the [settings reference](./docs/settings.md) for complete S3/R2, Git, and WebDAV examples, backend fields, included-content rules, legacy paths, and recovery steps.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/sync` | Set up storage, manage synced content, and review sync operations or recovery. |
| `/sync help` | Show command usage. |
| `/sync use <setup>` | Switch the active local sync setup, following its switch policy. |
| `/sync init` | Create a local configuration template. |
| `/sync config` | Show resolved configuration. |
| `/sync files` | List included local files. |
| `/sync status` | Compare local and remote snapshot state. |
| `/sync diff` | Show local and remote differences. |
| `/sync doctor` | Check configuration, connectivity, and backend safety. |
| `/sync push` | Publish local content to remote storage. |
| `/sync pull` | Back up local content, then apply the remote snapshot. |
| `/sync sync` | Choose a safe sync direction or require conflict review. |
| `/sync history` | Browse remote snapshots and review a rollback. |
| `/sync rollback <snapshot-id>` | Back up local content, apply a historical snapshot, and republish it remotely. |
| `/sync migrate-state` | Migrate the legacy local state directory. |
| `/sync unlock --stale` | Recover an abandoned local lock after guarded ownership checks. |

All routes support TUI and RPC; RPC settings and included-content screens are read-only.
Print and JSON modes reject `/sync`.
Unknown commands or flags, trailing values, and missing setup/snapshot values are rejected, including the former version 2 setup-addressing flag.

- `--setup <name>` targets a setup without switching it on `config`, `files`, `status`, `diff`, `doctor`, `push`, `pull`, `sync`, `history`, and `rollback`.
- `--yes` (alias: `-y`) skips confirmation on `push`, `pull`, `sync`, `rollback`, and `migrate-state`; use only after reviewing the affected content.
- `--force` lets `push` or `pull` accept content conflicts without disabling backend concurrency protection. It is also accepted by `sync`, which still requires a direction choice for divergent content, and by `rollback`, where it has no additional effect.
- `--stale` is accepted only by `unlock` and is required to remove a stale lock.

Push and rollback publish data externally; pull and rollback can replace or delete local managed files.
Review [Settings](#-settings) for included-content privacy and [Manager, conflicts, and recovery](#-manager-conflicts-and-recovery) before forcing a direction, skipping confirmation, or removing a lock.

## 🔄 Backend and recovery model

| Backend | Publication guarantee | Authentication | Remote path |
| --- | --- | --- | --- |
| Git | Exact expected-ref lease | Existing SSH/configured credential helper | `<branch>:<storage.path>` |
| WebDAV | Verified strong conditional requests | Private settings username/app password | `<url>/<storage.path>` |
| R2/S3 | Read-check-write-verify | Private settings credentials | `<bucket>/<storage.path>` |

Git requires Git 2.30 or newer and a SHA-1-format remote repository.
HTTPS userinfo, URL passwords, local paths, `file`, `git`, `ext`, and remote-helper transports are rejected.
When editing a Git setup, changing its storage path also requires a new owned branch so the existing branch remains readable at its reviewed path.
The private bare cache under `<agent-dir>/pi-sync/git/` is rebuildable.

WebDAV requires HTTPS except loopback tests.
URL credentials, query strings, fragments, unsafe redirects, weak/missing ETags, and ignored conditional headers fail closed.
`/sync doctor` verifies collection and conditional-write behavior with an isolated probe.

S3/R2 stages immutable bundles, rechecks the visible head before publication, and verifies afterward.
Unlike Git/WebDAV, generic S3 does not provide an atomic compare-and-swap for `latest.json`; status review remains important for simultaneous writers.

Before pull or rollback, pi-sync writes a backup under `<agent-dir>/pi-sync/backups/`.
Apply preflights paths and checksums, journals all mutations, restores the prior state after failures, and recovers interrupted journals on startup.
Removing a local setup or connection never deletes remote data.

The operational state root is `<agent-dir>/pi-sync/`.
An existing installation continues using `<agent-dir>/.pisync/` and shows migration guidance on startup; it is never moved merely because no sync is active.
Close every other Pi process, then run `/sync migrate-state` and confirm the review (or pass `--yes` for an already reviewed RPC workflow).
The command serializes against every upgraded state/cache user and atomically renames `.pisync/` only when no legacy sync lock or guard is active.
Close Pi instances running older pi-sync versions during the migration because they do not understand the migration guard.
If both roots exist, or either root is a symlink or non-directory, pi-sync refuses stateful work instead of merging, following, or deleting data.
Preserve both roots before manual recovery; with every Pi process closed and no destination conflict, rollback is an atomic rename from `pi-sync/` back to `.pisync/`.

## 🔒 Security and privacy

- Canonical, legacy, temporary, and recovery settings paths are denied from snapshots; both `pi-sync/` and `.pisync/` state roots are permanently denied.
- Push scans managed local content for common secret patterns.
- Remote snapshot references, checksums, paths, manifests, response sizes, and publication revisions are validated.
- Symlink parents, path escapes, duplicate paths, and unsafe file/directory replacement fail before local mutation.
- Live locks block mutation; stale recovery rechecks process and guard ownership.
- Cancellation aborts preparation and dialogs.
  Publication/apply commit boundaries finish with bounded signals and report ambiguous outcomes explicitly.
- Terminal-bound names, paths, metadata, and errors are control-character sanitized.

## ♿ Terminal accessibility

Pi exposes terminal components rather than a semantic or ARIA tree.
Release checks cover textual state, keyboard operation, Escape and Back behavior, control escaping, and narrow rendering.
Critical meaning appears in text such as `(current)`, `Review needed`, `Later`, `Warning`, `Invalid`, `Saved`, `Cancelled`, and `Applied`.
Color is supplementary, and the attention widget is informational rather than interactive.

## 🗂️ Package layout

```text
packages/pi-sync/
├── src/                               # Backends, settings, snapshots, and recovery modules
│   ├── index.ts                       # Thin Pi entrypoint
│   └── sync-extension.ts              # Sync lifecycle and lazy loading
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
├── skills/setting-up-pi-sync/          # Bundled guided setup skill
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, settings sync, Git, WebDAV, Nextcloud, Cloudflare R2, S3-compatible storage, storage connections, sync setups, snapshot sync, dotfiles sync.

## 📄 License

[MIT](./LICENSE)
