# ☁️ pi-sync — Sync Pi Settings Across Machines

[![npm](https://img.shields.io/npm/v/@narumitw/pi-sync)](https://www.npmjs.com/package/@narumitw/pi-sync) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Sync synchronizes selected Pi settings and content across machines through Git, WebDAV, Cloudflare R2, or another S3-compatible store.
Reusable storage connections hold credentials, while named sync setups define exactly what to sync, where to store it, and whether to sync automatically. Pi owns the interface; the separate [@narumitw/pi-sync-daemon service](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-sync-daemon) owns execution.

> **Experimental daemon migration:** close or upgrade older Pi processes and review ownership before real-data use. See [migration and release restrictions](./docs/daemon-migration.md).

## ✨ Features

- Manages Git, WebDAV, Cloudflare R2, and general S3-compatible storage through `/sync`.
- Separates reusable storage connections from named setups with exact reviewed remote paths.
- Uses one ordered include list for Pi roots, safe agent-relative paths, and privacy-sensitive sessions, with optional path/glob exclusions.
- Protects changes with immutable snapshots, secret scanning, locks, conflict checks, pull backups, transactional apply, and recovery journals.
- Keeps snapshot selection portable and free of credentials.
- Offers opt-in file and directory size limits for new local applies and remote publications.
- Writes settings atomically, preserves unknown fields, rejects stale edits, and fails closed on unsafe configuration.
- Offers an opt-in, one-shot startup transfer when the setup has an accepted baseline and no conflicts.
- Shares one detached synchronization service across Pi clients, with a generated split UI client runtime.
- Bundles an on-demand skill for configuration questions and authorized local settings edits.

## 📦 Install

Use Node.js 22.19.0 or later for the daemon, the same minimum as the standalone package. The Pi Sync npm package includes the daemon code; no separate daemon installation is needed. The daemon still runs as a separate process.

```bash
pi install npm:@narumitw/pi-sync
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-sync
```

Build and try a local checkout from the repository root:

```bash
npm install
npm --workspace @narumitw/pi-tui-kit run build
npm --workspace @narumitw/pi-sync-daemon run build
npm --workspace @narumitw/pi-sync run build
pi -e ./packages/pi-sync
```

Pi loads `dist/index.ts` from the package directory, so build Kit and complete the local daemon build before building Pi Sync. The runtime-only daemon output from Git installation preparation is not enough for this build.

Extensions run with Pi's permissions, so install only packages from sources you trust.

Update Pi Sync to get a newer bundled daemon; updating the standalone package does not change this copy. Revoke retained unattended permission before updating, then start Pi or use `/reload`. An older daemon that supports guarded upgrades is replaced only when no sync work is active. If the update is deferred, wait for the work to finish and use `/reload` again. Older builds without this check require a one-time [manual restart](./docs/daemon-migration.md#ownership-and-upgrade). `/sync daemon status` compares the running and expected builds without starting or replacing a daemon.

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
New setups recommend **Selected paths**: choose the files and folders to sync. **Agent directory** can include eligible current and future files unless excluded. Sessions require a separate opt-in. Choose **Join an existing remote** to save with sessions and automatic sync off, then review its policy.
Before saving, review the exact destination, scope and rules, automatic-sync choice, and hidden-credential summary. R2/S3 always asks for an existing bucket; an example bucket name is not a default.

Invalid fields ask for a correction without restarting setup. A temporary local save failure keeps the review for another Save; changed settings require reopening and reviewing the current values. Saving writes local settings and may create a starter rule file. It does not start a transfer or grant permission for one. A connection saved through **Add a new storage connection…** remains saved if you later cancel the setup.

Buckets and remote repositories must already exist.
Git uses existing non-interactive SSH or credential-helper configuration and never stores Git credentials.
It owns the entire selected branch: use an empty repository or a new branch if `main` already contains unrelated content.
At `./`, Git stores `manifest.json` and `files/` at the repository root; it does not modify your local working tree.
WebDAV and R2/S3 store `latest.json`, `history.json`, and `snapshots/` directly under their selected root, not under a literal `./` prefix.

## 🧭 Manager, conflicts, and recovery

The `/sync` manager opens a searchable action palette in TUI mode, with up to five visible choices and help for only the selected action. The heading identifies the active setup without relying on the summary, which can be hidden in a short terminal. The summary uses local state without contacting remote storage and shows the configured storage path:

```text
Manage sync · home
Storage: Cloudflare R2 · r2 · personal-pi · pi-sync/home
Remote status: Not checked
Last applied: Never synced
```

Use **Sync…** (**Sync now** in RPC) to merge both ways. **Push to remote** uses this device's version for managed files; **Pull from remote** uses the remote version. After initial daemon handover, each choice can replace or remove managed files at the destination without a second transfer confirmation. Push preserves the previous remote version in **History**; Pull creates a local backup before applying changes. History rollback still follows the current sync rules; see [Recover excluded files from History](#recover-excluded-files-from-history) for files those rules no longer select. Use **View differences** first if you want a preview. Selecting a direction does not authorize background transfers or model use. If a file-queue release cannot be confirmed, Pi Sync attempts recovery within the same action. It does not repeat a known commit or guess when the write outcome is unknown. Use the same **Pull from remote** action to review and continue a pending ignore-rule Pull. It uses the recorded snapshot, not the latest remote snapshot. See [daemon recovery](./docs/daemon-migration.md#recover-from-uncertain-daemon-cleanup) if it cannot recover the owner.

Type to filter actions; navigation scrolls the list. **Settings** and **History** are directly available. Switching appears only when multiple valid setups exist; review and access-recovery actions appear when needed.

The summary distinguishes cached observations, recorded background state, and the last successful background transfer; none proves current remote equality. Missing or invalid background evidence is not shown as Waiting. Automatic-transfer permissions and possible AI costs remain visible when enabled; detailed preferences stay in Settings. Setup-specific actions stay bound to the displayed setup; if its configuration changes while the menu is open, review the refreshed setup before continuing. Choose **View differences** (`/sync diff`) for a manual read of current file differences, even with Debug mode off. It does not compare changes against the last sync. Last applied shows a compact snapshot ID and states when application time is unavailable; History retains full IDs.

After Pi Sync detects an included-content mismatch, the manager shows **Sync status: Review needed** and puts **Review synced content (recommended)** first.
**Sync now** remains unavailable until you review the mismatch.
Opening the manager does not make another remote request.
**Settings** opens **Pi Sync Settings** directly as one searchable list. It shows the content-policy controls for the current setup. Compare the remote path policy separately from file contents. **Storage location** edits only the current setup's bucket, branch, or path; it does not change the connection or included content. **Manage sync setups** and **Manage storage connections** open the existing catalogs. Connections hold reusable server addresses and sign-in details, and edits show every affected setup. Make another setup current before changing its preferences. Each description identifies the setup, device-wide, or shared-connection scope. Simple preferences report saving and durable save results; Back does not undo saved changes. Complex editors and risky changes retain their reviews. RPC reports the manual settings path and preserves catalog management without opening the TUI preference editor.

**History** shows snapshots for reviewed rollback and offers [WebDAV history repair](#-backend-and-recovery-model) when the active snapshot is missing from the list. Use **Review unresolved conflicts** for recorded unresolved groups.

On secondary menus, **Back** and Escape return to the previous screen. In setup inputs and save reviews, cancellation (including Ctrl+C) discards the current unsaved draft and returns to its owning menu. Session replacement or shutdown closes the owning flow.
Specialized operation and masked-credential prompts show the effective cancellation bindings and keep Ctrl+C as a hard-cancel input when Back is remapped.
Other destructive, credential-bearing, and externally visible actions show previews and confirmations where applicable. Automatic transfers require their own authorization.

### Review transfer changes

Unless another explicit transfer authorization applies, a merged **Sync now** transfer shows one confirmation with separate local and remote file changes, remote snapshot publication, session inclusion, and unresolved groups. **No, cancel** is initially selected in TUI mode. Up and Down select actions without scrolling the summary. If the summary does not fit, use Page Up and Page Down (or their configured selection-page bindings) to review it before confirming **Yes**. A terminal resize resets the review and selects **No**. Cancellation remains available throughout. This scrollable summary intentionally replaces Kit's clipped choice context, and the safe default differs from Pi's native Yes-first confirmation.

In TUI, select **Yes** from the first confirmation to proceed. **View details** is optional and shows the complete add/update/delete lists and unresolved paths. It cannot apply changes. Escape returns to confirmation with **No** selected; Ctrl+C cancels the whole TUI flow. RPC can show details in bounded pages and can require opening them first. RPC offers No first but the client controls visual selection, and protocol cancellation from details returns to confirmation. Session replacement or shutdown closes the flow; local files and remote state are rechecked before transfer.

Unresolved paths stay unchanged on each side. A backup and recovery journal protect the transfer; resources do not reload automatically. Remote snapshot publication is shown separately because it can occur without file-content changes. File lists on the main screen are shortened when needed; details retain every path. `--yes` does not bypass a required policy-transition review. Automatic transfers require their own authorization and a compatible policy. The direct `/sync push` and `/sync pull` routes retain their reviewed behavior and existing flags. Their TUI previews show directional add/update/remove counts and safety notes. Individual file paths are in **View details**, so a large file list does not delay confirmation. Loaded sessions are excluded from local change counts. Pull and rollback also list case-variant path cleanup; changed aliases invalidate approval. Push describes changes to the active immutable snapshot, not physical deletion of retained history. RPC and History rollback keep their existing confirmation protocols, with the complete directional summary. Local bytes, settings, baseline, and remote head are rechecked before applying a reviewed transfer.

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

**Sync now** merges independent file additions, edits, and deletions against an established baseline. Equal concurrent edits are accepted. With the settings field merge opt-in enabled, supported `settings.json` fields can also merge using a verified accepted ancestor; arrays, nested objects and coupled fields remain atomic. Other divergent file edits, delete/modify conflicts, protected-session changes, selection changes, and case/file-directory collisions still require review; one unresolved path stops the entire merged transfer unless partial sync is explicitly enabled. Explicit push and pull remain directional.

When **Sync now** requires a direction choice, the manager opens **Resolve sync conflict**.
The flow names the current setup and explains whether local content, remote content, or the included-content policy changed.

An explicit remote content-list mismatch opens **Synced content differs** in the same manager flow.
Nothing changes until you choose an action.
Choose **Review all paths (recommended)** first to compare exact remote-only paths, device-only paths, and both ordered lists.
If membership matches but order differs, the review says that only ordering differs.
Then choose one action:

- **Use remote content list** revalidates the remote snapshot and reviewed local setup before saving `sync.include` and the reviewed exclusion rules together.
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

Startup checks never open a dialog. While checking, TUI and RPC status show **sync ...**. With a sync baseline and no content-list mismatch, they use **sync ⇡** for local changes to push and **sync ⇣** for remote changes to pull. Review conditions use **sync ⇕**; in TUI, a compact widget shows **Sync · Needs review** and one line directing you to `/sync` for the named setup. The manager retains the reason: both sides changed, first sync with an existing remote snapshot, a differing content list (including order-only differences), or a missing remote snapshot despite an existing baseline. Both sides changing is a reason to review, not a confirmed file conflict.
No selected content and first sync with an empty remote stay quiet outside `/sync`, which provides setup or initialization guidance. Legacy remote metadata without an authoritative content list does not independently trigger a widget for observation-only checks. With **Startup transfer** enabled, an established legacy remote instead shows review attention and requires an explicit direction to adopt the content policy; no automatic transfer runs. An included-content mismatch puts **Review synced content (recommended)** in the manager, where a fresh review verifies the remote snapshot before offering changes.
Check results are advisory observations against the last sync baseline, not proof of a file conflict or current equality. Opening the manager uses local information and shows when the check completed; it does not contact remote storage. Transfer actions recheck current content.
In fullscreen TUI mode, click anywhere in **Sync** to collapse or expand the widget without moving keyboard focus. Attention updates keep the collapse state. Open and close `/sync` to restore the body with the keyboard; a new session resets the state.

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

Legacy directory scope selects all eligible files, applies `exclude`, then restores matches from `reinclude`. Pi login credentials, project trust, and Pi Sync's own state stay local regardless of those rules. Folder-wide sync may include private files that the secret scan cannot identify. Review the content before transferring to a trusted destination. Existing setups keep their selected paths and are not migrated automatically. See [Agent-directory scope](./skills/configure-pi-sync/references/configuration.md#agent-directory-scope) for formats, precedence, and recovery.

<a id="debug-startup-timings"></a>

### Debug mode

Turn on **/sync → Settings → Debug mode**, or set the top-level `"debug": true` in `pi-sync.json`. The default is **Off**. Use `/reload` or start a new Pi session for the client change. The daemon uses the agent directory's setting at its next owner or job boundary without a restart.

Both processes append startup timings and selected check and transfer outcomes to the private, local-only `<getAgentDir()>/pi-sync.log` (normally `~/.pi/agent/pi-sync.log`). It uses one JSON record per line; filter by `source` (`pi-sync` or `pi-sync-daemon`). Records omit raw errors, credentials, file contents, and model data. Turning Debug mode Off does not remove the file, and nothing rotates it automatically.

Timing reports still appear in the TUI transcript or as RPC notifications without entering model context. The Pi client does not write debug records in print or JSON mode. The daemon's separate operational `lifecycle.log` is unchanged. See the [Debug mode reference](./skills/configure-pi-sync/references/configuration.md#debug-mode) for safe cleanup, older snapshots, and timing details.

### Background startup checks

Startup loads command and transfer implementations only when needed. When no transaction directory is pending, a local directory check skips loading the file-recovery implementation. Pending transactions still complete recovery before Pi accepts user edits; this safety barrier is not deferred.

With **Automatic sync** enabled, session startup schedules a background check instead of waiting for a transfer. Pi remains usable while Git, WebDAV, R2, or S3 checks local hashes and remote metadata. Results follow the [status and review classifications](#resolve-conflicts-in-the-manager); check failures provide `/sync` guidance without opening a dialog. Use **Sync now** for a reviewed transfer, **View differences** for a manual read, or ask Pi to [recheck in Debug mode](#-tools). Foreground `/sync` cancels and drains the background check before starting.

Checks run once per session start, including `/reload`, new, resumed, and forked sessions, in TUI and RPC only. Print/JSON skip startup checks. This one-shot policy has no polling or automatic retry loop. The overall deadline is 30 seconds, followed by underlying cleanup where needed; Git process termination and temporary-ref cleanup can take additional time. Git checks can still fetch objects and update the extension's private bare cache, but never push, apply managed files, update the sync baseline, or reload Pi.

**Compatibility change:** the existing `sync.automatic` boolean and Off default are unchanged, but On no longer performs startup push/pull. Startup is not guaranteed to use the latest remote content. Local transaction recovery remains an awaited safety barrier and can restore interrupted file changes before use; existing legacy settings-file initialization is also retained.

Shutdown behavior is unchanged: when **Automatic sync** is On and sessions are included, pi-sync can automatically push the selected content, not only session files. This also applies to headless modes; shutdown never opens a dialog, and `/reload` skips this push. Turning the setting Off disables its startup checks and shutdown pushes; the separate Startup transfer preference retains its own authorization.

<a id="experimental-agent-mode"></a>

### Autonomous sync

**Retired:** Pi Sync no longer runs Autonomous sync or sends conflict content to a model. Existing `sync.agentMode` values are accepted but ignored, without rewriting settings. Review changes with **Sync now** or opt into one eligible [startup transfer](#opt-in-automatic-transfer). See the [upgrade and recovery guidance](./skills/configure-pi-sync/references/configuration.md#autonomous-sync) if an older daemon is still running.

<a id="experimental-continuous-sync"></a>

### Continuous sync

**Retired:** Pi Sync ignores existing `sync.continuous` values and no longer watches or polls for recurring transfers. It does not honor retained after-exit grants. Use the [daemon upgrade guide](./docs/daemon-migration.md#ownership-and-upgrade) to clear retained grants and replace older owners safely.

### Opt-in automatic transfer

**Settings → Startup transfer** controls the separate per-setup `sync.automaticTransfer` boolean, which defaults to `false`. It authorizes one conflict-free startup transfer at a validated idle boundary in TUI/RPC, including session replacement and `/reload`. Busy startup waits for `agent_settled`; foreground commands, a new agent run, replacement, and shutdown cancel and drain owned work. Changing the setting affects authorization immediately; enabling it schedules the next attempt on the next session start. There is no watcher or polling loop.

A baseline and matching authoritative content list are required. First-source choice, changed selection, missing established remote, secrets, and real conflicts remain review barriers. Automatic transfer requires conditional or lease-protected publication: Git, verified WebDAV, and R2/S3 with verified conditional writes are supported. The existing **Automatic sync** setting and shutdown policy are unchanged when this new opt-in is absent.

Unchanged automatic transfers use a read-only fast path after a fresh head read and verified baseline/cache checks, avoiding snapshot downloads and baseline rewrites. Recovery, partial-sync, legacy, and uncertain cases keep the full path. See [unchanged transfer conditions](./skills/configure-pi-sync/references/configuration.md#unchanged-transfer-fast-path).

Successful transfers show one summary. They do not reload resources, activate extension code, or rewrite model context. After local resources change, reload or restart when ready; newly pulled conversations still require explicit resume. Headless print/JSON skip this new startup feature. Reviewed directional settings/session-root transitions record both roots and verified settings evidence so interrupted apply can recover before or after settings installation. Older pending journals without transition evidence retain their original root-ownership checks and may require reviewed recovery; preserve their backups rather than downgrading. See [merge safety and recovery](./docs/merge-implementation-audit.md) for journal boundaries, external-writer limits, and downgrade guidance.

**Settings → Merge settings fields** controls the per-setup `sync.mergeSettings` opt-in, default **Off**. It combines independent global `settings.json` fields, not arbitrary JSON or keybindings. Missing/corrupt ancestors, unsupported syntax, and incompatible fields retain whole-transfer review. Sensitive accepted content is cached privately under the denied state root; disabling does not delete evidence.

**Settings → Machine-local fields** edits explicit `sync.localFields` root field names for global `settings.json` (default none). Excluded values and absence stay local; future portable snapshots omit them. An explicit array requires at least settings version 4 and snapshot version 2; agent-directory scope keeps settings version 7 or later and snapshot version 5. Nonempty rules require `settings.json` in `sync.include` only for selected-path setups. All receiving machines must configure compatible rules. Additions/removals require a separately confirmed force-direction migration, even with `--yes`; old remote history is **not erased**. See [settings merge and local fields](./skills/configure-pi-sync/references/configuration.md#settings-field-merge-and-machine-local-fields) for formats, compatibility and recovery.

**Settings → Content merge / partial progress** controls independent `sync.mergeContent` and `sync.partialSync` opt-ins, both default **Off**. Saving opts into at least settings version 5; partial publications use snapshot version 3 for selected paths, version 4 with selected-path exclusions, or version 5 for agent-directory scope. Older readers must refuse unsupported formats. Supported Markdown/plain-text resources merge bounded independent line edits without Git or conflict markers. Diff grids and hunk comparisons share an eight-million-work-unit budget across the operation and its retries; exhausted paths remain conflicts for review. Same-session reconciliation only accepts validated complete byte-prefix extensions; divergent histories and the loaded session require review. A syntactically clean text merge is **not a semantic correctness guarantee**.

Partial sync keeps each side's unresolved versions, preserves their previous accepted hashes/ancestors, and advances only independent paths. Resource/collision dependency groups are withheld together, including local-only files, never represented as deletion. The conditional **Review unresolved conflicts** action, or `/sync conflicts`, opens exact private versions on request and resolves one freshly validated whole group. Automatic pushes, non-forced push/pull, and rollback refuse unresolved groups; use group review or an explicit manual push/pull force direction instead. Artifacts remain below the denied state root, with stable conflict identity and at most 32 proven-completed records retained; unresolved or unrecognized evidence is never automatically pruned. Failed attempts release only newly created artifacts whose inode/content ownership and lack of state/journal references are verified. See [content merge and partial recovery](./docs/content-merge-audit.md).

**Settings → Show sync status** defaults to **On**. Turning it Off immediately clears and suppresses pi-sync status text for background checks, transfers, and review attention; widgets and notifications remain available.

With a footer that supports the [public semantic status protocol](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-statusline/docs/extension-status-protocol.md), normal standby—including another local monitoring owner—is hidden. Pi Statusline shows short static markers for checking, transfers, model resolution, and review, while retry/blocked states keep short reasons. Configured icons remain effective. Native Pi footers, RPC observers, and older or absent consumers retain the existing readable raw status; Sync needs no other extension to operate. See [Status display](./skills/configure-pi-sync/references/configuration.md#status-display) for reason labels and unchanged recovery behavior.

**Settings → Skip secret scan** defaults to **Off**; enable it only after reviewing the destination and selected content because it disables push scanning for every setup.
See [Secret scanning](./skills/configure-pi-sync/references/configuration.md#secret-scanning) for the setting and its risks.

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

The existing daemon settings writer uses a private same-directory temporary file and rename (`0600` on POSIX), preserves unknown fields, and coordinates cooperating Pi Sync processes. The lock does not cover external editors.
Do not save from a lock-unaware editor during a pi-sync settings operation.
Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched.
Version 1, version 2, and non-empty unversioned settings require manual recovery rather than automatic migration.

Adding `sessions` can upload prompts, tool output, paths, images, and secrets; interactive flows require a privacy acknowledgement.
Startup checks report included-content differences without changing anything. Transfers retain their existing included-content policy checks instead of silently expanding local scope.

### Retired ignore-file policy

**Breaking change:** Pi Sync no longer uses `.syncignore` or a custom rule file. It blocks retired settings, snapshots, and recovery records instead of guessing what to sync. Upgrading does not delete or convert existing settings, rule files, or remote history.

If only the remote snapshot or last accepted sync is blocked, keep your setup and [choose a new, empty storage location](./skills/configure-pi-sync/references/configuration.md#start-at-a-fresh-storage-location). For local settings or pending recovery errors, run `/skill:configure-pi-sync` or follow the [manual recovery guide](./skills/configure-pi-sync/references/configuration.md#retired-ignore-file-policy).

### Legacy path rules

For selected-path setups, **Settings → Excluded paths** edits `sync.exclude` rules that win over `include`; saving opts into at least settings version 6 and snapshot version 4. For directory scope, **Settings → Agent directory scope** also edits `reinclude` and session opt-in. Excluded local files remain untouched, including on rollback. New publications omit matching remote paths, but old history is **not erased**. Removing rules can expose or replace content. See [Excluded paths](./skills/configure-pi-sync/references/configuration.md#excluded-paths) for syntax, review, and recovery.

### Transfer size limits

In **/sync → Settings**, use **Max file size** and **Max directory size** for the current setup. Both default to **Off**. Enter `Off` or a positive whole number of MiB. The daemon checks the uncompressed bytes selected for each new local apply or remote publication. A directory limit counts all included files below that directory, not the entire sync root. A failure stops the transfer instead of skipping files, even for automatic transfers or with `--force` or `--yes`.

**Before enabling either limit, close or upgrade older Pi Sync clients and daemon processes that use this agent directory.** Enabling a limit upgrades an older local `pi-sync.json` to version 9. Older processes refuse the entire document, even for other setups. Turning both limits Off does not downgrade the file. Remote peers need no upgrade for this setting alone; it does not change snapshots.

A save applies to subsequent transfer attempts. It neither starts a transfer nor grants automatic permission. If blocked, inspect `/sync diff`, narrow the selection with [path exclusions](#legacy-path-rules), then review a Push or Pull from the side that has the version you want. See [Transfer size limits](./skills/configure-pi-sync/references/configuration.md#transfer-size-limits) for the manual settings fields, an example, and recovery guidance.

### Scan limits

If the agent-directory scan exceeds 64 MiB, open **Settings → Agent directory scope** to exclude large files or folders you do not need to sync. Reopen the transfer review. A remote read does not change the local scan limit.

Read the [settings reference](./skills/configure-pi-sync/references/configuration.md) for complete S3/R2, Git, and WebDAV examples, backend fields, content policy, legacy paths, and recovery steps.

## 🧠 Skills

Pi can automatically load the [configuration skill](./skills/configure-pi-sync/SKILL.md) when you ask about Pi Sync settings, path selection, or local errors. For example, ask “How do I keep my cache folder off other devices with Pi Sync?” Use `/skill:configure-pi-sync` to load the skill explicitly.

The skill applies authorized edits to `pi-sync.json` through the running local daemon for routine preferences. Loading the skill does not authorize edits.

Use `/sync` for initial setup, masked credential entry, and operations that require a separate review. The skill uses summarized local evidence for troubleshooting. It does not start transfers or run backend commands. See the [settings reference](./skills/configure-pi-sync/references/configuration.md) for manual configuration and troubleshooting.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/sync` | Set up storage, manage synced content, and review sync operations or recovery. |
| `/sync help` | Show command usage. |
| `/sync daemon [status\|handover\|allow-after-exit\|revoke-after-exit]` | Compare daemon builds, review ownership, or revoke a legacy grant. `allow-after-exit` reports that unattended sync was retired. No argument is the same as `status`. |
| `/sync daemon recover` | Diagnostic fallback: review and stop the current daemon in TUI or RPC without starting a replacement or retrying a transfer. |
| `/sync use <setup>` | Switch the active local sync setup, following its switch policy. |
| `/sync init` | Create a local configuration template. |
| `/sync files` | Open the current setup’s path selection or agent-directory rules in TUI. |
| `/sync diff` | Read current local and remote file differences without transferring files. |
| `/sync conflicts` | Review private unresolved dependency groups and choose local or remote group versions after fresh validation. |
| `/sync push` | Publish local content to remote storage. |
| `/sync pull` | Back up local content, then apply the remote snapshot. |
| `/sync sync` | Review and merge changes without model assistance; initial source and policy changes retain separate reviews. |
| `/sync history` | Browse remote snapshots, review a rollback in TUI, or confirm WebDAV history repair when offered. |
| `/sync rollback <snapshot-id>` | Back up local content, apply a historical snapshot, and republish it remotely. |
| `/sync migrate-state` | Migrate the legacy local state directory. |
| `/sync unlock --stale` | Recover an abandoned local lock after guarded ownership checks. |

Brief interruptions to file-write queue acknowledgements recover in the
background when possible, without replaying a transfer. Longer waits can
show `sync recovering`. If cleanup remains uncertain, review
[daemon recovery](./docs/daemon-migration.md#write-coordination-and-disconnection)
before retrying.

Use the [daemon CLI](./docs/daemon-migration.md#daemon-cli) for explicit `stop` or `restart`; these are not `/sync daemon` actions. For example, with only Pi Sync installed:

```bash
node "/path/to/installed/pi-sync/dist/daemon/dist/cli.js" status --root "/path/to/agent-directory"
```

If Pi Sync reports uncertain daemon cleanup, open `/sync` and choose **Stop daemon for recovery…**. After the confirmed stop, use `/reload` and follow the [cleanup recovery steps](./docs/daemon-migration.md#recover-from-uncertain-daemon-cleanup).

Use the directory containing the installed Pi Sync `package.json` and the agent directory of the owner you want to inspect. CLI `status` does not start a service. `stop` drains the service; reload Pi to reattach afterward. CLI `start` without clients follows the same 30-second grace policy. If ownership, consent, or cleanup is uncertain, follow the [recovery guide](./docs/daemon-migration.md#diagnostics-and-rollback) instead of forcing a restart. Print/JSON never launch a service.

All routes support TUI and RPC; RPC settings and included-content screens are read-only.
Print and JSON modes reject `/sync`.
Unknown commands or flags, trailing values, and missing setup/snapshot values are rejected, including the former version 2 setup-addressing flag.

- `--setup <name>` targets a setup without switching it on `config`, `files`, `diff`, `conflicts`, `push`, `pull`, `sync`, `history`, and `rollback`.
- `--yes` (alias: `-y`) skips confirmation on `push`, `pull`, `sync`, `rollback`, and `migrate-state`; use only after reviewing the affected content.
- `--force` lets `push` or `pull` accept content conflicts without disabling backend concurrency protection. It is also accepted by `sync`, which still requires a direction choice for divergent content, and by `rollback` for compatibility. For legacy path policies, explicit forced directions can also resolve an interrupted merge after a fresh review, archiving its old journal instead of restoring old bytes.
- `--stale` is accepted only by `unlock` and is required to remove a stale lock.

Push and rollback publish data externally; pull and rollback can replace or delete local managed files.
Review [Settings](#-settings) for included-content privacy and [Manager, conflicts, and recovery](#-manager-conflicts-and-recovery) before forcing a direction, skipping confirmation, or removing a lock.

### Migrating from the retired check commands

**Breaking change:** `/sync status`, `/sync doctor`, `/sync config`, and the **Check remote status** and **Diagnostics** menu actions are gone. Entering the old commands shows migration advice without contacting storage. Use **/sync → Settings** to review sync setups and storage connections, **View differences** or `/sync diff` to compare files, and the Debug tool below for baseline-relative checks. A read does not verify write access. For a missing WebDAV history entry, open **History** and review **Repair active snapshot history**. `/sync daemon status` still reports service status. Supported daemon peers retain their existing `status` and `doctor` operations; no settings conversion is required.

## 🛠️ Tools

Start Pi or use `/reload` with [Debug mode](#debug-mode) enabled in TUI or RPC to make `pi_sync_debug` available. Pi's tool allowlist still applies. The tool is not available in print or JSON. Ask Pi to explain the last sync check or request a new comparison:

- `latest` reads the most recent matching summary from the last 64 KiB of the private log. The result is historical; no record does not mean sync is clean. This action never starts or contacts the daemon.
- `recheck` asks for approval to read the configured remote and return a summary to the model. A legacy snapshot may need to be read to compare its content selection. Declining, cancelling, or having no confirmation UI makes no remote request.

The tool returns bounded summaries, not raw log lines, credentials, paths, storage addresses, file contents, or raw errors. It does not publish, apply, probe writes, or repair History. Enabling the tool starts no new background checks.

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
Pi Sync verifies conditional writes before publication. If a publication activates a snapshot but leaves its History entry missing, open **/sync → History** and choose **Repair active snapshot history** when offered. Confirm the exact setup and snapshot. The repair uses a temporary write/delete probe and adds the missing entry; it does not change the active snapshot or any local files. No repair runs automatically or through the Debug tool.

S3/R2 requests reject redirects, including same-origin redirects; configure the canonical endpoint before syncing. Credentials and snapshot bodies are never forwarded to a redirect destination.

S3/R2 publishes `latest.json` and history using ETag `If-Match`, or `If-None-Match: *` for first creation, then verifies the active pointer. Before each publication, an isolated `.pi-sync-probes/<random-id>` object verifies that the server rejects stale ETags and create-only writes to existing objects and rotates strong ETags. Credentials must allow read, write, and delete under the selected storage path; the probe is deleted even after cancellation. Missing/weak ETags, ignored conditions, and probe or cleanup failures stop publication. A failed cleanup reports the probe key for manual removal; bucket versioning may retain probe versions.

Snapshot recovery is guarded: new journals record before/after images, older journals are retired only when their unchanged preimages are provable, and unrecognized bytes remain untouched for manual review. Current-session targets are never restored during startup. Preserve a blocked transaction and its backup, close Pi, and review the private evidence before restoring selected paths; malformed/unsupported journals are not disposable. Pi may have loaded resources before lifecycle recovery, so reload or restart explicitly after recovery if loaded resources need to match the restored files.

Before pull or rollback, Pi Sync writes a backup under `<agent-dir>/pi-sync/backups/`. It leaves byte-identical regular files in place when their exact paths already match and no structural change is needed. It checks those files again before accepting the transfer. See [Restore a local backup](#restore-a-local-backup) for local edits that were never published.
Snapshot apply and recovery require canonical agent and session paths. Preflight refuses parent aliases it detects because Pi's file queue uses different keys for existing and missing aliases. Node's path-based writes and deletes cannot prevent another process from replacing a parent directory after a check. Use directories you control, and pause tools that move or replace their directories during sync. Preserve any pending recovery evidence; an unresolved startup recovery barrier still blocks transfers. Old journals recorded under an alias require manual review because their exact root and target paths remain pinned. Changing the agent path alone does not authorize recovery or rewriting those journals.
Apply preflights paths and checksums, journals mutations, and restores prior state only when current bytes match verified preimages or planned postimages. Unknown intermediate directory states and newer edits require review rather than a blind rollback. An interruption after replacement is armed can require manual recovery even if installation never ran; a later deletion of installed content is not treated as an unfinished remove.
The file queue coordinates one Pi runtime, not separate processes or lock-unaware editors. Hash-based journals cannot distinguish a later write of identical recorded bytes; they do not provide a cross-process compare-and-swap.
Merged transfers instead retain a private publication/apply/baseline journal and roll forward only when the active remote candidate and every changed local preimage/postimage can be verified. A crash or uncertain publication is reconciled through `/sync sync` without blind republishing. If newer local or remote changes prevent reconciliation, preserve the evidence and review `/sync diff`. An explicitly reviewed `push --force` or `pull --force` can archive the old journal. Disabling automatic transfer does not undo completed transfers. Do not downgrade while a merge or snapshot recovery journal is pending.

Removing a local setup or connection never deletes remote data.

### Recover excluded files from History

Use the snapshot reference reported by Push (use its snapshot ID if no separate reference is shown). History rollback follows the current sync rules and does not restore excluded files. To recover one excluded file without changing the sync rules or remote data, run this example with Node.js 22.19.0 or later from a directory where the installed `@narumitw/pi-sync-daemon` package resolves. Use the same sync setup and storage location as the original Push. The example writes only the selected file to a new private temporary directory; Git may also update its private local cache.

```sh
node --input-type=module - "$HOME/.pi/agent" 'home' 'snapshot-reference' 'sessions/example.jsonl' <<'JS'
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureEngineHost } from '@narumitw/pi-sync-daemon/engine/host';
import { loadSettingsConfig } from '@narumitw/pi-sync-daemon/engine/settings/config';
import { withStateDirectoryAccess } from '@narumitw/pi-sync-daemon/engine/state/state-directory';
import { createSyncBackend } from '@narumitw/pi-sync-daemon/engine/backends/backend-factory';

const [agentDir, setup, reference, relative] = process.argv.slice(2);
const root = await realpath(agentDir);
configureEngineHost({
  root: () => root,
  mutate: () => { throw new Error('This example only reads the remote snapshot.'); },
  review: async () => false,
});
const file = await withStateDirectoryAccess(async () => {
  const backend = await createSyncBackend(await loadSettingsConfig(setup));
  const signal = AbortSignal.timeout(60_000);
  const entry = (await backend.listHistory(signal)).find((item) => item.snapshotRef === reference);
  if (!entry) throw new Error('Snapshot reference not found in History.');
  const snapshot = await backend.readSnapshot(reference, signal);
  const files = snapshot.files.filter((item) => item.path === relative);
  if (snapshot.id !== entry.snapshotId || files.length !== 1) throw new Error('Snapshot or path did not match.');
  return files[0];
});
const bytes = Buffer.from(file.contentBase64, 'base64');
if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Snapshot checksum mismatch.');
const output = join(await mkdtemp(join(tmpdir(), 'pi-sync-history-')), 'restored');
await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
console.log(output);
JS
```

Compare the recovered file with any current copy. If you need to put it back, close Pi first and copy it to the intended local path. For a logical `sessions/` path, use the original session directory. Do not overwrite a symlink or publish the temporary file. Remove the temporary copy when finished.

### Restore a local backup

Use the exact backup path reported by Pull. Close all Pi processes using the affected agent directory. The backup is private and can contain unpushed settings and sessions. Extract the file you want to restore into a private temporary directory before replacing any local file. This example verifies the file's stored checksum and does not contact remote storage:

```sh
backup='/path/reported/by/pull.json.gz'
relative='settings.json'
scratch=$(mktemp -d)
node --input-type=commonjs - "$backup" "$relative" "$scratch/restored" <<'JS'
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const [archive, relative, output] = process.argv.slice(2);
const snapshot = JSON.parse(gunzipSync(readFileSync(archive), { maxOutputLength: 512 * 1024 * 1024 }));
const entries = snapshot.files.filter((file) => file.path === relative);
if (entries.length !== 1) throw new Error('Expected exactly one matching backup path.');
const bytes = Buffer.from(entries[0].contentBase64, 'base64');
if (createHash('sha256').update(bytes).digest('hex') !== entries[0].sha256) throw new Error('Backup checksum mismatch.');
writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
JS
printf '%s\n' "$scratch/restored"
```

Compare the extracted file with the current version. Keep any newer changes you need, then copy the verified file back to its original path. For a logical `sessions/` path, use the session directory from before Pull, not necessarily `<agent-dir>/sessions/`. Do not copy over a symlink, publish a local backup, or extract it wholesale over the agent directory. Remove the temporary copy after verifying your restored file.

The operational state root is `<agent-dir>/pi-sync/`.
An existing installation continues using `<agent-dir>/.pisync/` and shows migration guidance on startup; it is never moved merely because no sync is active.
Close every other Pi process, then run `/sync migrate-state` and confirm the review (or pass `--yes` for an already reviewed RPC workflow).
The command serializes against every upgraded state/cache user and atomically renames `.pisync/` only when no legacy sync lock or guard is active.
Close Pi instances running older pi-sync versions during the migration because they do not understand the migration guard.
If both roots exist, or either root is a symlink or non-directory, pi-sync refuses stateful work instead of merging, following, or deleting data.
Preserve both roots before manual recovery; with every Pi process closed and no destination conflict, rollback is an atomic rename from `pi-sync/` back to `.pisync/`.

## 🔒 Security and privacy

- Canonical, legacy, temporary, and recovery settings paths are denied from snapshots; both `pi-sync/` and `.pisync/` state roots are permanently denied.
- Push scans managed local content for common secret patterns unless the user explicitly enables **Skip secret scan**.
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
Color is supplementary. The attention widget's mouse control changes only its presentation; `/sync` provides keyboard access to review actions.

## 🗂️ Package layout

```text
packages/pi-sync/
├── src/
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── sync-extension.ts              # Registration and session lifecycle ownership
│   ├── daemon/                        # Public IPC adapter and live Pi queue integration
│   ├── commands/                      # Parsing, dispatch, and attention
│   ├── settings/                      # Settings proposals and public engine contracts
│   ├── sync/                          # Client lifecycle, dispatch, and public contracts
│   ├── snapshot/                      # Public snapshot/session contracts
│   ├── backends/                      # Public backend contract forwarders
│   ├── state/                         # Public state contract forwarders
│   └── ui/                            # Manager, settings, reviews, and setup flows
├── dist/                              # Published Jiti runtime and separate daemon files
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Operational audits and settings link compatibility
├── skills/configure-pi-sync/           # Local configuration edits and troubleshooting
└── test/                              # Behavior and lifecycle coverage
```

The [exclude policy safety audit](./docs/exclude-policy-audit.md) maps implementation boundaries to regression coverage.

The generated runtime is built from `src/index.ts` and does not import back into `src`.
Internal modules use direct imports from their owners; `src/sync.ts` and `src/types.ts` retain compatibility exports.
Repository and Git source installs use the daemon workspace's documented exports; the npm runtime maps the same exports to `dist/daemon/`. Transfers still run in the daemon, with no in-process fallback. First-use UI and setup implementations remain lazy.

## 🔎 Keywords

Pi extension, Pi coding agent, settings sync, Git, WebDAV, Nextcloud, Cloudflare R2, S3-compatible storage, storage connections, sync setups, snapshot sync, dotfiles sync.

## 📄 License

[MIT](./LICENSE)
