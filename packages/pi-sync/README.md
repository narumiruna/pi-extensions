# ☁️ pi-sync — Sync Pi Settings Across Machines

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync)](https://www.npmjs.com/package/@narumitw/pi-sync) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Sync synchronizes selected Pi settings and content across machines through Git, WebDAV, Cloudflare R2, or another S3-compatible store.
Reusable storage connections hold credentials, while named sync setups define exactly what to sync, where to store it, and whether to sync automatically.

## ✨ Features

- Manages Git, WebDAV, Cloudflare R2, and general S3-compatible storage through `/sync`.
- Separates reusable storage connections from named setups with exact reviewed remote paths.
- Uses one ordered list for Pi roots, safe agent-relative paths, and privacy-sensitive sessions.
- Protects changes with immutable snapshots, secret scanning, locks, conflict checks, pull backups, transactional apply, and recovery journals.
- Keeps snapshot selection portable and free of credentials.
- Writes settings atomically, preserves unknown fields, rejects stale edits, and fails closed on unsafe configuration.
- Offers default-off experimental Agent mode for autonomous, validated text/settings conflict resolution, with a separate Continuous sync opt-in for monitoring and recovery.
- Loads a generated split runtime with lazy UI and backend chunks.
- Bundles a manual-only skill for configuration questions and safe setup guidance.

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

Use a Pi runtime that satisfies this package’s declared peer floor. Installing an extension dependency does not upgrade a separately installed Pi runtime. The declared Kit floor supplies exact scrolling/paginated review and configured-keybinding support.

## 🚀 Quick start

Run `/sync` and choose **Set up sync**.
Name the setup once; its first storage connection uses the same name.
Input prompts show examples or an explicit default that you can accept by submitting an empty value; cancelling never accepts a default.
Remote URLs, endpoints, usernames, and credentials require your own values, not the displayed examples.
All new setups default to storage path `./`: the Git repository root, the WebDAV collection URL, or the selected R2/S3 bucket root.
Git also suggests branch `main`.
Use different folders or prefixes for independent setups sharing a WebDAV collection or bucket; existing settings and paths are unchanged.
If another configured setup already uses the chosen location, setup asks for a different path before the content selection and review; Git requires a different branch, even when the directory differs.
Every new setup asks for included content and automatic sync; automatic sync is off unless you enable it. Recommended includes nine Pi roots; Minimal includes `settings.json` and `AGENTS.md`. Sessions stay off unless explicitly included with a privacy acknowledgement.
Before saving, scroll through the exact destination, every included path, automatic-sync choice, and hidden-credential summary. R2/S3 always asks for an existing bucket; an example bucket name is not a default.

Invalid fields ask for a correction without restarting setup. A temporary local save failure keeps the review for another Save; changed settings require reopening and reviewing the current values. Saving only changes local settings, not remote data. A connection saved through **Add a new storage connection…** remains saved if you later cancel the setup.

Buckets and remote repositories must already exist.
Git uses existing non-interactive SSH or credential-helper configuration and never stores Git credentials.
It owns the entire selected branch: use an empty repository or a new branch if `main` already contains unrelated content.
At `./`, Git stores `manifest.json` and `files/` at the repository root; it does not modify your local working tree.
WebDAV and R2/S3 store `latest.json`, `history.json`, and `snapshots/` directly under their selected root, not under a literal `./` prefix.

## 🧭 Manager, conflicts, and recovery

The `/sync` manager shows local state without contacting remote storage:

```text
Current sync setup: home
Storage: Cloudflare R2 · r2 · personal-pi
Included: 5 built-in groups · 0 extra files · Sessions off
Automatic sync: On (startup check; shutdown pushes selected content if sessions included)
Remote status: Not checked
```

Use **Sync now** for bidirectional merging, or **Pull from remote…** and **Push to remote…** for reviewed directional transfers. **Settings**, **History**, and **Diagnostics** are also directly available. Switching appears only when multiple valid setups exist; review and access-recovery actions appear when needed. Pull and Push do not implicitly force overwrites.

The main summary separates current state from actions and uses local state and cached check-time observations, not a fresh remote comparison. Choose **Check remote status** for a fresh read/check or **View differences** for file differences; `/sync status`, `/sync diff`, and `/sync help` remain available. Last applied shows a compact snapshot ID and states when application time is unavailable; History retains full IDs.

After Pi Sync detects an included-content mismatch, the manager shows **Sync status: Review needed** and puts **Review synced content (recommended)** first.
**Sync now** remains unavailable until you review the mismatch.
Opening the manager does not make another remote request.
**Settings** groups rows under **Sync content**, **Sync behavior**, **Storage & setups**, and **Advanced**. **All settings (search)** retains cross-category typing-to-search. **Compare included paths** sits beside **Included paths** and compares path policies, not file contents. **Storage location** edits only the current setup's bucket, branch, or path; it does not change the connection or included content. **Manage sync setups** and **Manage storage connections** open the existing catalogs. Connections hold reusable server addresses and sign-in details, and edits show every affected setup. Make another setup current before changing its preferences. Each description identifies the setup, device-wide, or shared-connection scope. Simple preferences report saving and durable save results; Back does not undo saved changes. Complex editors and risky changes retain their reviews. RPC reports the manual settings path and preserves catalog management without opening the TUI preference editor.

**Diagnostics** (also `/sync doctor`) reports configuration and backend-specific access checks. S3/R2 performs a read-only request: success does not prove write access or snapshot validity, and an ambiguous 404 does not prove a bucket is missing. Check the indicated credentials, address, bucket, or path before retrying. Git checks remote reads and the local cache, not write access. WebDAV uses an isolated write/cleanup probe and repairs the active snapshot's history entry if missing. **History** opens the snapshot list directly for reviewed rollback. Recorded unresolved groups have a separate **Review unresolved conflicts** action.

On secondary menus, **Back** and Escape return to the previous screen. In setup inputs and save reviews, cancellation (including Ctrl+C) discards the current unsaved draft and returns to its owning menu. Session replacement or shutdown closes the owning flow.
Specialized operation and masked-credential prompts show the effective cancellation bindings and keep Ctrl+C as a hard-cancel input when Back is remapped.
Destructive, credential-bearing, and externally visible operations show exact previews and confirmations, except transfers explicitly authorized by automatic-transfer policy or experimental Agent mode.

### Review transfer changes

A merged **Sync now** transfer shows one confirmation with separate local and remote file changes, remote snapshot publication, session inclusion, and unresolved groups. **No, cancel** is initially selected in TUI mode. On short or narrow terminals, the configured navigation keys first scroll the summary. **Yes** can apply changes only after every summary row has been displayed. A terminal resize resets the review and selects **No**. Cancellation remains available throughout. This scrollable summary intentionally replaces Kit's clipped choice context, and the safe default differs from Pi's native Yes-first confirmation.

**View details** is optional. It shows the complete add/update/delete lists and unresolved paths in an exact scrolling review, or bounded pages in RPC. The review cannot apply changes. Back or Escape returns to confirmation with **No** selected; Ctrl+C cancels the whole TUI flow. RPC offers No first but the client controls visual selection, and protocol cancellation from details returns to confirmation. Session replacement or shutdown closes the flow; local files and remote state are rechecked before transfer.

Unresolved paths stay unchanged on each side. A backup and recovery journal protect the transfer; resources do not reload automatically. Remote snapshot publication is shown separately because it can occur without file-content changes. File lists on the main screen are shortened when needed; details retain every path. `--yes` and automatic-transfer policy are unchanged. Interactive TUI Push and Pull use the same safe-default scrollable confirmation with exact directional add/update/remove counts and paths. Loaded sessions are excluded from local change counts. Pull and rollback also list case-variant path cleanup; changed aliases invalidate approval. Push describes changes to the active immutable snapshot, not physical deletion of retained history. RPC and History rollback keep their existing confirmation protocols, with the complete directional summary. Local bytes, settings, baseline, and remote head are rechecked before applying a reviewed transfer.

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

**Sync now** merges independent file additions, edits, and deletions against an established baseline. Equal concurrent edits are accepted. With experimental settings field merge enabled, supported `settings.json` fields can also merge using a verified accepted ancestor; arrays, nested objects and coupled fields remain atomic. Other divergent file edits, delete/modify conflicts, protected-session changes, selection changes, and case/file-directory collisions still require review; one unresolved path stops the entire merged transfer unless experimental partial sync is explicitly enabled. Explicit push and pull remain directional.

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

Choose **Review differences (recommended)** in an ordinary file-direction conflict to inspect the exact affected paths without changing local files, remote data, or sync state.
Then choose one reviewed direction:

- **Keep local content and replace remote…** uses the existing forced-push path.
  It applies the [secret-scan setting](./skills/configure-pi-sync/references/configuration.md#secret-scanning), shows the exact remote publication effect, re-reads a changed remote head, and asks again if the reviewed plan changed.
- **Use remote content and replace local…** uses the existing forced-pull path.
  It shows exact local writes and deletions, protects the live session, and creates a local backup before applying.
- First sync uses **Use local as initial source…** and **Use remote as initial source…** labels.
  An empty remote offers **Push local content…** only.

Cancelling a preparation or confirmation returns to conflict resolution with no side effects.
Back returns to the sync manager, and Ctrl+C closes the complete flow.

Startup checks never open a dialog. While checking, TUI and RPC status show **sync ...**. With a sync baseline and no content-list mismatch, they use **sync ⇡** for local changes to push and **sync ⇣** for remote changes to pull. Review conditions use **sync ⇕**; in TUI, a persistent widget above the editor also identifies both sides changing, first sync with an existing remote snapshot, a differing content list (including order-only differences), or a missing remote snapshot despite an existing baseline. Both sides changing is a reason to review, not a confirmed file conflict.
No selected content and first sync with an empty remote stay quiet outside `/sync`, which provides setup or initialization guidance. Legacy remote metadata without an authoritative content list does not independently trigger a widget for observation-only checks. With **Startup transfer** enabled, an established legacy remote instead shows review attention and requires an explicit direction to adopt the content policy; no automatic transfer runs. An included-content mismatch puts **Review synced content (recommended)** in the manager, where a fresh review verifies the remote snapshot before offering changes.
Check results are advisory observations against the last sync baseline, not proof of a file conflict or current equality. Opening the manager uses local information and shows when the check completed; it does not contact remote storage. Transfer actions recheck current content.
The widget has no expiry timer. Attention stays in memory and is invalidated by relevant settings/state changes or a foreground transfer's commit boundary, and cleared on session replacement or shutdown. A newer observation replaces the presentation, clearing the widget when only status or no reminder is needed. Cancelling a review or a failure before commit preserves a still-valid observation and its appropriate presentation.

Interactive TUI `/sync sync`, `/sync pull`, and `/sync push` routes without `--yes` open the same review flow when they detect the mismatch.
Explicit `--yes` routes remain non-interactive and report exact remote-only, device-only, or order-only guidance while leaving visible attention for later review.
Shutdown automatic sync never opens a dialog because Pi is exiting.
RPC startup checks use status for one-sided changes and nonblocking warning notifications for review conditions; included-content review remains read-only.
Print and JSON modes do not support `/sync` because UI output is not observable there.

## ⚙️ Settings

Run `/sync` → **Set up sync** to create the canonical private user file at `<getAgentDir()>/pi-sync.json` (normally `~/.pi/agent/pi-sync.json`).
Use **Settings** to manage an existing setup.
Missing settings stay unconfigured without creating files or locks.

### Debug startup timings

Set the top-level `"debug": true` in `pi-sync.json`, or enable **Settings → Advanced → Debug startup timings**, then restart Pi or use `/reload`.
The default is `false`. Timing reports appear in TUI/RPC notifications, not the model context or a log file.
See [Debug startup timings](./skills/configure-pi-sync/references/configuration.md#debug-startup-timings) for measured stages and limits.

### Background startup checks

With **Automatic sync** enabled, session startup schedules a background check instead of waiting for a transfer. Pi remains usable while Git, WebDAV, R2, or S3 checks local hashes and remote metadata. Results follow the [status and review classifications](#resolve-conflicts-in-the-manager); check failures provide `/sync` guidance without opening a dialog. Use **Sync now** to start a reviewed transfer, or `/sync status` to retry a check. Foreground `/sync` cancels and drains the background check before starting.

Checks run once per session start, including `/reload`, new, resumed, and forked sessions, in TUI and RPC only. Print/JSON skip startup checks. This one-shot policy has no polling or automatic retry loop; separately enabled Continuous sync owns recurring work. The overall deadline is 30 seconds, followed by underlying cleanup where needed; Git process termination and temporary-ref cleanup can take additional time. Git checks can still fetch objects and update the extension's private bare cache, but never push, apply managed files, update the sync baseline, or reload Pi.

**Compatibility change:** the existing `sync.automatic` boolean and Off default are unchanged, but On no longer performs startup push/pull. Startup is not guaranteed to use the latest remote content. Local transaction recovery remains an awaited safety barrier and can restore interrupted file changes before use; existing legacy settings-file initialization is also retained.

Shutdown behavior is unchanged: when **Automatic sync** is On and sessions are included, pi-sync can automatically push the selected content, not only session files. This also applies to headless modes; shutdown never opens a dialog, and `/reload` skips this push. Turning the setting Off disables its startup checks and shutdown pushes; separate Startup transfer and Agent mode preferences retain their own authorization.

### Experimental Agent mode

**Settings → Sync behavior → Agent mode (experimental)** controls per-setup `sync.agentMode`, default **Off**. Enabling requires a one-time review. It authorizes one merged sync next startup and autonomous **Sync now** / `/sync sync`, independently of Automatic sync and Startup transfer. Saving does not start a transfer from Settings. TUI/RPC only; Agent mode alone adds no polling, daemon, shutdown inference, or Pi core modification.

**Warning:** eligible conflict text is sent to the selected Pi model and can incur costs. Accepted results can replace/delete selected local and remote content without another transfer prompt. The resolver has no tools or parent conversation, and validates candidate ownership and current versions before using the existing publication/backup/journal flow. Validation is not a guarantee of semantic correctness or lossless editing against other local processes.

The first implementation resolves bounded overlapping `AGENTS.md` and prompt/skill Markdown/plain-text edits, and selects complete atomic global settings units. For `settings.json` packages, it keeps the higher explicit npm SemVer version from local and remote without a registry lookup; incompatible filters and non-comparable sources retain existing conflict handling. Verified ancestors are required. Code, session histories, deletion conflicts and path collisions are not model-resolved; unsupported/refused work pauses, unless existing partial-sync policy permits independent progress. No resources reload automatically. Disabling stops subsequent authorization, not completed writes or provider charges. Read [Agent mode settings, limits, privacy and recovery](./skills/configure-pi-sync/references/configuration.md#experimental-agent-mode) before enabling.

Ordinary **Sync now** reuses a cached refusal. Use **Retry refused model result…** in the manager to review and authorize one fresh request for the current refusal. This can incur another charge; it does not reset automatic request limits. Known unsupported conflicts stop before inference when partial sync is off. See [retry and cancellation boundaries](./docs/agent-continuous-hardening.md) and the [synthetic merge-quality corpus](./docs/agent-quality-verification.md).

### Experimental Continuous sync

**Settings → Sync behavior → Continuous sync (experimental)** controls separate per-setup `sync.continuous`, default **Off**. Agent mode must also be enabled. A separate review authorizes recurring network access, model costs and automatic transfers while Pi is open. Upgrade all Pi processes sharing the agent directory before enabling it. Monitoring starts after the `/sync` command or manager closes, and replaces the duplicate one-shot startup transfer.

Selected-file hints are coalesced after one quiet second. A 60–66 second remote/local check covers missed events. Temporary failures and proven pre-publication edit races use bounded backoff. Removing flagged secret content or repairing unsupported conflicts permits a fresh inspection; unchanged blocks do not repeatedly call the model. One local session owns monitoring for each shared agent directory; each computer remains a separate replica. Busy sessions and foreground commands release ownership after draining work. Nothing runs after Pi exits, and resources never reload automatically.

**Check remote status** shows rolling-window allowance, exhausted candidates, accounting capacity and safe recovery actions. These are read-only observations, not permission to dispatch. The observing session's model does not identify another scheduler owner's model. Retained private candidates and accounting are not automatically pruned.

**Warning:** local changes and retries can cause extra network requests between polls. Automatic model requests are limited to two per candidate and two per replica binding in a rolling 15-minute window, across restarts. These are request limits, not a currency cap. Safety blocks still require changed evidence or repair; uncertain provider/Git errors are not guessed to be retryable. See [Continuous sync consent, budgets and recovery](./skills/configure-pi-sync/references/configuration.md#experimental-continuous-sync).

### Opt-in automatic transfer

**Settings → Sync behavior → Startup transfer** controls the separate per-setup `sync.automaticTransfer` boolean, which defaults to `false`. It authorizes one conflict-free startup transfer at a validated idle boundary in TUI/RPC, including session replacement and `/reload`. Busy startup waits for `agent_settled`; foreground commands, a new agent run, replacement, and shutdown cancel and drain owned work. Changing the setting affects authorization immediately; enabling it schedules the next attempt on the next session start. There is no watcher or polling loop.

A baseline and matching authoritative content list are required. First-source choice, changed selection, missing established remote, secrets, and real conflicts remain review barriers. Automatic transfer requires conditional or lease-protected publication: Git, verified WebDAV, and R2/S3 with verified conditional writes are supported. The existing **Automatic sync** setting and shutdown policy are unchanged when this new opt-in is absent.

Unchanged automatic transfers use a read-only fast path after a fresh head read and verified baseline/cache checks, avoiding snapshot downloads and baseline rewrites. Recovery, partial-sync, legacy, and uncertain cases keep the full path. See [unchanged transfer conditions](./skills/configure-pi-sync/references/configuration.md#unchanged-transfer-fast-path).

Successful transfers show one summary. They do not reload resources, activate extension code, or rewrite model context. After local resources change, reload or restart when ready; newly pulled conversations still require explicit resume. Headless print/JSON skip this new startup feature. Reviewed directional settings/session-root transitions record both roots and verified settings evidence so interrupted apply can recover before or after settings installation. Older pending journals without transition evidence retain their original root-ownership checks and may require reviewed recovery; preserve their backups rather than downgrading. See [merge safety and recovery](./docs/merge-implementation-audit.md) for journal boundaries, external-writer limits, and downgrade guidance.

**Settings → Advanced → Merge settings fields** (experimental) controls per-setup `sync.mergeSettings`, default **Off**. It combines independent global `settings.json` fields, not arbitrary JSON or keybindings. Missing/corrupt ancestors, unsupported syntax, and incompatible fields retain whole-transfer review. Sensitive accepted content is cached privately under the denied state root; disabling does not delete evidence.

**Settings → Sync content → Machine-local fields** edits explicit `sync.localFields` root field names for global `settings.json` (default none). Excluded values and absence stay local; future portable snapshots omit them. Enabling rules opts into settings version 4 / snapshot version 2, which older clients must refuse. All receiving machines must configure compatible rules. Additions/removals require a separately confirmed force-direction migration, even with `--yes`; old remote history is **not erased**. See [settings merge and local fields](./skills/configure-pi-sync/references/configuration.md#settings-field-merge-and-machine-local-fields) for formats, compatibility and recovery.

**Settings → Advanced → Content merge / partial progress** (experimental) controls independent `sync.mergeContent` and `sync.partialSync` opt-ins, both default **Off**. Saving opts into settings version 5; partial publications use snapshot version 3, rejected by older readers. Supported Markdown/plain-text resources merge bounded independent line edits without Git or conflict markers. Diff grids and hunk comparisons share an eight-million-work-unit budget across the operation and its retries; exhausted paths remain conflicts for review. Same-session reconciliation only accepts validated complete byte-prefix extensions; divergent histories and the loaded session require review. A syntactically clean text merge is **not a semantic correctness guarantee**.

Partial sync keeps each side's unresolved versions, preserves their previous accepted hashes/ancestors, and advances only independent paths. Resource/collision dependency groups are withheld together, including local-only files, never represented as deletion. The conditional **Review unresolved conflicts** action, or `/sync conflicts`, opens exact private versions on request and resolves one freshly validated whole group. Automatic pushes, non-forced push/pull, and rollback refuse unresolved groups; use group review or an explicit manual push/pull force direction instead. Artifacts remain below the denied state root, with stable conflict identity and at most 32 proven-completed records retained; unresolved or unrecognized evidence is never automatically pruned. Failed attempts release only newly created artifacts whose inode/content ownership and lack of state/journal references are verified. See [content merge and partial recovery](./docs/content-merge-audit.md).

**Settings → Advanced → Show sync status** defaults to **On**. Turning it Off immediately clears and suppresses pi-sync status text for background checks, transfers, and review attention; widgets and notifications remain available.

**Settings → Advanced → Skip secret scan** defaults to **Off**; enable it only after reviewing the destination and selected content because it disables push scanning for every setup.
See [Secret scanning](./skills/configure-pi-sync/references/configuration.md#secret-scanning) for the setting and diagnostic behavior.

A minimal Git setup uses an existing private remote and keeps automatic sync off:

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "skipSecretScan": false,
  "showStatus": true,
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
Startup checks report included-content differences without changing anything. Transfers retain their existing included-content policy checks instead of silently expanding local scope.

Read the [settings reference](./skills/configure-pi-sync/references/configuration.md) for complete S3/R2, Git, and WebDAV examples, backend fields, included-content rules, legacy paths, and recovery steps.

## 🧠 Skills

Run `/skill:configure-pi-sync` before asking Pi about storage choices, included content, automatic controls, or settings recovery.
The [configuration skill](./skills/configure-pi-sync/SKILL.md) is manual-only and provides guidance only: it does not inspect private settings, collect credentials, edit files, execute diagnostics, or sync content.
Enter credentials in the existing masked TUI and perform settings changes and reviewed transfers through `/sync` yourself.
The skill's instructions are not a permission sandbox for the agent's other tools.
Read the [settings reference](./skills/configure-pi-sync/references/configuration.md) directly when no agent assistance is needed.

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
| `/sync conflicts` | Review private unresolved dependency groups and choose local or remote group versions after fresh validation. |
| `/sync doctor` | Check configuration, connectivity, and backend safety. |
| `/sync push` | Publish local content to remote storage. |
| `/sync pull` | Back up local content, then apply the remote snapshot. |
| `/sync sync` | Merge changes; enabled Agent mode resolves eligible conflicts autonomously, while initial-source/policy barriers retain review. |
| `/sync history` | Browse remote snapshots and review a rollback. |
| `/sync rollback <snapshot-id>` | Back up local content, apply a historical snapshot, and republish it remotely. |
| `/sync migrate-state` | Migrate the legacy local state directory. |
| `/sync unlock --stale` | Recover an abandoned local lock after guarded ownership checks. |

All routes support TUI and RPC; RPC settings and included-content screens are read-only.
Print and JSON modes reject `/sync`.
Unknown commands or flags, trailing values, and missing setup/snapshot values are rejected, including the former version 2 setup-addressing flag.

- `--setup <name>` targets a setup without switching it on `config`, `files`, `status`, `diff`, `conflicts`, `doctor`, `push`, `pull`, `sync`, `history`, and `rollback`.
- `--yes` (alias: `-y`) skips confirmation on `push`, `pull`, `sync`, `rollback`, and `migrate-state`; use only after reviewing the affected content.
- `--force` lets `push` or `pull` accept content conflicts without disabling backend concurrency protection. It is also accepted by `sync`, which still requires a direction choice for divergent content, and by `rollback` for compatibility. Explicit forced directions can also resolve an interrupted merge after a fresh review, archiving its old journal instead of restoring old bytes.
- `--stale` is accepted only by `unlock` and is required to remove a stale lock.

Push and rollback publish data externally; pull and rollback can replace or delete local managed files.
Review [Settings](#-settings) for included-content privacy and [Manager, conflicts, and recovery](#-manager-conflicts-and-recovery) before forcing a direction, skipping confirmation, or removing a lock.

## 🔄 Backend and recovery model

| Backend | Publication guarantee | Authentication | Remote path |
| --- | --- | --- | --- |
| Git | Exact expected-ref lease | Existing SSH/configured credential helper | `<branch>:<storage.path>` |
| WebDAV | Verified strong conditional requests | Private settings username/app password | `<url>/<storage.path>` |
| R2/S3 | Verified strong conditional requests | Private settings credentials | `<bucket>/<storage.path>` |

Git requires Git 2.30 or newer and a SHA-1-format remote repository.
HTTPS userinfo, URL passwords, local paths, `file`, `git`, `ext`, and remote-helper transports are rejected.
When editing a Git setup, changing its storage path also requires a new owned branch so the existing branch remains readable at its reviewed path.
The private bare cache under `<agent-dir>/pi-sync/git/` is rebuildable.

WebDAV requires HTTPS except loopback tests.
URL credentials, query strings, fragments, unsafe redirects, weak/missing ETags, and ignored conditional headers fail closed.
`/sync doctor` verifies collection and conditional-write behavior with an isolated probe, then repairs a missing active-snapshot history entry.

S3/R2 publishes `latest.json` and history using ETag `If-Match`, or `If-None-Match: *` for first creation, then verifies the active pointer. Before each publication, an isolated `.pi-sync-probes/<random-id>` object verifies that the server rejects stale ETags and create-only writes to existing objects and rotates strong ETags. Credentials must allow read, write, and delete under the selected storage path; the probe is deleted even after cancellation. Missing/weak ETags, ignored conditions, and probe or cleanup failures stop publication. A failed cleanup reports the probe key for manual removal; bucket versioning may retain probe versions. `/sync doctor` remains read-only for S3/R2 and does not verify write support.

Snapshot recovery is guarded: new journals record before/after images, older journals are retired only when their unchanged preimages are provable, and unrecognized bytes remain untouched for manual review. Current-session targets are never restored during startup. Preserve a blocked transaction and its backup, close Pi, and review the private evidence before restoring selected paths; malformed/unsupported journals are not disposable. Pi may have loaded resources before lifecycle recovery, so reload or restart explicitly after recovery if loaded resources need to match the restored files.

Before pull or rollback, pi-sync writes a backup under `<agent-dir>/pi-sync/backups/`.
Apply preflights paths and checksums, journals mutations, and restores prior state only when current bytes match verified preimages or planned postimages. Unknown intermediate directory states and newer edits require review rather than a blind rollback. An interruption after replacement is armed can require manual recovery even if installation never ran; a later deletion of installed content is not treated as an unfinished remove.
Merged transfers instead retain a private publication/apply/baseline journal and roll forward only when the active remote candidate and every changed local preimage/postimage can be verified. A crash or uncertain publication is reconciled through `/sync sync` without blind republishing. If newer local or remote changes prevent reconciliation, preserve the evidence, review `/sync diff`, and explicitly choose `push --force` or `pull --force`; the chosen direction archives the old journal. Disabling automatic transfer does not undo completed transfers. Do not downgrade while a merge or snapshot recovery journal is pending.

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
- Push scans managed local content for common secret patterns unless the user explicitly enables **Skip secret scan**; `/sync doctor` always retains the diagnostic scan.
- Remote snapshot references, checksums, paths, manifests, response sizes, and publication revisions are validated.
- Symlink parents, path escapes, duplicate paths, and unsafe file/directory replacement fail before local mutation.
- Live locks block mutation; stale recovery rechecks process and guard ownership.
- Cancellation aborts preparation and dialogs.
  Publication/apply commit boundaries finish with bounded signals and report ambiguous outcomes explicitly.
- Terminal-bound names, paths, metadata, and errors are control-character sanitized.

## ♿ Terminal accessibility

Pi exposes terminal components rather than a semantic or ARIA tree.
Release checks cover textual state, keyboard operation, Escape and Back behavior, control escaping, and narrow rendering.
Critical meaning appears in text such as `(current)`, `Review needed`, `No startup transfer`, `Warning`, `Invalid`, `Saved`, `Cancelled`, and `Applied`.
Color is supplementary, and the attention widget is informational rather than interactive.

## 🗂️ Package layout

```text
packages/pi-sync/
├── src/
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── sync-extension.ts              # Registration and session lifecycle ownership
│   ├── commands/                      # Parsing, execution, and attention dispatch
│   ├── settings/                      # Schema, validation, resolution, and persistence
│   ├── sync/                          # Queries, mutations, policy, and lazy loaders
│   ├── snapshot/                      # Collection, session paths, apply, and recovery
│   ├── backends/                      # Contract and Git, S3, and WebDAV transports
│   ├── state/                         # Sync-state persistence, locks, and migration
│   └── ui/                            # Manager, settings, reviews, and setup flows
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Operational audits and settings link compatibility
├── skills/configure-pi-sync/           # Manual-only guidance and authoritative settings reference
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.
Internal modules use direct imports from their owners; `src/sync.ts` and `src/types.ts` retain compatibility exports.
Backend transports do not depend on UI, and first-use operation and setup implementations remain lazy.

## 🔎 Keywords

Pi extension, Pi coding agent, settings sync, Git, WebDAV, Nextcloud, Cloudflare R2, S3-compatible storage, storage connections, sync setups, snapshot sync, dotfiles sync.

## 📄 License

[MIT](./LICENSE)
