# Pi Sync settings reference

This is the authoritative public settings reference for Pi Sync.
The user performs settings changes and reviewed operations; the configuration skill can also make an explicitly requested edit to a known local rule file.

- [Complete version 3 example](#complete-version-3-example)
- [Required backend shapes](#required-backend-shapes)
- [Status display](#status-display)
- [Secret scanning](#secret-scanning)
- [Autonomous sync](#autonomous-sync)
- [Continuous sync](#continuous-sync)
- [Daemon lifetime and unattended permission](#daemon-lifetime-and-unattended-permission)
- [Ignore-file policy](#ignore-file-policy)
- [Included content](#included-content)
- [Excluded paths](#excluded-paths)
- [Unsupported old settings and recovery](#unsupported-old-settings-and-recovery)

## ⚙️ Settings

The canonical private user file is:

```text
~/.pi/agent/pi-sync.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
Missing settings load as unconfigured without creating an agent directory, file, temporary file, or lock.

An explicit setup creates the file atomically.
On POSIX, pi-sync creates and replaces it with mode `0600`.
Pi-sync processes coordinate settings access through `pi-sync.json.mutation-lock`; lock-unaware editors are outside that serialization boundary and should not save the file while a pi-sync settings operation is running.
Within one process, settings reads wait for earlier writes, including writes that have not acquired the lock yet.
Under that lock, a save validates the existing document before editing it. A malformed, invalid, or unsupported source cannot be replaced by relabeling it as a supported version. The writer validates the proposed document before flushing a private temporary file and renaming it over the canonical file; the active file is not moved away first.
Credentials stay in this canonical private file and are never shown in menus, reviews, status, notifications, errors, logs, or completion metadata.

A private `pi-sync.local.json` containing a valid supported document is copied byte-for-byte to `pi-sync.json`.
The old file remains as a recovery copy.
If both paths exist, `pi-sync.json` wins and the legacy file remains untouched.
If an older interrupted replacement left `pi-sync.json` missing and a hidden `.pi-sync.json.*.schema-migration-source` or `.pi-sync.json.*.migration-retired` file remains, settings access stops instead of loading the legacy copy.
Close every Pi process, preserve all recovery files, and review the retained settings before restoring the correct document to `pi-sync.json` with private permissions.
Do not delete recovery evidence or accept defaults to bypass this check.

### Settings ownership and required fields

Storage connections hold reusable server addresses and credentials.
Sync setups hold a connection reference, exact storage coordinates, included paths, and behavior for that setup.
Changing a shared connection affects every setup that references it.
Global settings apply to all setups on this device; they are not remote policy.

| Scope | Fields | Required values and defaults |
| --- | --- | --- |
| Document | `version`, `onSwitch`, `storageConnections`, `syncSetups` | All are required in a manually written document; versions 3 through 8 are supported. |
| Current setup | `activeSyncSetup` | Required when setups exist; absent when the setup catalog is empty. |
| Global preferences | `skipSecretScan`, `showStatus`, `debug` | Optional booleans; defaults are false, true, and false. |
| Setup selection | `sync.scope`, `sync.include`, `sync.automatic` | Legacy directory scope requires version 7 or later and omits `include`; selected-path setups require `include`. Both require explicit `automatic`. |
| Ignore-file selection | `sync.scope`, `sync.pathPolicy`, `sync.ignoreFile`, `sync.sessions` | Version 8, `scope: "agent-directory"`, `pathPolicy: "ignore-file"`. `ignoreFile` defaults to `.syncignore`; sessions require `true` and the rules must allow them. Use reviewed setup or migration, not manual JSON edits. |
| Setup behavior | `sync.automaticTransfer`, `sync.agentMode`, `sync.continuous`, `sync.mergeSettings`, `sync.mergeContent`, `sync.partialSync` | Optional booleans; all default to false. |
| Portable policy | `sync.localFields` | Optional array; any explicit array, including `[]`, requires version 4 or later. |
| Content/partial policy | `sync.mergeContent`, `sync.partialSync` | Enabling either requires version 5 or later. |
| Path exclusions | `sync.exclude` | Optional array; an explicit array, including `[]`, requires version 6 or later. |
| Directory exceptions | `sync.reinclude`, `sync.sessions` | Optional with directory scope. `reinclude` wins over `exclude`; sessions require `true`. |

Do not downgrade the settings version when an option is turned off.
The four automatic controls have separate effects:

- **Automatic sync** (`sync.automatic`) enables startup observation and selected-content shutdown pushes when sessions are included.
- **Startup transfer** (`sync.automaticTransfer`) enables one eligible startup transfer.
- **Autonomous sync** (`sync.agentMode`, unchanged) authorizes eligible startup and **Sync now** transfers without another transfer confirmation, plus model assistance and disclosure for supported conflicts.
- **Continuous sync** (`sync.continuous`) adds recurring work only with Autonomous sync enabled.

None of these controls is enabled by invoking the configuration skill.

### Editing in the manager

Open `/sync` → **Settings** to go directly to **Pi Sync Settings**.
The screen uses a searchable flat list without category navigation. Compare content rules separately from file contents. Legacy setups retain their path controls. Ignore-file setups show the local path for manual editing and offer a reviewed switch to another existing file.
**Storage location** edits the current setup's coordinates, while **Manage sync setups** and **Manage storage connections** retain the catalog and affected-setup reviews.
Returning from catalog management refreshes the rows; switching or removing the owning setup closes its old Settings screen.

Descriptions identify the owner: this setup, all setups on this device, or shared connections.
Simple choices report Saving and the durable Saved or failed/rejected result, preserve the selected row and search during refresh, and restore their previous value if saving fails.
Escape closes the screen without undoing successful saves.
Complex values retain their input/review flows.
This navigation change does not alter schema, defaults, automatic-sync behavior, or explicit opt-ins.

The manager separates current state from transfer, inspection, and management actions.
**Check remote status** and **View differences** invoke the existing read/check routes only when selected.
Last applied shows a compact snapshot ID with application time explicitly unavailable; full IDs remain in History.
It never uses snapshot creation time as application time.
See the [TUI behavior contract](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/tui-contract.md) for scopes and transfer branches.

RPC reports the manual settings path and offers the existing setup/connection catalog dialogs, not the TUI preference or masked-credential editors.
Print/JSON do not support `/sync`; use the private settings file directly.
Main-menu summaries remain cached observations; `/sync status`, `/sync diff`, and `/sync help` remain available through the visible command hints.

### Complete version 3 example

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "skipSecretScan": false,
  "showStatus": true,
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

Every backend accepts `.` or `./` for its root; both resolve to `./` and share the same local state and backend identity.
New setups default to `./`, independently of the setup name; Git also suggests branch `main`.
For WebDAV, root means directly under the configured collection URL, not the server root.
For R2/S3, it means the selected bucket root, with no literal `./` object-key prefix.
WebDAV and R2/S3 write `latest.json`, `history.json`, and `snapshots/` there; use separate relative folders or prefixes for independent setups sharing storage.
Existing settings, paths, and local state identities remain unchanged.
Editing a setup defaults to its current path.
Manually written documents still require an explicit non-empty `storage.path`; use `./` rather than an empty string for root.
Git branches are exclusively managed by pi-sync; an existing branch containing unrelated files is rejected rather than overwritten.
When adding a setup, locally configured destinations are checked before content selection and review, including equivalent connection aliases.
An occupied destination requires an explicit different path; Git requires a different branch because directories do not isolate publications on one branch.
This check does not contact the server or discover setups configured only on other machines.

Every setup requires explicit `sync.automatic`. Set `sync.scope` for directory scope, or set `sync.include` for selected paths.
Legacy setup offers automatic sync with Off first. New ignore-file setups save with automatic sync off; use Settings to review and enable automatic behavior separately. **Join an existing remote** instead saves with automatic sync and sessions off, then reviews the remote policy without transferring files. Existing values are not rewritten.
When enabled, the current setup receives one background startup check in TUI/RPC, including reload/new/resume/fork.
Automatic sync alone does not perform startup transfers or open dialogs; review changes through `/sync`.
Print/JSON skip startup checks.
Checks compare local hashes and remote metadata against the last sync baseline, so revision changes and missing baselines require review rather than proving a file conflict.

The setting still permits automatic shutdown pushes of selected content when `sessions` is included; this is not limited to uploading session files. Print/JSON require an already running, reviewed service and never launch one for shutdown.
Reload skips shutdown push.
Settings changes apply to subsequent operations; changing this setting does not schedule another startup check until the next session start.
Foreground `/sync` cancels a pending check before opening Settings.
The check deadline is 30 seconds plus bounded cleanup, with manual retry through `/sync status`; this one-shot policy has no polling.
Continuous sync is a separate opt-in.
See [Background startup checks](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/README.md#background-startup-checks) for recovery and Git cache exceptions.

New TUI setups use the [ignore-file policy](#ignore-file-policy) when the daemon supports it. The legacy wizard defaults to directory scope; its selected-path choices are Recommended (the nine non-session Pi roots listed below) and Minimal (`settings.json` and `AGENTS.md`).
The setup review shows the scope and exact backend destination.
R2/S3 requires an explicitly entered existing bucket and never creates one.
Saving setup or connection settings does not transfer files.

Invalid fields retry without discarding earlier answers.
Retryable local I/O failures retain the exact draft for another Save.
Stale reviews and invalid settings files require reopening or repairing current settings rather than overwriting them.
A separately saved connection remains if the surrounding Add setup flow is cancelled.

**Edit storage location…** changes only bucket, branch, or path.
Content and automatic sync belong to the current setup's **Settings** screen; editing another setup's coordinates does not make it current.
`activeSyncSetup` must reference an own-property setup when any setups exist and must be absent when the setup catalog is empty.
A referenced connection cannot be removed.
The current setup must be switched before removal when other setups exist.
Removing the last setup is allowed; local removal never deletes remote history.
Two setups cannot resolve to the same normalized backend location.

The global **On setup switch** setting persists as `onSwitch` and applies whenever any setup is made current.
It accepts:

- `ask-before-pull` — switch, then ask in TUI whether to start a reviewed pull;
- `pull-after-switch` — require observable UI and start the normal reviewed pull;
- `switch-only` — switch without reading or applying remote content.

### Status display

The global `showStatus` setting accepts a boolean and defaults to `true` when omitted from an existing version 3 document.
Set it through **/sync → Settings → Show sync status**; changes are saved and applied immediately for every setup.
When `false`, pi-sync clears and suppresses status text for background checks, manual and automatic transfers, and review attention.
TUI review widgets and TUI/RPC notifications remain available, and lifecycle cleanup still clears any stale status owned by pi-sync.

Pi Sync also publishes optional semantic metadata through the [extension-neutral status protocol](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-statusline/docs/extension-status-protocol.md).
Pi Statusline uses that metadata for quiet display: waiting for changes and another local monitoring owner are hidden, while active work uses short static markers.
The existing configured icon identifies Sync without an extra duplicate label.
Native Pi footers, RPC observers, and older or absent metadata consumers still receive the original readable status value.
This is not permission to sync, change retry policy, or erase recovery evidence.

Retry and blocked states keep a short reason: `temp` (temporary service/network failure), `busy` (lock contention), `stale` (changed evidence), `auth` (authentication), `storage` (local storage), `review` (safety barrier), `model` (resolver/model failure or exhausted candidate attempts), `limit` (request-window allowance), or `unknown` (unclassified failure).
Settings or private-state repair uses `repair`.
A request-window limit is not a currency budget; exhausted attempts for one candidate remain a model block, not a timer-based allowance reset.
Use the existing manager and **Check remote status** guidance to inspect recovery requirements rather than treating a short marker as a complete diagnosis.

### Debug startup timings

The top-level user setting `debug` accepts only `true` or `false` and defaults to `false`.
Edit `<getAgentDir()>/pi-sync.json` (normally `~/.pi/agent/pi-sync.json`) or use **/sync → Settings → Debug startup timings**.
UI changes save immediately through the existing ordered, atomic settings writer; both manual and UI changes take effect on the next session start, including `/reload`, new, resume, and fork.
There is no project or environment override.

With `debug: true`, reports show local initialization after recovery and settings resolution, then background work when it ends.
The report shows one line per stage, followed by a total.
TUI reports are stored as custom session entries, so they remain in the transcript after `/reload` and later notifications without entering model context.
RPC reports remain notifications.
When Continuous sync is enabled, the background report covers its first cycle rather than the separate one-shot startup check; later polls and same-session idle resumes do not publish more timing reports.
Stages include transaction recovery, settings reads, inspection import, backend initialization, local snapshot, sync state read, remote head, operations import, and automatic transfer when those stages run.
Automatic-transfer details separate authorization, journal recovery, state and local reads, remote-head reads, snapshot downloads, merge planning, backup, publication, local apply, baseline writes, and cleanup.
Repeated stages aggregate elapsed time and show a call count.
Stage output stays bounded during retries.
Inspection-and-guards, automatic transfer, journal recovery, and unchanged verification include their nested stages; durations overlap and must not be summed.
An eligible no-change transfer reports `transfer result: unchanged (fast path)`.
Totals use a monotonic clock and include waits within each flow, not Pi's complete startup, the initial extension import/factory, or time queued for idle startup transfer.
Recovery failures before valid settings can be read cannot enable a timing report.

Interrupted stages are marked `interrupted`; cancelled or failed background work is marked `stopped`.
Session replacement and shutdown suppress late reports from the old session.
Pausing Continuous sync cancels its active cycle and suppresses that cycle’s late report; it does not schedule another startup report on idle resume.
Labels and durations contain no credentials, paths, file contents, remote addresses, or error text.
No separate log file or model message is created; TUI reports remain in session history even after debugging is disabled.
Print/JSON produce no timing reports.
The setting does not enable automatic sync or transfer, change safety checks, or report manual/shutdown operations.
Set `debug` to `false` or remove it, then start a new session to disable reports.

### Secret scanning

The global `skipSecretScan` setting accepts a boolean and defaults to `false`, including when omitted from an existing version 3 document.
Set it through **/sync → Settings → Skip secret scan**; changes are saved immediately and apply to subsequent pushes for every sync setup, including automatic pushes.
When `true`, pushes skip the local secret scan; other safety checks and confirmations remain unchanged.
Enable it only after reviewing the destination and selected content because files containing secrets can be uploaded.
`/sync doctor` still scans and reports possible secrets regardless of this setting.

### Diagnostics

**/sync → Diagnostics** and `/sync doctor` use the same existing route.
S3/R2 reads the selected setup's latest pointer with a ten-second deadline and bounded error details; it never writes, deletes, lists buckets, or changes settings.
HTTP success does not validate snapshot contents or write access.
`NoSuchKey` indicates no snapshot at the path; `NoSuchBucket` indicates a missing bucket; other 404 responses cannot distinguish the two.
Authentication and transport failures give credentials/permissions or address/network guidance.
Git reads remote snapshots and checks its local cache; write access is not tested.
WebDAV retains its isolated conditional-write/cleanup probe and repair of a missing active-snapshot history entry.

### Ignore-file policy

New TUI setups use `.syncignore` when the daemon advertises support. Existing setups, including legacy directory setups, keep their current policy and can coexist with ignore-file setups in a version 8 document. To migrate a legacy setup, choose **Review migration now** when offered on first opening the TUI manager or **Settings → Migrate to ignore file…** later. **Not now** defers the offer for that setup on this device; closing the offer without a choice does not persist a deferral. Review added and removed local and remote paths, and consider files that could be added later. Legacy selected paths and `reinclude` rules do not always translate directly.

For reference, the `sync` object of a version 8 setup using the default rule file can look like this. This fragment is not a complete document or a substitute for review:

```json
{
  "scope": "agent-directory",
  "pathPolicy": "ignore-file",
  "sessions": false,
  "automatic": false
}
```

On confirmation the daemon can create a missing default file on Linux when safe directory-anchored creation is available. On macOS, Windows, or when that Linux path is unavailable, use the exact path and starter text shown by Pi Sync. Create a regular UTF-8 file there without overwriting an existing file, then reopen the setup or migration and confirm the review. The starter rules are:

```gitignore
/npm/
/sessions/
/auth.json
/truth.json
```

A leading `/` anchors a rule to the agent directory; a trailing `/` matches a directory. Rules are case-sensitive on every device. Blank lines, comments, wildcards, and ordered `!` exceptions follow Git ignore patterns for a single root file. An exception cannot restore a child under an excluded parent. Use `/` as the path separator; escaped `/` is not supported. There are no nested or project rules. A valid existing file, even an empty one, is reused as-is. Another rule file must already exist: choose a single safe filename directly in the agent directory, not a path, symlink, or linked alias. Missing or unsafe rules block transfers; an absent default can inform preview but cannot authorize transfer.

Use **Settings → Ignore file** to find the source or review a switch. Edit the existing file manually, with no sync or recovery running, and recheck `/sync files` before approving a transfer. All setups sharing the file see the edit. There is no in-app rule save. Sessions require separate opt-in and must be allowed by the rules: the starter `/sessions/` still excludes them. Match sessions by logical `sessions/` paths even when stored elsewhere. Pi credentials and trust (`auth.json` and `trust.json`), Pi Sync private settings and state, and `.syncignore` and configured alternatives stay local independently of the rules. `truth.json` is a starter exclusion, not Pi's trust file. Loaded sessions stay protected during apply. Ignored files are not replaced or removed by transfer. Retained snapshots and backups are not erased.

Setup, migration, switching the rule file, and editing rules do not start a transfer or grant permission for one. Upgrade all peers before publishing a version 6 snapshot. It carries a portable policy fingerprint, not the filename or rule text. Configure matching rules in the same order and matching session opt-in on peers; do not copy rules from the remote. A legacy or mismatched head requires separately reviewed directional policy publication, not `--yes` or automatic work. Use `/sync diff` to inspect the scope and `/sync` to review the direction. A pull cannot apply a foreign policy; rollback requires compatible history. If rules, setup, or head change during review, reopen the review rather than relying on stale approval.

For blocked or interrupted creation or transfer, stop new work and preserve the rule file, creation marker, journals, backups, and consent records. Use the compatible daemon to review recovery with the originating setup and exact source. If source or remote evidence differs, keep it rather than forcing replay or deleting a marker. Before settings commit the old policy remains authoritative; a verified starter or settings backup can remain after a failed save. After any v6 publication, downgrading the package alone is not rollback. Close incompatible clients, verify daemon exit, and review compatible local and remote restoration before resuming transfers; keep the retained history intact.

### Agent-directory scope

A legacy directory setup in a version 7 or later settings document can use:

```json
{
  "scope": "agent-directory",
  "exclude": ["sessions", "bin", "npm", "skills/private"],
  "reinclude": ["skills/private/shared.md"],
  "automatic": false
}
```

The agent directory is Pi's active agent root, normally `~/.pi/agent/`. Every eligible file is selected unless excluded. A re-inclusion restores an excluded path and only the descendants its rule matches. Literal directories match their subtrees. Rules are relative to the agent root; `sessions/` and `sessions` are equivalent in this scope. The `*`, `?`, and `**` syntax below applies to both lists. List order does not affect matching. If both lists are omitted, all eligible files are selected; the setup wizard saves its starter exclusions explicitly instead of adding them on every read.

Pi's `auth.json`, `trust.json`, their locks, and Pi Sync's settings and service state cannot be re-included. Pi's settings lock, dynamic model catalog cache and its lock, `crashes.json`, and `pi-debug.log` also stay local. Session paths remain local until explicitly enabled with `sync.sessions: true` (and not still excluded by a rule). The interactive flow requires a privacy acknowledgement. Symlinks are not followed. Agent-directory transfers do not move Pi's session storage root. Before moving a custom session store yourself, remove its old copy from the agent directory or exclude its old path explicitly. Pi Sync protects the current and default session locations, not unidentified old copies. Review what will transfer; the secret scan cannot identify every sensitive file.

The agent-directory scan and projected transfer result are limited to 64 MiB of file content, 16,384 files, and 65,536 visited entries. The projected result counts retained protected sessions and entries such as empty directories that are not stored in a snapshot. Directional apply and merged apply rescan before planned deletions and again before writes. The projection uses current sizes for retained files, but it does not lock out unrelated writers. `settings.json` has a separate 1 MiB limit for session routing. If local files change after review, reopen the transfer preview. A directory replacement is refused if it would remove an unreviewed or excluded descendant.

For new directory-scope transactions, the recovery journal records which image was being removed, which staging files it owns, and when the destination can remain empty. Recovery can resume if the remaining files match that evidence. If a staging attempt stops before ownership is saved, recovery can use a fresh staging path without adopting or deleting the unrecorded files. These files remain local and are excluded from sync. If Node cannot verify a stable filesystem creation time, an operation that needs a durable identity, such as resumed staging or removing a nonempty directory, stops and preserves the evidence. Recovery also stops for unrecognized data at a recorded path. Preserve the journal, backups, and remaining files for manual review. Older journals do not gain ownership evidence when you upgrade; do not downgrade with a pending journal.

Enabling sessions in the unedited recommended setup removes its starter `sessions` exclusion. If you choose to edit the starter rules or change session opt-in later in **Settings → Agent directory scope**, the toggle leaves both rule lists unchanged. For example, keep `exclude: ["sessions"]` and set `reinclude: ["sessions/work.jsonl"]` with `sessions: true` to select only that session.

**Compare sync policies** reviews the remote scope and rules without comparing file contents.

Settings version 7 and snapshot version 5 carry the new policy; older clients must refuse it. A local and remote scope mismatch stops transfer, even when forcing it. Use a matching setup or choose a new location. Adopting same-scope rules does not enable sessions on a device that has not opted in. Existing selected-path setups keep their behavior and stored settings. Changing rules does not transfer data, and excluding a path does not erase its old snapshots.

### Included content

Selected-path setups use ordered, duplicate-free `sync.include`.
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
**Settings → Compare included paths** opens the same review-first flow as a manager operation when local and remote lists differ.
Adoption revalidates the remote head, immutable snapshot, and complete reviewed setup configuration, including the shared connection and credentials, before one atomic settings update.
Cancelling the network check leaves the content list unchanged.
A settings save that has started its atomic replacement can still finish; later cancellation does not undo it.
The saved state changes `sync.include` and exclusion rules together, preserves unknown settings fields, and never pulls files or writes sync state.
Adopting an explicit remote exclude policy also reviews the version-6 upgrade; adopting a legacy no-exclude list clears existing rules to `[]` without downgrading.
Its explicit Continue action starts a fresh **Sync now** route, while **Done** leaves the reviewed settings change saved without implying a file operation.
Keeping this device's list opens the reviewed force-push path and explicitly replaces the remote policy while preserving eligible unmanaged remote files.

Startup checks report an explicit remote-policy difference without applying it.
Pull, including forced pull, pauses on that difference rather than silently expanding local scope.
Status reports matches and exact local-only/remote-only paths.
Old snapshots remain readable.
Because they have no authoritative selection, pi-sync offers only a clearly labeled read-only partial discovery from safe remote file roots; selected-but-missing and preserved-unmanaged intent cannot be reconstructed.
Use **Add custom path…** for any needed path.

Adding `sessions` requires a privacy acknowledgement in interactive flows.
Session JSONL can contain prompts, tool output, file paths, images, and secrets.
Pull protects the currently open session file; restart Pi or resume a pulled session to use newly synchronized conversations.

### Excluded paths

`sync.exclude` is an optional per-setup array of relative paths or basic glob patterns; absence means no rules.
For selected-path setups, an explicit array requires settings version 6 or later and publishes snapshot version 4 with selection policy version 2. Selected-path setups without an explicit array keep their existing snapshot format. Directory scope uses snapshot version 5.
New clients still read old settings and snapshots; older clients must refuse the opted-in formats.

For an existing setup in a version-6 document, the `sync` object can contain:

```json
{
  "include": ["settings.json", "skills", "extensions"],
  "exclude": ["skills/private", "extensions/**/*.test.ts"],
  "automatic": false
}
```

Rules win over `include` in selected-path setups and are anchored to the logical snapshot root, with `/` separators on every platform. In directory scope, a matching `reinclude` rule can restore an excluded path.
Literal paths match themselves and their descendants; `skills/private` does not match `skills/private-copy`.
`*` and `?` match within one segment; whole-segment `**` matches zero or more segments.
A matching directory excludes its whole subtree, including hidden files.
Matching is case-insensitive, includes dotfiles, and combines rules with OR, independent of rule order.
Use `**/*.log` for a filename pattern at any depth; `*.log` matches only at the root.
Sessions use virtual `sessions/...` paths even when stored in a custom physical directory.
A trailing `/**` also excludes its root; excluding `sessions` or `sessions/**` disables the legacy sessions-enabled shutdown push before state/backend work.

Inline `!` negation, comments, braces, character classes, extglobs, absolute/drive/UNC paths, traversal, backslashes, controls, empty rules, and case-equivalent duplicates are rejected.
The limits are 1,024 rules, 4,096 UTF-8 bytes per rule, and 256 KiB total.
Overlapping rules and rules for currently absent or unselected paths are allowed.
This syntax is not Git ignore compatibility and does not load an ignore file.

**Settings → Excluded paths** uses a JSON-array draft and an exact **Save changes**, **Discard changes**, or **Continue editing** review.
Empty input keeps the current draft; `[]` clears rules.
Only Save writes settings; it upgrades a selected-path setup's settings to at least version 6. Cancelling or a stale/failed save leaves the previous valid settings intact.
Changes apply to subsequent operations and do not start a transfer.
The canonical user file is the only scope; no project override or environment-variable mirror is added.
RPC remains read-only and shows the manual settings path.

Collection skips excluded content before reading its bytes and prunes excluded directories.
Pi's own session-directory configuration may still need to be read to resolve a session root; exclusions do not replace Pi configuration resolution.
Push, pull, merged/automatic sync, previews, rollback, accepted hashes, conflict/model evidence, and watcher hints honor the same rules.
Excluded local files are not overwritten or deleted; ancestor replacements that would remove excluded descendants are refused.
New publications omit matching remote files even if those files were previously preserved, while other unselected remote content retains its preservation behavior.
Old history and backups are **not erased**.

Comparison and adoption include both lists, even when no matching file exists.
Ordinary and automatic transfers, including forced pull, pause on a remote-policy difference.
Review the rules and use the existing confirmed force push to publish this device's authoritative policy.
Removing a rule can expose local content or permit remote replacement.
Clearing rules retains `[]` and the newer versions; never downgrade in place.
A pending transaction or merge journal under different rules remains available for reviewed recovery rather than replaying old writes.
To return to an older client, stop automatic work, resolve pending recovery with a compatible client, preserve backups, and create a separate reviewed legacy-compatible setup/location.

### Automatic startup transfer

`sync.automaticTransfer` is optional and accepts only a boolean; absent means `false`.
Set it through **/sync → Settings → Startup transfer**.
It is separate from `sync.automatic`: the legacy setting retains observation and selected-content shutdown behavior.

When explicitly enabled, one startup transfer waits for an idle boundary in TUI/RPC.
It requires an accepted baseline and a matching authoritative remote include list, retains all-or-nothing conflict review, checks secrets unless the global scan override is enabled, and never reloads resources.
Git, verified conditional WebDAV, and R2/S3 with verified conditional writes support this policy.
A saved On preference is not proof of eligibility: baseline, remote policy, idle ownership, conflicts, secrets, and publication capability are checked again at execution.
Print/JSON skip automatic startup transfer.
A settings save takes effect for subsequent authorization checks; enabling schedules the next session start, while foreground Settings cancels and drains any current work before saving.
There is no polling.

#### Unchanged transfer fast path

After pending merge journals are handled, automatic transfer reads a fresh remote head instead of trusting the earlier startup observation.
It can return without downloading the remote snapshot or writing a baseline only when the head ID/revision and ordered selection match a complete clean merged baseline, local portable hashes match that baseline, and the current ancestor cache is valid and complete for the enabled merge policy.
Local files, state, settings, idle authorization, and session ownership are rechecked after ancestor reads.
This path makes no managed-file, remote, baseline, or ancestor-cache changes; it does not re-download and verify an already accepted immutable snapshot or run normal no-transfer retention cleanup.

Manual sync retains the full path.
Directional/legacy baselines, missing revisions or selection metadata, unresolved groups, changed policy or content, and missing/invalid/incomplete ancestors also retain the full path.
Partial-sync setups keep the full path even with no unresolved groups, so snapshot-format upgrades and partial-state maintenance are not skipped.
A baseline established by a directional push/pull may therefore need one full automatic sync before later starts use the fast path.
Across startup inspection and transfer, an eligible unchanged setup makes two fresh head reads, with no snapshot download; a normal full no-transfer merge makes three head reads and one snapshot download in addition to inspection.

Turning **Startup transfer** off does not revert transfers or remove backups/journals.
For interrupted operations, follow [merge recovery](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/merge-implementation-audit.md).
Unknown fields remain preserved and malformed/invalid files block saves, just as for the existing policy.

<a id="experimental-agent-mode"></a>

### Autonomous sync

Autonomous sync uses the unchanged `sync.agentMode` key, an optional per-setup boolean, default `false`, in settings versions 3 through 8.
Open **Settings → Autonomous sync** and review the setup, destination, content policy, transfer authorization, model disclosure, costs, and autonomous writes before enabling. For directory scope, the review shows session opt-in separately from path rules.
RPC users can explicitly set the same field in the private settings file.
Setting it to `true` is authorization, not just a display preference.

Autonomous sync authorizes one eligible merged sync at the next session startup and the same flow from **Sync now** or `/sync sync`, without another transfer confirmation.
It can publish, replace, or delete selected local and remote content.
The selected Pi model resolves supported text and settings conflicts; eligible conflict content is sent to its provider and may incur costs.
It is independent of `sync.automatic` and `sync.automaticTransfer`; neither existing preference is changed.
Disabling Startup transfer alone does not disable Autonomous sync.
Saving never starts a transfer from Settings.
The atomic write cannot be cancelled after its final cancellation check.
A completed save remains in effect after cancellation or session replacement; reopen Settings to read the saved value.
TUI/RPC are supported; print/JSON and shutdown do not start a resolver.
Autonomous sync alone adds no polling or daemon.
Separately enabled Continuous sync provides recurring work while Pi remains open.

An accepted baseline, matching included-content/local-field policies, and conditional or lease-protected publication remain required.
First-source selection, policy migrations, explicit push/pull, and rollback keep their existing reviewed flows.
`--yes` does not enable Autonomous sync or authorize model disclosure.
Completed transfers never reload resources automatically.

The daemon uses the initiating session's selected model only if both agree on its full definition and authentication source.
If the daemon refuses the model, align the Pi host and the daemon's bundled Pi catalog or verify a model that matches on both sides. Selecting an older ID does not help if its definition still differs.
The daemon does not choose a fallback; ordinary sync without model resolution is unaffected.
The resolver has an independent in-memory SDK conversation, no tools, no parent conversation, and no discovered extensions, skills, project instructions, or MCP servers.
Only conflict units are disclosed.
Settings units contain only the conflicting root fields, with coupled fields kept together; the model selects a complete local or remote unit.
Other fields are assembled by deterministic code.
For text, the model can replace only overlapping edit hunks; code preserves the other bytes and independent edits.
Parent model prompts and tools are not changed.
This is configuration isolation, not an OS sandbox or proof of semantic correctness.

Eligible text is global `AGENTS.md` and `.md`/`.txt` files under `prompts/` or `skills/`.
Global `settings.json` uses the existing strict JSON, numeric, coupled-field, unknown-field, and machine-local-field policies. With Autonomous sync enabled, `packages` merges by source identity and selects the higher explicit SemVer version for each npm package present on both sides, even when one side has not changed from the verified ancestor. No registry lookup occurs. Equal SemVer precedence does not select a winner: one-sided source edits are preserved, and divergent edits require atomic selection. Package filters must match. An existing local or remote array keeps its JSON spelling when it matches the merged result. Accepted settings files keep their bytes unless a package override is required; that override changes only the `packages` value. The ordered npm identity list can change on one side, or identically on both sides; conflicting order or membership changes retain atomic selection. This preserves insertion positions and resource precedence. Non-npm entries must remain unchanged across all three versions for per-package merging. Changed Git refs and local path aliases retain atomic selection instead of being combined as separate sources. Delete/upgrade conflicts, duplicate identities, incompatible filters, version ranges and tags also retain the existing atomic selection rules when deterministic merging is not possible. Other arrays and nested objects remain atomic.
Code/scripts, keybindings, binaries, unknown formats, session histories, deletion/modification conflicts, path collisions, and session-root transitions are not model-resolved.
Existing deterministic merges still follow their own explicit settings.
Unsupported or refused groups remain unresolved; only an explicitly enabled `partialSync` policy permits progress around them.
Preserving versions does not mean a conflict is resolved.

A verified accepted ancestor is required.
Enabling Autonomous sync cannot recover historical ancestor bytes that were never retained.
If the original accepted bytes are still available on both sides, a conflict-free sync can seed the text ancestors for future runs; otherwise use the existing reviewed recovery flow rather than inventing a base from current edits.

Bounds are 8 KiB per input file, 16 conflict paths/units, 24 KiB of serialized model evidence, 16 KiB of candidate output, 8,192 maximum output tokens (or the selected model's smaller positive output limit), and one provider request per candidate attempt. A separately confirmed refusal retry can request the same candidate evidence again.
An unknown model limit of zero retains the resolver cap; invalid limits pause before disclosure.
Each resolver has a 20-second deadline that also cancels its validation and reservation prerequisites where cancellation is supported; the existing overall startup deadline is 30 seconds. Cleanup drains owned work and can take additional time. An atomic reservation or file replacement cannot be undone after publication.
At most two candidate requests are made during one triggered flow when remote commit competition changes the plan.
Provider retries are disabled.
Invalid output, detected stale evidence, missing model/auth, or recovery uncertainty pauses the flow rather than forcing acceptance.
These limits are not an exact currency spending cap; in-flight disclosure or charges cannot be undone by cancellation.

The existing possible-secret scanner always checks model evidence, even when `skipSecretScan` permits uploads without scanning.
It is a heuristic, not a guarantee that all secrets are detected.
Do not enable Autonomous sync for content you cannot disclose to the selected provider.
Provider errors and model reasoning are not copied into status or persistent records.

Pi sessions sharing one agent directory use one local resolver claim.
Other sessions can report deferred without another model request.
Inference does not hold the normal sync operation lock; commit rechecks settings, claim ownership, model identity, local bytes, baseline and remote revision.
Foreground work, replacement, reload and shutdown cancel/drain the owning task.
Another process rechecks authorization before requests and commit; disabling in that process cannot recall an already submitted request.
A dead owner's claim can be replaced on a later trigger; unreadable ownership is retained for review.
No live claim is removed just because it is old.
Claim creation and cleanup share a short-lived cross-process guard.
Cleanup does not need the normal operation lock, so another long-running transfer does not retain a completed resolver's claim.

Private claim and content-keyed candidate records reside under `<state-root>/agent-resolver/`, outside snapshots, with private permissions.
Candidates can be reused only for matching evidence, policies and model identity, and are validated again.
They can contain merged text; retain them as private data.
Different candidates are retained without automatic retention pruning.
Ordinary **Sync now** and `/sync sync` reuse a valid cached refusal without another provider request.
The manager's **Retry refused model result…** action separately reviews the setup, destination, conflict paths, selected model, disclosure and cost before one fresh request for that exact refusal.
It requires foreground TUI/RPC, Autonomous sync, an accepted baseline and no pending journal; use ordinary Sync now or reviewed recovery first when those prerequisites are absent.
Changed evidence, settings, model, session or cached bytes invalidate the review without disclosure.
A repeated refusal, invalid response or failed pre-publication replacement retains the original result.
A complete validated result replaces the active candidate only after the original refusal is archived privately in the same directory.
These archives use the existing candidate format and remain retained; no settings or accounting format migration is added.
Cancellation cannot undo an already committed replacement or provider request.
The action does not reset automatic accounting and never runs from background polling; no new textual command or flag is provided.
When partial sync is off, known unsupported groups stop before inference rather than paying for a result that cannot complete the transfer.
Duplicate provider billing remains possible at crash boundaries.
Corrupt or unsafe records block reuse rather than being overwritten blindly.

Pi-sync's cross-process operation lock excludes other pi-sync transfers, not arbitrary writers.
Pi file mutation queues coordinate participating writers only within one process.
Checks near rename reduce stale writes but do not provide an atomic compare-and-swap against another Pi process or editor.
Session JSONL is not rewritten by the model; other active session writers remain subject to the existing protection limitations.
Do not use Autonomous sync as a guarantee of lossless live editing.

Turn Autonomous sync Off to prevent subsequent requests and invalidate pending authorization.
Keep backups, snapshots, conflicts and pending journals; disabling does not undo completed work or erase history.
Unknown publication outcomes use the existing journal reconciliation and never authorize blind republishing.
Pending journals can be reconciled on a read/check/write/verify backend because recovery does not publish.
New autonomous transfers still require conditional or lease-protected publication; turn Autonomous sync Off before a reviewed manual transfer on a weaker backend.
If recovery is blocked, retain evidence and use the existing reviewed recovery routes.
Finish/reconcile pending merge journals before a downgrade.
No Pi core changes or other extension are required.

<a id="experimental-continuous-sync"></a>

### Daemon lifetime and unattended permission

For configured interactive work or an explicit setup or command, Pi starts the daemon bundled with the Pi Sync npm package or connects to an existing compatible owner. The daemon runs in a separate Node.js process, not as another Pi extension or an OS service. Unconfigured reads create no service or settings. The daemon owns the shared lifetime decision. For standalone and bundled CLI commands, see the [daemon CLI guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#daemon-cli).

When no registered live client PID remains for that canonical agent directory and no valid explicit after-exit grant covers the active setup, a fixed 30-second grace period starts. Explicit CLI start without clients follows the same rule. Live passive, disconnected, publishing, and orderly retired PIDs keep the service alive. Detach, heartbeat loss, and an empty active-participant list are not proof of exit. `/reload`, `/new`, fork, and resume preserve shared ownership while their Pi process remains alive. A client arriving before shutdown becomes final cancels automatic exit. There is no new setting, environment variable, or keep-alive flag.

After grace, the service stops new automatic work, cancels cancellable work, and drains committed writes, monitor work, queue-release acknowledgements, persistence, and owned callbacks before safe exit. Closing adds no final sync or model request and preserves journals, backups, request accounting, and existing transfer permissions. The next eligible interactive client or explicit command can restart through singleton startup only after the old owner's exit is proven. Print/JSON never launch a service; they can attach passively to an existing owner to protect their sessions and pause automatic work.

Before the first daemon-owned mutation, close or upgrade older Pi processes and review `/sync daemon handover`. An absent lock does not prove that an idle older process is absent. Settings and existing state/snapshot formats remain authoritative in the same locations; Pi proposes settings changes and the daemon serializes their publication.

Existing Automatic, Autonomous, and Continuous consent does not authorize zero-client work. `/sync daemon allow-after-exit` requires Autonomous and Continuous to be enabled, then separately reviews the setup, selected private content, recurring costs, and independently available provider/model. `/sync daemon revoke-after-exit` stops new unattended work. Setup changes invalidate the saved digest. Changing an interactive client’s model, working directory, or session-directory binding revokes older unattended grants; reverting that binding does not restore them. Reopen the review to grant permission again. A valid grant for the active setup keeps service lifetime under the existing fingerprint and binding rules without granting new work permissions. A grant for another setup, a revoked grant, or a stale fingerprint does not. Temporary provider or backend unavailability does not itself revoke a valid grant. Lifetime checks do not call a model, contact a provider or storage, or execute credential commands.

The standalone model host uses the agent-root `auth.json`/`models.json` through public Pi SDK APIs and the environment captured at service launch. Credential commands run non-interactively from the canonical agent root. Parent-only providers/accounts and runtime keys are not copied; unavailable capabilities retain conflicts rather than selecting a fallback. Restart after changing the service environment. Neither the parent conversation nor its tools are sent to the resolver.

A failed consent write blocks automatic work in that service instance. Uncertain consent publication, failed revocation, or cleanup failure keeps the owner paused with evidence retained. Automatic exit or implicit restart must not clear that barrier and restore an older persisted grant. Repair persistence and use the existing repair/revocation path before an explicit restart; do not assume a failed write changed the retained consent file. Cleanup failure is not successful exit. `stop` and `restart` drain compatible work and never replace an uncertain or incompatible live owner silently. See [migration, diagnostics, and rollback](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md).

### Continuous sync

`sync.continuous` is an optional per-setup boolean, default `false`, in settings versions 3 through 8.
Open **Settings → Continuous sync** after enabling Autonomous sync. For directory scope, the review shows session opt-in separately from path rules.
RPC users can set the field explicitly in the private settings file.
Existing Autonomous sync consent does not enable recurring requests.

The separate review names the setup, storage connection, destination, included paths, recurring costs and automatic writes.
The service uses the participating idle clients’ matching independently reproducible model binding; differing bindings pause automatic work.
The save uses the existing atomic settings writer.
Cancellation after the final publication check cannot undo a committed save.
Reopen Settings to read the saved value.

#### Activation and ownership

Monitoring starts at an eligible TUI/RPC session startup, after awaited local transaction recovery, or after a foreground `/sync` command or manager closes.
It replaces the duplicate one-shot startup transfer, not the legacy shutdown policy.
Turning Continuous sync off stops its work without disabling Autonomous sync.
Turning Autonomous sync off also stops monitoring; a saved Continuous sync On value remains ineffective until Autonomous sync is enabled again.

A control-file change during monitoring is detected by a watcher or the five-second local control check.
If monitoring is already off, external enablement requires the next session start or a foreground `/sync` command.
Print/JSON do not launch a service. If one already exists, they attach passive session facts and pause its automatic work until that client leaves.
Service lifetime follows the [30-second grace and active-setup after-exit exception](#daemon-lifetime-and-unattended-permission); zero-client work still needs that separate permission.

Upgrade all Pi processes sharing an agent directory before enabling Continuous sync.
Older releases do not implement its election or automatic accounting.
One detached service coordinates participating clients sharing the same canonical agent directory and reuses the engine’s scheduler lease, watchers, and request accounting.
Clients do not run a second transfer scheduler.
Each computer has a separate scheduler.
Remote conditional publication and revision checks remain authoritative across computers.
The lease does not exclude arbitrary editors or writers in other Pi processes.

Agent work, foreground commands, replacement, reload and shutdown cancel and drain owned work before handoff.
Idle work resumes through `agent_settled` or a later eligible check.
A busy session does not retain leadership indefinitely.
Completed atomic writes or remote commits remain committed even when cancellation occurs later.

#### Detection, retries and safety blocks

Local hints wait for one quiet second.
Remote and local snapshots are checked every 60–66 seconds.
Missing roots, atomic replacement, unsupported recursive watching and watcher errors retain periodic fallback.
Only selected content and control settings generate hints; private caches, backups and scheduler state are excluded.

Local changes and retries can cause extra remote requests between polls.
Cycles do not overlap.
Each cycle has a 30-second deadline plus underlying cleanup.
Changes during a cycle coalesce into one later fresh inspection rather than a queue of stale commands.

Known transient network/server errors, rate limits and proven pre-publication local/baseline/remote freshness races retry from five seconds with exponential backoff, bounded jitter and a five-minute cap.
Valid server Retry-After delays are capped at five minutes.
Backoff survives restart and is reset by successful work or relevant configuration changes, not every file event.

Authentication, permissions, disk errors, invalid settings, unsafe evidence and unknown errors stop automatic transfer.
Relevant repair, changed evidence or an explicit Sync now action can permit a fresh attempt.
Corrupt private records are retained, not replaced with defaults.
Local prerequisite checks can detect a repair without network/model work.

Blocked conflicts are inspected for changed evidence, but unchanged refusal/invalid output does not spend another model request.
Opaque Pi assistant errors and Git failures without structured transport evidence are not classified from text.
Select an available model, repair access, or use the existing review routes as needed.

Missing baselines, changed selection/local-field rules, unsupported conflicts and weak publication capability remain safety blocks.
Code, session histories, deletion conflicts and path collisions are not model-resolved.
Existing explicit partial-sync policy alone permits independent progress.
No background confirmation dialog or automatic resource reload is added.

#### Request limits and private records

The existing per-flow candidate limit, 20-second resolver deadline, input/output bounds, tool/resource isolation and mandatory disclosure scan still apply.
Cached candidates must pass current evidence checks before reuse.

Before each automatic provider dispatch, Pi Sync reserves a request in private durable state.
Timeouts, cancellation after reservation and uncertain dispatch outcomes consume that reservation.
Automatic requests are limited to:

- Two for the same candidate evidence/model contract, across process restart and ownership handoff.
- Two per replica binding in a rolling 15-minute window, including requests for different candidate keys.

A refusal or invalid output blocks unchanged evidence rather than requesting another completion each poll.
When the rolling window is full, Status shows the next eligible attempt.
Checks, conflict-free transfers and journal recovery can continue without another model request.
When the candidate's two automatic attempts are spent, waiting does not restore them.
The explicit **Sync now** / `/sync sync` path retains its existing per-flow limits; it does not erase automatic accounting and continues to reuse cached refusals.
Use changed evidence, the separately confirmed **Retry refused model result…** action for a current cached refusal, or an existing reviewed recovery route as appropriate.
Opening Status never reserves requests or clears limits.

These limits are not a currency spending cap or an exactly-once billing guarantee.
Candidate accounting has a 128 KiB storage bound.
A full record blocks work instead of pruning counts and silently granting more requests.

Private records under `<state-root>/continuous/` hold versioned owner/binding metadata, coalesced intent, hashes, safe error categories, timestamps and request counts.
They contain no raw credentials, provider errors, reasoning or duplicate conflict text.
The binding uses the canonical agent root and setup/destination identity; state-directory migration does not reset accounting.
POSIX records are private and use temporary-file-plus-rename publication.
Keep the directory as private evidence; do not delete it to repair a transfer.

#### Status, recovery and downgrade

The existing raw status key shows waiting, checking/syncing, scheduled retry, another local owner, or a stable blocked reason.
A compatible Statusline uses the [quiet presentation described above](#status-display); normal hidden standby does not mean monitoring or another owner's work has stopped.
**Check remote status** and the manager show advisory ownership, the last successful background check/transfer and safe next actions.
Status also shows normalized rolling-window usage, the next window allowance, exhausted-candidate counts, serialized accounting bytes/capacity and on-disk bytes.
Window allowance is not dispatch permission: candidate, capacity, ownership and safety checks still apply.
Status normalization affects only the detached read; it does not expire durable calls, reserve requests, create private directories or reset limits.
The scheduler owner's model is reported as unavailable rather than inferred from the observing session.
A full or unverifiable record is not unused allowance; retain it and use reviewed repair instead of deleting accounting.
Notifications are deduplicated by error/evidence/configuration.
Status may itself need network access for its existing remote check, but does not call the model.

Pending journals are reconciled before new work, including a newly uncertain publication.
Recovery never blindly republishes.
An unchanged recovery block is not repeatedly applied.
Preserve journals, backups and unresolved versions when proof is unavailable.

Turn Continuous sync off and drain its owner before downgrade.
Reconcile pending transfers with the current release.
Existing Autonomous sync and shutdown preferences remain separately effective.
Private scheduler records are separate from baseline/journal formats and remain retained; no automatic filesystem rollback or state migration is performed.

For implementation evidence and test scope, see [Continuous sync verification](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/continuous-sync-verification.md).

### Settings field merge and machine-local fields

`sync.mergeSettings` is an explicit opt-in, defaults to `false`, and is available through **Settings → Merge settings fields** for the current setup.
With a verified accepted ancestor, global `settings.json` root fields merge conservatively: absent differs from null, arrays/nested objects are atomic, and provider/model and other coupled fields form one unit.
Unknown fields are preserved.
Pi accepts plain UTF-8 JSON with an optional BOM, not JSONC; duplicate/prototype-sensitive keys, invalid encodings, migration-dependent syntax, and over-bound inputs require directional review.
Field merging and nonempty portable projections also refuse unsafe integers, nonfinite numbers, and numeric literals that change mathematical value when serialized through JavaScript; they never round those values into an accepted edit.
`keybindings.json` remains file-level because alias and matcher semantics need a separate strategy.

`sync.localFields` is an explicit sorted string array of whole global `settings.json` root field names, not a heuristic or project override.
Example: `"localFields": ["shellPath"]`.
Coupled fields must be excluded together.
Selected-path setups with nonempty rules must include `settings.json` in `sync.include`. Directory-scope setups must omit `sync.include` and can configure local fields without it. Path rules still govern whether `settings.json` syncs, and nonempty field rules require that exact file spelling if it is synced. Absent or explicitly empty rules remain valid for either scope.
Settings asks for confirmation before saving changes to these rules. An explicit array requires settings version 4 or later, and editing the rules does not downgrade an existing settings version.
Absent rules keep a setup nonportable, including unrelated setups in a version-4 document.
An explicit array opts that setup into at least snapshot version 2; exclusion-enabled selected-path setups retain version 4, legacy directory scope retains version 5, and ignore-file setups use version 6.
`[]` after rule removal retains this reviewed opt-in and differs from absence.
Older clients must refuse portable data rather than replace local-only values.

Portable projections normalize remote JSON deterministically while local overlay preserves unaffected local member/value bytes and excluded values or absence.
Accepted hashes and ancestors use that same projection; compatible noncanonical remote JSON does not create a false local change.
Recovery verifies both recorded projections in canonical form while retaining the original physical bytes and exact checksums.
Pull and rollback bind settings writes/deletions to the reviewed raw-file hash or absence under Pi's mutation queue, including transaction backup preparation; a newer excluded value causes refusal rather than overwrite.
A portable whole-file deletion is allowed when no excluded root field is present; a present excluded value (including null) or unsupported local document blocks deletion for review.
No override file is loaded and no resources are automatically activated.
Portable remote snapshots must actually omit every declared excluded root field; inconsistent or unsupported settings documents fail closed before acceptance, without displaying payload values.
Policy-only changes remain visible in status/startup inspection even when bytes are unchanged.
Excluded data can remain in old remote versions and local backups; removing a rule can make it publishable or replaceable again.

Changing rules blocks ordinary/background merge until a reviewed directional migration.
To change the authoritative remote rules, use `push --force` from the authoritative machine first.
`pull --force` may adopt a changed accepted policy only when the configured rules already match the remote; it never rewrites remote policy and refuses a mismatch before review or mutation.
Rollback requires its historical snapshot to use the configured rules; it refuses mismatched history instead of deleting newly portable local values.
Use authoritative `push --force` to migrate from current local bytes, then choose matching history.
A rollback that overwrites a different current-head policy requires the same additional observable TUI/RPC migration confirmation even with `--yes`.
Cancellation, changed bytes/settings/head, and invalid files prevent acceptance.
Inspect `/sync diff` first.
Configure the same portable rule set on every receiving machine; other local values may differ.
Rule names, not credential values, appear in review.

Accepted ancestors are private, hash/identity-bound, bounded records below the denied state directory.
Capture occurs after accepted directions or journaled merge; cache staging precedes state acceptance, and previous ancestors survive failures until completed journal retirement permits pruning.
Missing/corrupt cache never invents a baseline from current data or assumes remote retention.
Preserve unknown/corrupted or nonprivate records and pending journals for manual review; pruning applies the same storage/schema/byte validation as reading.
Journal identity distinguishes absent and explicit empty policies.
Integrity validation uses the journal's recorded rules, so intact old-policy journals remain readable after a settings change; ordinary replay still rejects mismatched current rules, while a reviewed force push or pull may archive a legacy path-policy journal.
Older absence-conflating journal identities fail closed and remain available for an explicitly reviewed force direction; do not downgrade portable setups.
To return to an older client, first use this version to review rule removal and publish a complete nonportable copy to a separate version-3 setup, with Pi closed during the change.
Never reinterpret portable snapshots with an old binary.

### Content merge and partial progress

`sync.mergeContent` and `sync.partialSync` are independent opt-in booleans, both default `false`.
The owning **Settings → Content merge / partial progress** setting offers Off, Merge only, Merge + partial, and Partial only and confirms an explicit upgrade to at least settings version 5.
Use a supported settings version of at least 5 (at least 7 for legacy directory scope and 8 for ignore-file policy).
Partial publications retain snapshot version 4 for exclusion-enabled selected paths, version 5 for legacy directory scope, and version 6 for ignore-file policy.
Settings version 5 retains the portable-policy behavior of version 4; moving from a legacy setup can require the existing separately confirmed directional policy migration.
Disabling options retains the schema and recovery evidence.

Content merge initially supports global `AGENTS.md` and `.md`/`.txt` prompt/skill resources.
Strict UTF-8, 1 MiB/file and a four-million-cell complexity bound apply.
BOM, CRLF/LF and final-newline bytes are not silently normalized; unsupported/binary/oversized input remains a file conflict.
Output never includes conflict markers.
JSON/keybindings/executable resources are not treated as generic text; settings has its separate strategy.
A clean line merge is not proof of semantic correctness.

Same-session content merge accepts only complete validated Pi v3 histories with exact immutable byte prefixes and comparable local/remote extensions.
It rejects malformed/partial records, migrations, identity/header changes, duplicate ids, broken parent references, compaction rewrites and divergent appends.
The current loaded session and its aliases remain protected; active sessions in other processes are not discoverable through this mechanism.
Nothing resumes a pulled conversation.

Partial progress stores per-path accepted hashes separately from the observed remote head.
Withheld local versions remain local; the complete published snapshot retains the observed remote versions, never omission/deletion.
Their previous verified ancestors survive staging and restart.
Resource and collision groups defer together when independence cannot be proved; partially conflicted JSON and sessions remain atomic.
Publication/apply/baseline is journaled, and a changed head replans only proven pre-commit attempts; unknown outcomes preserve evidence.
Older codecs refuse version-3 partial snapshots and older settings readers refuse version 5, so do not collapse state for downgrade.

`/sync conflicts` (also the conditional main **Review unresolved conflicts** action) shows private versions only when requested, in TUI or paginated RPC.
It rejects confirmation/force bypass flags, reviews an entire group, then separately asks for local or remote authority.
It revalidates the reviewed artifact fingerprint, group versions, baseline, configuration, ownership and current observed head before apply; stale/cancelled review performs no transfer.
The manager always reports unresolved groups and the observed head separately from Last applied.
Repeated unchanged conflicts retain one stable opaque identity rather than creating more evidence or modal reviews.

Artifacts are private immutable records below denied state storage with a 192 MiB/record cap; accepted ancestor records use the same bound, and actual content strategies have smaller limits.
Unresolved and unknown/corrupted evidence is never automatically removed.
Completed cleanup retains the newest 32 **proven-common, unreferenced** artifacts; pinned files remain even if other groups in the same record completed.
Total evidence can exceed those bounds across unresolved/unknown records: inspect it manually with Pi closed rather than deleting pending evidence.
This is not remote-history erasure.

Do not run older binaries against version-5 setups or pending journals.
To downgrade, drain work, resolve/review every withheld group with this version, retain evidence, and create a separately reviewed complete copy in a distinct version-3 setup.
Disabling partial sync with unresolved state blocks ordinary sync until it is re-enabled or an explicit force direction accepts a complete selected version.
No watcher/debounce/polling optimization is enabled: content revalidation is preferred over treating revision equality as authority.
See the [implementation and recovery audit](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/content-merge-audit.md).

### Unsupported old settings and recovery

Version 1, version 2, and non-empty unversioned documents are unsupported after the version 3 schema reset.
Pi Sync does **not** migrate, partially interpret, downgrade, or overwrite them.
Automatic sync pauses and reports an actionable version 3 error without displaying secrets.

Recovery:

1. retain the old file byte-for-byte;
2. move it aside manually;
3. create a new version 3 document or run the setup manager;
4. run `/sync doctor`, inspect the exact storage path, and review the first pull or push;
5. restore the retained file and a compatible older package only if rolling back.

Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched.
Failed UI saves keep the previous file and displayed/effective state.
