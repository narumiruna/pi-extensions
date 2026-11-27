# @narumitw/pi-sync

## 0.68.1

### Patch Changes

- 4148b42: Make Diagnostics and Check remote status easier to scan. Keep report line breaks in TUI and RPC, put comparison results and diagnostic warnings first, and group storage and content details separately.

## 0.68.0

### Minor Changes

- 6ca6931: Breaking: retire Autonomous sync, Continuous sync, model-assisted conflict resolution, and unattended sync. Existing `sync.agentMode` and `sync.continuous` settings remain readable but have no effect. Reviewed manual sync, Automatic sync, and Startup transfer retain their existing rules. Drain and replace older daemons safely; revoke retained after-exit grants if they block an upgrade.
- 6c092c4: Breaking: remove `.syncignore` and custom ignore-file policies. New setups recommend Selected paths; agent-directory scope with explicit exclusions remains available. Existing ignore-file settings, snapshot versions 6 and 7, and pending ignore-file recovery stop without converting or deleting data. Run `/skill:configure-pi-sync` for manual recovery guidance before resuming sync.

## 0.67.3

### Patch Changes

- ffe423e: Let Pi automatically select `configure-pi-sync` for configuration questions, ignore rules, and local troubleshooting. Keep `/skill:configure-pi-sync` available and leave edit and transfer approvals unchanged.
- 5025148: Defer daemon replacement while a sync review, transfer, or cleanup is active, and protect the open session file on the existing daemon. Start the new daemon's readiness deadline after it signals that it is booting. Use the intended daemon CLI to restart idle older owners that do not support the new guard. `/sync daemon status` now reports the running build and upgrade blockers without launching or replacing a daemon.
- 8e555ed: Open the missing automatic-transfer review directly from Pi Sync's refused-model retry. Keep approval of the enabled automatic modes separate from confirmation to send a fresh model request.
- fe4b0d1: Teach `configure-pi-sync` to check an existing local `pi-sync.log` for relevant diagnostics without exposing raw records, enabling logging, or starting a transfer.
- d10a00c: Report the verified Pi Sync daemon build after an update and compare the running and expected builds in daemon status. For a same-version local build, use the explicit daemon restart, which now shares the guarded upgrade path and refuses to downgrade a newer owner.

## 0.67.2

### Patch Changes

- 489bc7a: Record foreground Push and Pull attempts in the private debug log, including resumed ignore-rule Pulls. Match client and daemon records by operation ID without logging raw errors or transfer data.

## 0.67.1

### Patch Changes

- df24888: Resume an interrupted ignore-rule adoption from Pull when the original session can verify file-queue recovery. Use the recorded snapshot and ask before continuing.

## 0.67.0

### Minor Changes

- 93d6847: Add independent, default-off file and directory transfer size limits for each sync setup. The daemon checks the selected uncompressed content before a new transfer writes locally or publishes remotely, including automatic sync. Enabling either limit requires local settings version 9, which older processes refuse even after the limits are cleared. Remote snapshot formats are unchanged.

## 0.66.0

### Minor Changes

- 94d781f: Include the active ignore file in new snapshots unless it ignores itself. Require a reviewed overwrite for either direction of a policy conflict, and let Pull adopt verified remote rules without changing the remote. Upgrade all peers before publishing the new snapshot format and review automatic transfers again.

### Patch Changes

- 39e05a9: Find Settings by searching for storage connections in the sync menu. Show setting-specific save confirmations instead of generic transfer advice.

## 0.65.0

### Minor Changes

- c31f9c4: Make the `/sync` manager's Push and Pull actions apply the selected direction without another confirmation. Preserve a restore point before an overwrite, and recover eligible daemon file-queue failures within the same action without repeating a committed write. Direct slash commands retain their existing behavior.

### Patch Changes

- 25d766a: Show Yes in the first terminal transfer confirmation, even for large reviews. Open View details only when you want to see individual paths. The summary still defaults to No, and Pi Sync verifies the transfer before applying it.

## 0.64.0

### Minor Changes

