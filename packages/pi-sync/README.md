# ☁️ pi-sync — Sync Pi Settings Across Machines

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync)](https://www.npmjs.com/package/@narumitw/pi-sync) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Sync selected Pi settings and content across machines through Git, WebDAV, Cloudflare R2, or another S3-compatible store.

Reusable storage connections hold credentials, while named sync setups define the exact remote path, included content, and automatic-sync behavior.

## ✨ Features

- Manages Git, WebDAV, Cloudflare R2, and general S3-compatible backends through `/sync`.
- Separates reusable storage connections from named sync setups and exact reviewed remote paths.
- Selects Pi roots, safe agent-relative paths, and the privacy-sensitive sessions root through one ordered include list.
- Protects changes with immutable snapshots, secret scanning, locks, conflict checks, pull backups, transactional apply, and recovery journals.
- Keeps snapshot selection portable and credential-free across environments.
- Writes settings atomically, preserves unknown fields, rejects stale edits, and fails closed on unsafe configuration.
- Loads a generated split runtime while preserving lazy UI and backend chunks.

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

The package declares `dist/index.ts`, so the build command must finish before Pi loads the local package directory.

An unbuilt checkout still declares `dist/index.ts`, but the generated entrypoint and chunks do not exist until the build completes.

## 🚀 Quick start

Run `/sync`, choose **Set up sync**, and review the storage connection, exact remote path, included content, automatic-sync choice, and masked credentials before saving.
Buckets and remote repositories must already exist.
Git uses existing non-interactive SSH or credential-helper configuration and never stores Git credentials.

## 🧭 Manager, conflicts, and recovery

The manager shows local state without contacting remote storage:

```text
Current sync setup: home
Storage: Cloudflare R2 · r2 · personal-pi
Included: 5 built-in groups · 0 extra files · Sessions off
Automatic sync: On
Remote status: Not checked
```

Primary actions include **Sync now**, **Switch sync setup**, **Status & changes**, **Settings**, and **More…**.
When pi-sync has already detected a synced-content-list mismatch, the manager instead shows **Sync status: Review needed**, puts **Review synced content (recommended)** first, and keeps **Sync now** visibly unavailable until the choice is reviewed.
Opening the manager still performs no new remote request.
The standard manager also owns setup and connection lists/details plus history and recovery.
Secondary screens provide **Back**; Escape goes back and Ctrl+C closes the flow.
Specialized operation and masked-credential prompts show the effective cancellation bindings and retain Ctrl+C as a hard-cancel input when Back is remapped.
Destructive, credential-bearing, and externally visible operations retain exact specialized previews and confirmations.

### Restore sync access

When an operation is currently running, the manager shows its command and process ID, keeps sync and settings changes unavailable, and puts **Refresh operation status** first.
When lock metadata is still protected by an active guard, the manager explains that another pi-sync process may be starting or finishing and asks the user to wait before refreshing.
It never offers lock removal while an owner or guard may still be active.

When a previous operation appears to have stopped without releasing its local lock, the manager shows **Sync paused** and puts **Restore sync access… (recommended)** first instead of hiding recovery inside **History & recovery…**.
Unreadable metadata receives a stronger warning because pi-sync cannot verify who owns it.
Close every other Pi session that may still be syncing, review the local-lock-only confirmation, then choose **Remove local lock and continue**.
The guarded recovery path rechecks metadata and ownership before removal, changes no settings, local files, sync state, or remote data, and returns directly to the normal manager when access is restored.
Cancellation leaves the lock unchanged.
If ownership changes or a guard is still expiring, pi-sync refuses removal and keeps actionable status available for refresh or retry.
The deterministic fallback remains `/sync unlock --stale` after the same no-other-sync verification.

### Resolve conflicts in the manager

When **Sync now**, **Pull from remote…**, or **Push to remote…** finds changes that require a human direction choice, the manager opens **Resolve sync conflict** instead of ending at a command-only error.
The flow names the current sync setup and explains whether local content, remote content, or the included-content policy changed.

An explicit remote content-list mismatch now opens **Synced content differs** inside the same manager flow.
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
RPC startup and direct routes remain read-only and notification-based, while print and JSON modes remain unsupported for `/sync` because their UI output is not observable.

## ⚙️ Settings

The canonical private user file is:

```text
~/.pi/agent/pi-sync.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
Missing settings load as unconfigured without creating an agent directory, file, temporary, or lock.
An explicit setup creates the file atomically.
On POSIX, pi-sync creates and replaces it with mode `0600`.
Pi-sync processes coordinate settings access through `pi-sync.json.mutation-lock`; lock-unaware editors are outside that serialization boundary and should not save the file while a pi-sync settings operation is running.
Credentials stay in this canonical private file and are never shown in menus, reviews, status, notifications, errors, logs, or completion metadata.

An existing private `pi-sync.local.json` containing a valid version 3 document is copied byte-for-byte to `pi-sync.json`; the old file remains as a recovery copy.
If both paths exist, `pi-sync.json` wins and the other path remains untouched.

### Complete version 3 example

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "storageConnections": {
    "r2": {
      "type": "s3",
      "endpoint": "https://example.r2.cloudflarestorage.com",
      "region": "auto",
      "credentials": {
        "accessKeyId": "<access-key-id>",
        "secretAccessKey": "<secret-access-key>"
      }
    },
    "github": {
      "type": "git",
      "remote": "git@github.com:owner/private-pi-sync.git"
    },
    "nextcloud": {
      "type": "webdav",
      "url": "https://cloud.example.com/remote.php/dav/files/user",
      "credentials": {
        "username": "user",
        "password": "<app-password>"
      }
    }
  },
  "syncSetups": {
    "home": {
      "storage": {
        "connection": "r2",
        "bucket": "personal-pi",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md", "skills", "prompts", "themes"],
        "automatic": true
      }
    },
    "git-backup": {
      "storage": {
        "connection": "github",
        "branch": "pi-sync/home",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
        "automatic": false
      }
    },
    "webdav-backup": {
      "storage": {
        "connection": "nextcloud",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "sessions"],
        "automatic": false
      }
    }
  }
}
```

Cloudflare R2 is persisted as `"type": "s3"`; R2 is a setup preset, not another schema type.
Temporary S3 credentials may additionally include `credentials.sessionToken`.

### Required backend shapes

- **S3/R2 connection:** `type`, `endpoint`, `region`, and `credentials.accessKeyId` / `credentials.secretAccessKey`.
- **S3/R2 setup storage:** `connection`, `bucket`, and complete relative `path`; `branch` is rejected.
- **Git connection:** `type` and a credential-free SSH or HTTPS `remote`.
- **Git setup storage:** `connection`, `branch`, and complete repository `path`; `bucket` is rejected.
- **WebDAV connection:** `type`, HTTPS `url`, and `credentials.username` / `credentials.password`.
- **WebDAV setup storage:** `connection` and complete relative `path`; `bucket` and `branch` are rejected.

Every setup requires `sync.include` and explicit `sync.automatic`.
`activeSyncSetup` must reference an own-property setup when any setups exist and must be absent when the setup catalog is empty.
A referenced connection cannot be removed.
The current setup must be switched before removal.
Two setups cannot resolve to the same normalized backend location.

`onSwitch` accepts:

- `ask-before-pull` — switch, then ask in TUI whether to start a reviewed pull;
- `pull-after-switch` — require observable UI and start the normal reviewed pull;
- `switch-only` — switch without reading or applying remote content.

### Included content

`sync.include` is ordered and duplicate-free.
Supported Pi roots are:

```text
settings.json, keybindings.json, models.json, AGENTS.md, APPEND_SYSTEM.md,
skills, prompts, themes, extensions, sessions
```

Safe agent-relative custom files or directories may also be included.
Absolute paths, `..`, backslashes, controls, denied secret/settings paths, duplicate case variants, and ambiguous nested paths under reserved roots are rejected.

An empty array is valid.
It means no useful transfer is selected: **Sync now** reports the condition and does not claim that the setup is up to date.
Unselected content remains unmanaged locally and is preserved when republishing existing remote snapshots.

The Included Content editor is a standard bounded multi-select backed by one in-memory draft.
Toggles never write settings.
**Add custom path…** accepts a safe agent-relative file or directory even when it does not exist locally yet, allowing a new environment to select content that exists only in the remote snapshot.
Leaving the editor opens an exact Include/Exclude review with **Save changes**, **Discard changes**, and **Continue editing**; only reviewed Save publishes, while Continue preserves the draft and Discard/cancellation preserves the settings bytes.
RPC remains a read-only summary with the manual `sync.include` path.

Every new snapshot stores the normalized included-content selection separately from the files that happened to exist.
This preserves selected-but-missing paths without syncing `pi-sync.json`, storage credentials, automatic-sync preferences, or setup names.
**Settings → Compare synced content** opens the same review-first flow as a manager operation when local and remote lists differ.
Adoption revalidates the remote head, immutable snapshot, reviewed storage coordinates, and local include list before one atomic settings update.
The saved state changes only `sync.include`, preserves unknown settings fields, and never pulls files or writes sync state.
Its explicit Continue action starts a fresh **Sync now** route, while **Done** leaves the reviewed settings change saved without implying a file operation.
Keeping this device's list opens the reviewed force-push path and explicitly replaces the remote policy while preserving eligible unmanaged remote files.

Automatic sync and pull, including forced pull, pause on an explicit remote-policy difference rather than silently expanding local scope.
Status reports matches and exact local-only/remote-only paths.
Old snapshots remain readable.
Because they have no authoritative selection, pi-sync offers only a clearly labeled read-only partial discovery from safe remote file roots; selected-but-missing and preserved-unmanaged intent cannot be reconstructed.
Use **Add custom path…** for any needed path.

Adding `sessions` requires a privacy acknowledgement in interactive flows.
Session JSONL can contain prompts, tool output, file paths, images, and secrets.
Automatic apply protects the currently open session file; restart Pi or resume a pulled session to use newly synchronized conversations.

### Unsupported old settings and recovery

Version 1, version 2, and non-empty unversioned documents are intentionally unsupported by this breaking schema reset. pi-sync does **not** migrate, partially interpret, downgrade, or overwrite them.
Automatic sync pauses and reports an actionable version 3 error without displaying secrets.

Recovery:

1. retain the old file byte-for-byte;
2. move it aside manually;
3. create a new version 3 document or run the setup manager;
4. run `/sync doctor`, inspect the exact storage path, and review the first pull or push;
5. restore the retained file and a compatible older package only if rolling back.

Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched.
Failed UI saves keep the previous file and displayed/effective state.

## 💬 Commands

The menu is preferred, while deterministic routes remain available:

```text
/sync help
/sync use <setup>
/sync init
/sync config [--setup <name>]
/sync files [--setup <name>]
/sync status [--setup <name>]
/sync diff [--setup <name>]
/sync doctor [--setup <name>]
/sync push [--setup <name>]
/sync pull [--setup <name>]
/sync sync [--setup <name>]
/sync history [--setup <name>]
/sync rollback <snapshot-id> [--setup <name>]
/sync migrate-state [--yes]
/sync unlock --stale
```

- `--setup <name>` addresses a setup without switching it.
- `--yes` / `-y` skips a direct route's confirmation.
- `--force` accepts a reviewed content conflict but never disables backend concurrency protection.
- `--stale` requests guarded stale-lock recovery.

The former version 2 setup-addressing flag is rejected.
Unknown flags, unknown commands, trailing values, and missing setup/snapshot values are rejected.
Completion includes known setup names and preserves preceding command tokens.

TUI mode uses standard manager, settings, resource, and included-content screens plus specialized secret, wizard, confirmation, and commit-aware loader components.
RPC uses Pi's supported dialog/notification protocol and does not gain settings mutation.
Print and JSON modes never enter TUI-only screens; unsupported interactive routes reject or remain protocol-safe rather than relying on no-op output.

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

## ♿ Conditional terminal accessibility smoke

Pi exposes terminal components rather than a semantic/ARIA tree.
Release validation checks textual state, keyboard operation, Escape/Back, control escaping, and narrow rendering.
Critical meaning appears in text such as `(current)`, `Review needed`, `Later`, `Warning`, `Invalid`, `Saved`, `Cancelled`, and `Applied`; color is supplementary.
The attention widget is informational and does not pretend to be a clickable control.

## 🗂️ Package layout

```text
packages/pi-sync/
├── dist/                    # Generated split TypeScript runtime loaded through Pi's Jiti loader
├── scripts/
│   └── build-runtime.mjs    # Deterministic bundler and eager-boundary validator
├── src/
│   ├── index.ts
│   ├── sync-extension.ts      # Lightweight Pi entry runtime and cached lazy loaders
│   ├── sync.ts                # Compatibility barrel for package-local helpers
│   ├── sync-errors.ts         # Lightweight setup/decision error contracts
│   ├── config.ts
│   ├── config-file.ts
│   ├── state-directory.ts
│   ├── settings-management.ts
│   ├── manager-ui.ts
│   ├── manager-state.ts
│   ├── manager-recovery.ts
│   ├── operation-availability.ts
│   ├── manager-attention.ts
│   ├── sync-attention.ts
│   ├── storage-connections-ui.ts
│   ├── sync-setups-ui.ts
│   ├── file-selection.ts
│   ├── remote-selection-ui.ts
│   ├── remote-snapshot.ts
│   ├── sync-operations.ts
│   ├── sync-backend.ts
│   ├── backend-factory.ts      # lazy selected-backend loader
│   ├── s3-backend.ts
│   ├── webdav-backend.ts
│   ├── git-backend.ts
│   ├── snapshot-paths.ts      # Eager recovery-safe session path helpers
│   ├── snapshot.ts            # Loaded only for snapshot operations/session push
│   └── *.ts
├── test/
├── README.md
├── LICENSE
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, settings sync, Git, WebDAV, Nextcloud, Cloudflare R2, S3-compatible storage, storage connections, sync setups, snapshot sync, dotfiles sync.

## 📄 License

MIT
