# @narumitw/pi-sync

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