- 316dde1: Rename **Debug startup timings** to **Debug mode** and keep the same default-off setting. Append safe startup, connection, and request diagnostics to the private, local-only `pi-sync.log` shared with the daemon. Client changes take effect at the next session start; existing TUI timing entries and RPC notifications stay unchanged.

### Patch Changes

- 6224417: Recover a blocked daemon from the Pi Sync menu or `/sync daemon recover`. Stop the reviewed owner without restarting it or replaying a transfer, and clean up the owned operation lock when a release failure blocks further writes.
- bbcc9e9: Reduce sync work without changing transfer approvals or recovery formats. Pull and rollback avoid reinstalling identical files, inspection avoids building unused payloads, and local requests wait for state changes instead of repeatedly polling jobs. Reduce repeated setup reads, review downloads, and backend work while preserving fresh checks and existing peer compatibility.

## 0.63.1

### Patch Changes

- fc5228d: Make the configuration skill verify the active ignore file with the existing local daemon before editing it. Stop on older daemon builds, and leave settings changes that require consent or policy review in `/sync`.
- 9d382d1: Show the active setup in the sync menu heading and include the configured path in R2/S3 and Git storage summaries.
- fc80c0c: Keep directional confirmation summaries short when a running older daemon still sends the full file list as the summary. Exact paths remain available in View details.
- f1dc5d2: Add guidelines and local verification workflows to `/skill:configure-pi-sync` for drafting, editing, and auditing `.syncignore` rules. Keep file creation, activation, and transfer approval in the user-reviewed Pi Sync flows.
- eb17fcc: Explain how to reduce sync scope when the agent-directory scan exceeds its limit. Replace outdated Check setup directions with current Diagnostics and storage settings paths.
- 26f8c59: Let `/skill:configure-pi-sync` apply requested local edits to `pi-sync.json` and the active ignore file, and investigate sync errors before suggesting changes. Keep transfers and other reviewed operations in `/sync`.
- aa99878: Let Up and Down select sync confirmation actions immediately. Show directional counts and safety notes in the summary, with exact file paths available in View details instead of requiring a scroll through the entire file list.
- 8e32b4b: Exclude top-level `git/` package checkouts in new `.syncignore` starter files and list the starter rules in alphabetical order. Preserve existing rule files and recover interrupted creation with its original rules.

## 0.63.0

### Minor Changes

- 5dfa289: Use local `.syncignore` rules for new TUI setups. Keep existing setup policies until the user reviews and confirms migration. Review the scope before transferring, upgrade peers before publishing version 6 snapshots, and edit existing rule files locally. Setup, migration, and rule-file switching do not start or authorize a transfer, and exclusions do not erase retained history. The bundled configuration skill can edit an explicitly identified local rule file on request; it no longer edits private JSON settings.

### Patch Changes

- 25777f7: Read Git history manifests in bounded batches to reduce subprocess launches. Keep the same history preview and validate all retained publications in the original order.
- e3f2537: Keep the `/sync help` route from loading the interactive ignore-file editor or a second Pi TUI runtime from the extension install.
- Updated dependencies [1cbb470]
  - @narumitw/pi-tui-kit@0.71.0

## 0.62.0

### Minor Changes

- d27317a: Prepare Pi Sync's local ignore-file policy, including recoverable default-file creation, settings review, and versioned snapshot compatibility checks. Existing setups are not migrated automatically. The new setup flow and first-open migration prompt remain disabled. Settings can show an existing rule file for manual editing; the daemon does not replace it. Settings shows the active settings path in RPC and explains which setup actions are unavailable while ignore-file transfers are disabled.
- 5b9146b: Let the `configure-pi-sync` skill apply and verify requested local settings edits, such as adding exclusions, through the running Pi Sync daemon without starting a transfer.

### Patch Changes

- 5262897: Ship the daemon with Pi Sync so npm installs no longer require the standalone daemon package. The daemon still runs in a separate Node.js process with the same ownership and upgrade rules. If you only install Pi Sync, run `node <pi-sync-package>/dist/daemon/dist/cli.js` to use the daemon CLI. Standalone daemon releases do not update the bundled copy; update Pi Sync to get a newer bundled build.
- 4073de5: Fix Windows recovery when NTFS changes a restored file's creation time during rename. Keep exact content, file ID, spelling, and pre-rename ownership checks, and preserve existing recovery journal formats. Make the daemon build use the Node compiler entrypoint instead of spawning a Windows command script.

## 0.61.0

### Minor Changes

- 4d02a81: Default new Pi Sync setups to the Pi agent directory, with editable exclusions for sessions, managed binaries, and npm installations. Directory scope can restore selected exceptions to exclusions, but Pi credentials and project trust stay local. Existing selected-path setups keep their rules.
  
  Recheck the directory scan limits before deletions and writes. If a recovery staging attempt stops before ownership is saved, retry in a fresh path and preserve the unverified files.

### Patch Changes

- Updated dependencies [4d02a81]
  - @narumitw/pi-sync-daemon@0.7.0

## 0.60.5

### Patch Changes

- d96f85d: Retry lost file-queue release acknowledgements on the same daemon without
  replaying transfers. Keep brief retries quiet and show a recovery status for
  longer waits. The daemon client exposes an optional queue-release delivery
  observer without changing the IPC protocol.
- Updated dependencies [d96f85d]
  - @narumitw/pi-sync-daemon@0.6.0

## 0.60.4

### Patch Changes

- 1f44df7: On the first active connection after an update, Pi Sync can replace an older daemon only if compatible, authenticated IPC works and no retained unattended grant blocks the upgrade. The replacement waits for the old daemon to release its identity and exit. If any check fails, follow the [manual recovery guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#ownership-and-upgrade). Passive and shutdown paths do not start a replacement. If an interactive session switch cannot upgrade the daemon, keep file protection when the old owner can still accept the session. Use `status` to find the pending or last recorded owner. When `repair-upgrade` successfully repairs a pending upgrade after verifying exit, it revokes all retained unattended grants and keeps the recovery records in one private archive across retries. It does not start a daemon.
- fdbd6d6: Restore one line per stage in daemon startup timing reports in the TUI and RPC notifications.
- Updated dependencies [1f44df7]
- Updated dependencies [df62c83]
  - @narumitw/pi-sync-daemon@0.5.0
  - @narumitw/pi-tui-kit@0.70.1

## 0.60.3

### Patch Changes

- b7d9e1c: Fix a hang after accepting a resource reload following a pull or rollback. Finish the sync operation and close its dialogs before reloading Pi.
- b4d548c: Treat an empty session path as absent instead of invalid, so `pi --no-session` runs stop reporting `Pi session paths must be absolute` on startup while still syncing nothing for that ephemeral session.
- 223b0ba: Restore a live Pi session after its heartbeat expires without reloading Pi. The
  daemon distinguishes heartbeat expiry from deliberate disconnection and keeps
  file-queue and session protection in place. Pi Sync reconnects to the same owner
  without resubmitting interrupted operations, and checks participation before
  reporting that it is connected.
- Updated dependencies [223b0ba]
  - @narumitw/pi-sync-daemon@0.4.0

## 0.60.2

### Patch Changes

- ea5b9f1: Exit the daemon after a 30-second grace period when no registered client PID remains and no valid active-setup after-exit grant applies. Keep live, passive, disconnected, and retired clients protected; preserve paused authorization barriers and drain committed work before releasing ownership. No new setting or final synchronization is added.
  
  Let Pi Sync retry an authenticated idle-closing owner after confirmed process exit, with bounded, cancellable startup and no replay of submitted operations. Add the lightweight `waitForDaemonExit()` client helper. Let a later Pi Sync command reconnect after a cancelled unpublished attach by draining the old connection and using a fresh client ID and generation; keep failed cleanup blocked and never replay the cancelled operation. Publish and verify the daemon dependency before releasing Pi Sync; publication and real-data cutover still require separate approval.
- 5e251a8: Rename the daemon package to `@narumitw/pi-sync-daemon` and its executable to `pi-sync-daemon`, and update Pi Sync to use the renamed dependency. The new package does not provide the old `sync-daemon` executable alias. Stop an existing daemon before replacing its package, then use the new executable after installation. Preserve IPC identity, settings, state, recovery evidence, and authorization digests. Publish and verify the renamed dependency before releasing Pi Sync; publication and real-data cutover still require separate approval.
- Updated dependencies [ea5b9f1]
- Updated dependencies [5e251a8]
  - @narumitw/pi-sync-daemon@0.3.0

## 0.60.1

### Patch Changes

- 8482c1f: Simplify the sync manager into a searchable action palette with five visible choices, selected-action help, a compact review widget, and on-demand continuous diagnostics. Keep transfer authorization, safety reviews, and existing command routes unchanged.

## 0.60.0

### Minor Changes

- 8bba72d: Extract the existing synchronization engine into the standalone TypeScript `@narumitw/sync-daemon` package and keep Pi Sync as its reviewed local API client. Share a detached root-bound owner across Pi sessions, retain existing formats and recovery safeguards, and separate service lifetime from unattended transfer and resolver permission.
  
  Preserve reviewed external-session destinations across all participating Pi queues and setup-scoped explicit Continuous retry without resetting request accounting.
  
  The daemon must be available before the dependent Pi client is released. Publication and real-data cutover require separate approval and the migration verification gates.

### Patch Changes

- Updated dependencies [8bba72d]
  - @narumitw/sync-daemon@0.2.0

## 0.59.0

### Minor Changes

- 58cb3c5: Add per-setup path and glob exclusions with reviewed settings, portable policy comparison, and local-file protection across sync and rollback. Exclusion-enabled setups opt into settings version 6 and snapshot version 4; existing setups keep their previous behavior. Excluded paths are omitted from new publications, not erased from retained history.

## 0.58.1

### Patch Changes

- cf7b63d: Put editor widget names and short current count/state summaries in their divider lines. Remove duplicate body titles while retaining safety text, detail rows, privacy modes, and standalone RPC/tool output. In fullscreen Pi, click anywhere in a widget to collapse it to one named line, then click that line to restore the latest content. Preserve independent, session-local disclosure through updates without taking editor focus, changing domain data, or stopping background work. Existing owner controls provide keyboard restoration; regular-mode mouse input remains terminal-owned.
  
  The Kit minor release supplies the named widget state and publisher disclosure APIs. Changesets raises all adopting consumers' Kit dependency floors in the same Version PR. Publish and verify the exact Kit artifact before its consumers.
- Updated dependencies [cf7b63d]
  - @narumitw/pi-tui-kit@0.70.0

## 0.58.0

### Minor Changes

- 379ebee: Add optional, extension-neutral status metadata v1 and a quiet footer presentation. Hide normal standby, shorten activity markers, and retain safe retry and blocked reasons while preserving configured icons and readable raw-status fallback. Keep sync authorization, scheduling, request limits, settings, notifications, and recovery behavior unchanged.

## 0.57.12

### Patch Changes

- 45401e4: Update runtime dependencies within supported peer dependency ranges.
- 6e7b0fb: Rename Agent mode to Autonomous sync and remove experimental labels from Settings and related guidance. Explain transfer authorization before model-based conflict resolution. Keep existing settings keys, saved consent, default-off opt-ins, safety checks, and runtime behavior unchanged.
- 33d4a5b: Open one searchable Pi Sync Settings list directly from the `/sync` manager's Settings action, without category navigation. Preserve all 16 rows, their order, reviews, and save behavior.

## 0.57.11

### Patch Changes

- 41c32db: Fix settings and transfer safety findings. Keep canonical settings available during replacement, order reads behind pending writes, and stop cancelled initialization. Bind manager actions and remote content-list adoption to the reviewed setup and connection, with cancellable network checks. Reject S3 redirects and correct SigV4 URI encoding. Preserve BOM-prefixed Pi settings and refuse unsafe aliased snapshot mutation paths while retaining recovery evidence.

## 0.57.10

### Patch Changes

- a6582dc: Reduce Pi startup loading by deferring command, transfer, and recovery implementations until needed. Preserve awaited recovery for pending file transactions and all existing sync settings.
- Updated dependencies [4f79c28]
  - @narumitw/pi-tui-kit@0.69.1

## 0.57.9

### Patch Changes

- 54f2700: Preserve fullscreen viewport capture through custom list wrappers so default and configured paging keys reach the focused list. Keep native transcript search, unrelated overlays, free-text modes, paste, and hard cancellation unchanged. Filter Kit key hints according to each screen's capture policy.
  
  Update Recall and File Context to the current Kit dependency range. The selected consumer releases require the fixed Kit patch through Changesets dependency-floor updates.
- e484010: Include the existing package-root CHANGELOG.md in extension tarballs so Pi can show native update notices. Keep Changesets version headings and Pi's first-observation and collapseChangelog behavior unchanged.
- Updated dependencies [54f2700]
- Updated dependencies [6c76ef1]
  - @narumitw/pi-tui-kit@0.69.0

## 0.57.8

### Patch Changes

- 9d3e0d7: Unreference passive refresh, debounce, expiry, and background startup timers so they do not keep the host process alive when other work has stopped. Keep normal cancellation and resource cleanup unchanged.
- Updated dependencies [9d3e0d7]
  - @narumitw/pi-tui-kit@0.68.1

## 0.57.7

### Patch Changes

- 3bf3525: Keep startup timing reports in the TUI transcript without adding model context, and report the initial Continuous sync cycle when debug is enabled. Preserve RPC notifications and suppress repeated or stale cycle reports.

## 0.57.6

### Patch Changes

- Updated dependencies [a21d39b]
- Updated dependencies [f68aa54]
- Updated dependencies [b062d21]
  - @narumitw/pi-tui-kit@0.68.0

## 0.57.5

### Patch Changes

- Updated dependencies [57eeae7]
  - @narumitw/pi-tui-kit@0.67.0

## 0.57.4

### Patch Changes

- 168248c: Reuse published TUI Kit frame metadata, masked input, configured-key syntax, and interaction ownership while retaining extension-owned settings and cancellation policy. Keep malformed Ticker key strings from suppressing valid reorder shortcuts, and drain Usage settings saves after cancellation.

## 0.57.3

### Patch Changes

- 11da747: Recover Continuous sync after proven pre-publication edit races and repaired content safety blocks. Avoid model requests when unsupported conflicts prevent an all-or-nothing transfer, and propagate resolver deadlines through validation and reservation work.
  
  Add a separately confirmed manager action to retry a current cached model refusal without resetting automatic accounting. Preserve ordinary Sync now cache behavior and retain the previous refusal privately. Show read-only request allowance, accounting capacity, and category-specific recovery guidance.

## 0.57.2

### Patch Changes

- 9f80b89: Use native fake-cursor markers for masked credential input and normalize unusable render widths without changing secret editing, validation, cancellation, or storage policy.
- Updated dependencies [077137a]
- Updated dependencies [9f80b89]
- Updated dependencies [efc474c]
  - @narumitw/pi-tui-kit@0.66.0

## 0.57.1

### Patch Changes

- a87a2ba: Keep the higher local or remote explicit npm package version when Agent mode merges settings, without a registry lookup. Preserve matching resource filters and one-sided package order or membership changes. Keep changed non-npm sources and conflicting package lists under atomic conflict handling. Preserve existing package-array bytes and use ancestor rules when SemVer precedence is equal. Keep accepted settings documents unchanged unless a package override is required.

## 0.57.0

### Minor Changes

- fa985f7: Add the manual-only `configure-pi-sync` skill for configuration questions and safe setup guidance without private settings reads, edits, or sync execution.
  Bundle the authoritative settings reference with the skill and preserve existing settings documentation anchors.

## 0.56.0

### Minor Changes

- 713eed4: Add default-off experimental Continuous sync with separate consent, local scheduler ownership, automatic detection and recovery, durable request limits, and safe blocked-state reporting. Bind each background cycle to its inspected settings and selected model before transfer, disclosure, publication, and local apply. Show the saved On or Off state in Continuous sync notifications.

## 0.55.0

### Minor Changes

- 1e86ba9: Add default-off experimental Agent mode for autonomous text and atomic settings conflict resolution through an isolated, tool-free Pi SDK session. Revalidate candidates before conditional publication, retain journal recovery, and coordinate local resolver ownership across Pi processes. Require a Pi runtime that supplies the tested public SDK boundary.

### Patch Changes

- e0028ea: Simplify internal settings saves, initial-sync routing, cancellation checkpoints, and object-store snapshot metadata without changing sync behavior.

## 0.54.3

### Patch Changes

- 2a9ad3a: Add opt-in startup timing notifications with the global `debug` boolean setting, including local initialization, background inspection, and automatic transfer stages.
- d02ca5f: Skip remote snapshot downloads and baseline rewrites for verified unchanged automatic transfers while retaining recovery and conservative fallbacks. Add aggregated transfer-stage durations and call counts to startup debug reports.
- 8ae9e62: Group Settings by task, retain cross-category search, and clarify setting scope, save results, and independent startup policies. Add manager status/difference actions and directional transfer counts with safe-default scrollable TUI Pull/Push reviews. Recheck reviewed local content and baselines, preserve protected sessions in preview counts, and clarify that remote removals do not erase retained history.

## 0.54.2

### Patch Changes

- 491fc28: Fix Windows EPERM errors when syncing snapshot backups and staged recovery files by opening regular files with write access for flushing.

## 0.54.1

### Patch Changes

- 2191720: Show clear local and remote change summaries with one explicit safe-default confirmation and optional read-only details. Keep remote snapshot publication separate from file changes and preserve cancellation and stale-state guards. On compact terminals, scroll the main summary before approval; resizing resets the review and the safe default.

## 0.54.0

### Minor Changes

- 80eef72: Flatten the sync manager: expose reviewed Pull, Push, History, and Diagnostics directly, move destination and catalog management into searchable Settings, and show conflict/access recovery only when applicable. Preserve existing commands, automation policies, and safety confirmations.
  
  Require the TUI Kit patch that preserves Settings search and cursor across refreshes, including queries that match printable keybindings.
  
  Preserve Settings search and cursor across successful refreshes in TUI Kit, and restore Settings and Choice queries as sanitized pasted content without dispatching printable keybindings.

### Patch Changes

- e32bf5b: Keep History rollback cancellation reachable after snapshot selection and confirmation restore the normal editor. Release the temporary terminal listener when the operation settles or its owner closes, and preserve the existing non-cancellable commit boundary. Ignore Kitty key-release events before matching cancellation so releasing a key does not abort History. Preserve focused dialogs' key priorities, and distinguish aborted or stale rollback confirmations from explicit rejection before notifying.
- Updated dependencies [6a2f900]
- Updated dependencies [80eef72]
  - @narumitw/pi-tui-kit@0.65.5

## 0.53.1

### Patch Changes

- fbb7757: Request identity representations for S3 reads so transfer compression does not weaken R2 JSON ETags and block safe conditional publication. Weak or missing ETags still fail closed. Reconcile inactive journals recorded with compression-weakened revisions only when the current strong ETag and exact pointer reproduce the recorded revision and local content and baseline are unchanged; this equivalence never authorizes publication or apply.
  
  Show bounded, terminal-safe, credential-redacted failure details for interrupted merged transfers while preserving journals, backups, and existing recovery behavior.

## 0.53.0

### Minor Changes

- d22b0b1: Support automatic transfer for R2/S3 using verified ETag conditional publication. Verify conditional-write behavior with an isolated temporary object before publication, protect active-pointer and history writes against concurrent writers, and preserve unknown-outcome recovery for transport failures. Credentials now require delete access for probe cleanup; unsupported conditional writes fail closed.

## 0.52.1

### Patch Changes

- 1e2df4b: Prevent reviewed case-only renames from deadlocking on case-insensitive filesystems while retaining file mutation queue protection for both spellings.

## 0.52.0

### Minor Changes

- 69fafc0: Add opt-in conservative settings field merging with verified private ancestors and explicit machine-local field projection. Portable policies use settings version 4 and snapshot version 2 so older clients refuse them; policy changes require directional migration confirmation and do not erase remote history. Support portable snapshots across S3, WebDAV and Git, retain version-4 setup management, capture initial accepted ancestors, prune completed cache history, and preview effective local images. Preserve per-setup policy absence, require explicit empty-policy migration, recheck force-push policies after remote refresh, clear cancelled migration status, and allow validated settings deletion when no excluded field is present. Bind recovery journals to policy presence, refuse pull policy rewrites until the authoritative remote matches, and preserve unsafe ancestor records during pruning. Surface policy-only changes in inspection, reject portable snapshots that retain excluded root fields, and guard empty first-sync acceptance. Finish rollback publication and prune accepted ancestors after post-commit cancellation while retaining session ownership checks. Require managed settings for nonempty exclusions, authorize rollback against current-head policy, refuse mismatched historical rules, and validate recovery images with their recorded policy so reviewed force recovery remains available. Normalize accepted portable projections without rejecting valid noncanonical journal JSON, refuse lossy numeric field merges and projections, and bind directional local-field writes to reviewed preimages through transaction backup preparation.
- a2b1e22: Add all-or-nothing, file-level three-way merging for **Sync now** with an established baseline. Independent changes merge automatically; initial-source choices, true conflicts, legacy selection policies, and session-root changes still require review. Explicit push/pull remain directional, and existing automatic defaults are unchanged.
  
  Add an opt-in automatic startup transfer at idle in TUI/RPC for conditional or lease-protected backends. Transfers protect the current session, revalidate local content and settings, and never reload resources automatically. Cancellation clears owned progress without publishing stale attention or affecting a replacement session.
  
  Harden interrupted-transfer recovery with durable private backups and journals, guarded file installation, case-only replacement handling, and verified settings/root-transition evidence, including settings deletion and canonical tilde expansion. Reject unsafe target aliases and newer or ambiguous filesystem states; preserve evidence for manual review rather than blindly restoring older content. Completed journals resume cleanup without rolling back accepted files. Do not downgrade while recovery evidence is pending.
  
  Preserve supported native POSIX filenames, escape path controls in review output, and index transaction planning and recovery checks to avoid repeated full scans.
- 07f98a4: Add opt-in bounded text merging, conservative validated same-session prefix reconciliation, and durable partial progress with private conflict artifacts and deferred whole-group review. Withheld local/remote versions and old accepted ancestors survive publication and restart; older readers refuse version-5 settings/version-3 partial snapshots. Preserve unmanaged collision barriers and loaded-session protection, stop automatic transfers at unresolved conflicts, defer conflict artifacts for transfer plans until after approved fresh review, and complete setup arguments for conflict review. Accept Pi's public session ID grammar, recover withheld equal deletions, index conflict grouping and bounded previews, and dispatch manager conflict-review decisions. Preserve main's portability and recovery safety contracts, authorize explicit manager roots, move large reviewed settings postimages into hash-pinned private sidecars, track crash-owned recovery staging, index whole-group resolution, and omit colliding paths from accepted ancestor caches. Finish reviewed multi-child/nested directory replacements in one pass with guarded retry, prevent automatic or unreviewed whole-direction acceptance from clearing unresolved conflicts, and index withheld snapshot assembly and carried ancestor membership. Bound cumulative text diff and hunk work across retries, revalidate no-transfer acceptance before evidence publication, and release only newly owned, unreferenced artifacts after failed attempts.

## 0.51.1

### Patch Changes

- 68c4b95: Update runtime dependencies and preserve Pi tool-context types through the LSP session lifecycle guard for compatibility with current Pi releases.

## 0.51.0

### Minor Changes

- bef29cf: Add a global Show status setting that can suppress pi-sync status text while preserving widgets and notifications.

### Patch Changes

- ae48402: Replace verbose status messages with compact `sync ...`, `sync ⇡`, `sync ⇣`, and `sync ⇕` indicators.

## 0.50.3

### Patch Changes

- 7ec32e4: Reuse published Kit interaction hints for secret input and cancellable operations. Deduplicate cancel aliases and omit the submit hint when no submit key is configured.
- Updated dependencies [317f7bd]
  - @narumitw/pi-tui-kit@0.61.0

## 0.50.2

### Patch Changes

- f6f26ff: Reserve persistent sync widgets and RPC warnings for review conditions. Show ordinary one-sided changes through status, keep setup and empty-remote initialization guidance in the manager, and preserve observations and transfer safety checks.

## 0.50.1

### Patch Changes

- 0f319d2: Add a themed horizontal separator above the sync attention widget to match other widgets above the editor.

## 0.50.0

### Minor Changes

- f566ede: Replace automatic startup transfers with a cancellable background check in TUI and RPC. Pi no longer waits for remote storage or opens startup conflict dialogs; review differences through `/sync` before transferring. The existing `sync.automatic` setting now checks only at startup, while its sessions-enabled automatic shutdown push remains unchanged. Print and JSON modes skip startup checks.
  
  Keep local recovery ahead of user operations, give foreground commands priority, and drain Git cache cleanup before releasing sync locks. Startup observations are advisory and revalidated before manual operations. Cancelled or pre-commit failed reviews retain valid hints; successful fresh reviews clear superseded content-list mismatch hints. Setup summaries disclose conditional shutdown pushes, and recovery help remains available when state roots need repair.

### Patch Changes

- 64b207b: Replace the initial setup purpose menu with direct name input, examples, and a brief explanation of suggested storage paths and separate sync choices. Blank names use `default`. Validate names and suggested backend locations before collecting connection details, and allow invalid names to be corrected immediately.
- 41eaa76: Simplify initial setup to one name across storage backends. Show input examples, explanations, and blank-to-accept defaults directly in Pi's dialogs without treating example endpoints or credentials as defaults. Default all new storage paths to the repository, WebDAV collection, or bucket root, without literal dot prefixes or changes to existing settings. New Git destinations use main, with existing branch safety checks preserved. Require a different path or Git branch before reviewing an additional setup when its chosen location is already configured. Preserve valid literal angle brackets in WebDAV input and edit defaults.
- 7af24f8: Keep initial R2/S3 storage paths identical in the setup review, saved settings, and resolved backend configuration. Setup names are independent of the default root path, including names with trailing slashes.
- f212568: Resolve the Git cache root to an absolute path so snapshot publication works when the cache path is relative and payload hashing changes the subprocess working directory.
- 12998a9: Simplify the setup-name prompt and distinguish its guidance with the theme's muted color.
- fdca695: Make setup choices explicit, retry invalid inputs, and show complete scrollable destination reviews. Clarify connection/setup menus and local save boundaries, retain drafts after recoverable save failures, and add actionable errors with bounded read-only S3 diagnostics.

## 0.49.15

### Patch Changes

- ec874c3: Add a global Settings option to skip push secret scanning while keeping the safe default and doctor diagnostics.

## 0.49.14

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.49.13

### Patch Changes

- dc9802e: Keep Ctrl+C available as a hard-cancel input when configurable cancellation bindings are remapped.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.49.12

### Patch Changes

- 806eada: Reduce extension startup time by letting generated TypeScript chunks reference their emitted `.ts` files directly.

## 0.49.11

### Patch Changes

- 9224800: Load the extension from a generated split TypeScript runtime to reduce Jiti startup work while preserving existing first-use boundaries.

## 0.49.10

### Patch Changes

- e3375f0: Avoid migration-lock contention during normal state access and safely share legacy migration protection across overlapping work in one Pi process.

## 0.49.9

### Patch Changes

- 38a36bb: Make interrupted-operation recovery immediately actionable in the sync manager, distinguish live and guarded operations from recoverable locks, confirm local-lock removal, and return directly to normal sync actions after recovery.

## 0.49.8

### Patch Changes

- f75f7e9: Open reviewed synced-content recovery when automatic or interactive TUI sync detects a content-list mismatch, preserve deferred attention in the manager and editor, and keep deterministic and non-TUI routes non-blocking.

## 0.49.7

### Patch Changes

- 549e626: Resolve differing local and remote synced-content lists inline with reviewed adoption, explicit continuation, and the existing safe force-push path.

## 0.49.6

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.49.5

### Patch Changes

- 8289ba9: Move operational state from `.pisync` to `pi-sync` with an explicit guarded migration and fail-closed path handling.
- Updated dependencies [736ca9e]
  - @narumitw/pi-tui-kit@0.52.0

## 0.49.4

### Patch Changes

- 6432b4d: Make included-content intent portable across snapshots, add reviewed remote-policy adoption, pause sync on explicit policy divergence, and allow safe custom paths that exist only remotely.
