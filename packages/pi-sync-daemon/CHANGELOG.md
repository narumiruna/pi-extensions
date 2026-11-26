# @narumitw/pi-sync-daemon

## 0.13.3

### Patch Changes

- 5025148: Defer daemon replacement while a sync review, transfer, or cleanup is active, and protect the open session file on the existing daemon. Start the new daemon's readiness deadline after it signals that it is booting. Use the intended daemon CLI to restart idle older owners that do not support the new guard. `/sync daemon status` now reports the running build and upgrade blockers without launching or replacing a daemon.
- 8e555ed: Open the missing automatic-transfer review directly from Pi Sync's refused-model retry. Keep approval of the enabled automatic modes separate from confirmation to send a fresh model request.
- d10a00c: Report the verified Pi Sync daemon build after an update and compare the running and expected builds in daemon status. For a same-version local build, use the explicit daemon restart, which now shares the guarded upgrade path and refuses to downgrade a newer owner.

## 0.13.2

### Patch Changes

- 489bc7a: Record foreground Push and Pull attempts in the private debug log, including resumed ignore-rule Pulls. Match client and daemon records by operation ID without logging raw errors or transfer data.

## 0.13.1

### Patch Changes

- df24888: Resume an interrupted ignore-rule adoption from Pull when the original session can verify file-queue recovery. Use the recorded snapshot and ask before continuing.

## 0.13.0

### Minor Changes

- 93d6847: Add independent, default-off file and directory transfer size limits for each sync setup. The daemon checks the selected uncompressed content before a new transfer writes locally or publishes remotely, including automatic sync. Enabling either limit requires local settings version 9, which older processes refuse even after the limits are cleared. Remote snapshot formats are unchanged.

## 0.12.0

### Minor Changes

- 94d781f: Include the active ignore file in new snapshots unless it ignores itself. Require a reviewed overwrite for either direction of a policy conflict, and let Pull adopt verified remote rules without changing the remote. Upgrade all peers before publishing the new snapshot format and review automatic transfers again.

## 0.11.0

### Minor Changes

- c31f9c4: Make the `/sync` manager's Push and Pull actions apply the selected direction without another confirmation. Preserve a restore point before an overwrite, and recover eligible daemon file-queue failures within the same action without repeating a committed write. Direct slash commands retain their existing behavior.

## 0.10.0

### Minor Changes

- 316dde1: Append safe owner, timing, job, and Continuous sync diagnostics to the shared, local-only `pi-sync.log`. Use the agent directory's Debug mode setting at the next owner, job, or cycle boundary, including for already-authorized unattended work. Keep repeated unchanged polls quiet and leave the operational `lifecycle.log` unchanged.

### Patch Changes

- 6224417: Recover a blocked daemon from the Pi Sync menu or `/sync daemon recover`. Stop the reviewed owner without restarting it or replaying a transfer, and clean up the owned operation lock when a release failure blocks further writes.
- bbcc9e9: Reduce sync work without changing transfer approvals or recovery formats. Pull and rollback avoid reinstalling identical files, inspection avoids building unused payloads, and local requests wait for state changes instead of repeatedly polling jobs. Reduce repeated setup reads, review downloads, and backend work while preserving fresh checks and existing peer compatibility.

## 0.9.1

### Patch Changes

- eb17fcc: Explain how to reduce sync scope when the agent-directory scan exceeds its limit. Replace outdated Check setup directions with current Diagnostics and storage settings paths.
- aa99878: Let Up and Down select sync confirmation actions immediately. Show directional counts and safety notes in the summary, with exact file paths available in View details instead of requiring a scroll through the entire file list.
- 8e32b4b: Exclude top-level `git/` package checkouts in new `.syncignore` starter files and list the starter rules in alphabetical order. Preserve existing rule files and recover interrupted creation with its original rules.

## 0.9.0

### Minor Changes

- 5dfa289: Resolve local ignore-file policies for reviewed setup, inspection, transfer, and recovery while keeping legacy policies usable in mixed settings. Keep rule files local and publish only the portable policy fingerprint in version 6 snapshots. Create a missing starter after confirmation on Linux, macOS, and Windows; if automatic creation is unavailable, show the exact path and instructions for manual creation. Preserve the existing settings writer and keep in-app rule saves disabled.

### Patch Changes

- 25777f7: Read Git history manifests in bounded batches to reduce subprocess launches. Keep the same history preview and validate all retained publications in the original order.

## 0.8.0

### Minor Changes

- d27317a: Prepare Pi Sync's local ignore-file policy, including recoverable default-file creation, settings review, and versioned snapshot compatibility checks. Existing setups are not migrated automatically. The new setup flow and first-open migration prompt remain disabled. Settings can show an existing rule file for manual editing; the daemon does not replace it. Settings shows the active settings path in RPC and explains which setup actions are unavailable while ignore-file transfers are disabled.

### Patch Changes

- 59ea738: Fix snapshot recovery on macOS when restoring files with older modification times. Recovery still verifies the staging file's identity and contents before restoring the backup.
- 4073de5: Fix Windows recovery when NTFS changes a restored file's creation time during rename. Keep exact content, file ID, spelling, and pre-rename ownership checks, and preserve existing recovery journal formats. Make the daemon build use the Node compiler entrypoint instead of spawning a Windows command script.

## 0.7.0

### Minor Changes

- 4d02a81: Default new Pi Sync setups to the Pi agent directory, with editable exclusions for sessions, managed binaries, and npm installations. Directory scope can restore selected exceptions to exclusions, but Pi credentials and project trust stay local. Existing selected-path setups keep their rules.
  
  Recheck the directory scan limits before deletions and writes. If a recovery staging attempt stops before ownership is saved, retry in a fresh path and preserve the unverified files.

## 0.6.2

### Patch Changes

- bb79479: Align the Sync daemon's model SDK with Pi 1.6. Keep pi-otel's Durable tracing compatible with Pi 1.6 and its parked tool states without exporting additional trace data.
- 77c45c6: Explain how to recover when the Sync daemon refuses a model whose definition or authentication source differs from the Pi host. Exact matching and no-fallback behavior are unchanged.

## 0.6.1

### Patch Changes

- 25eef0a: Update the runtime libraries for AgentFS shell execution, Langfuse trace export, Starship pattern matching, subagent ignore rules, and sync daemon XML parsing and glob matching.

## 0.6.0

### Minor Changes

- d96f85d: Retry lost file-queue release acknowledgements on the same daemon without
  replaying transfers. Keep brief retries quiet and show a recovery status for
  longer waits. The daemon client exposes an optional queue-release delivery
  observer without changing the IPC protocol.

## 0.5.1

### Patch Changes

- 06b470f: Fix Windows settings saves that fail with `EPERM` during atomic replacement by closing the previous settings handle before rename. Preserve source validation, rollback bytes, and POSIX concurrent-edit checks.

## 0.5.0

### Minor Changes

- 1f44df7: On the first active connection after an update, Pi Sync can replace an older daemon only if compatible, authenticated IPC works and no retained unattended grant blocks the upgrade. The replacement waits for the old daemon to release its identity and exit. If any check fails, follow the [manual recovery guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#ownership-and-upgrade). Passive and shutdown paths do not start a replacement. If an interactive session switch cannot upgrade the daemon, keep file protection when the old owner can still accept the session. Use `status` to find the pending or last recorded owner. When `repair-upgrade` successfully repairs a pending upgrade after verifying exit, it revokes all retained unattended grants and keeps the recovery records in one private archive across retries. It does not start a daemon.

## 0.4.0

### Minor Changes

- 223b0ba: Restore a live Pi session after its heartbeat expires without reloading Pi. The
  daemon distinguishes heartbeat expiry from deliberate disconnection and keeps
  file-queue and session protection in place. Pi Sync reconnects to the same owner
  without resubmitting interrupted operations, and checks participation before
  reporting that it is connected.

## 0.3.0

### Minor Changes

- ea5b9f1: Exit the daemon after a 30-second grace period when no registered client PID remains and no valid active-setup after-exit grant applies. Keep live, passive, disconnected, and retired clients protected; preserve paused authorization barriers and drain committed work before releasing ownership. No new setting or final synchronization is added.
  
  Let Pi Sync retry an authenticated idle-closing owner after confirmed process exit, with bounded, cancellable startup and no replay of submitted operations. Add the lightweight `waitForDaemonExit()` client helper. Let a later Pi Sync command reconnect after a cancelled unpublished attach by draining the old connection and using a fresh client ID and generation; keep failed cleanup blocked and never replay the cancelled operation. Publish and verify the daemon dependency before releasing Pi Sync; publication and real-data cutover still require separate approval.
- 5e251a8: Rename the daemon package to `@narumitw/pi-sync-daemon` and its executable to `pi-sync-daemon`, and update Pi Sync to use the renamed dependency. The new package does not provide the old `sync-daemon` executable alias. Stop an existing daemon before replacing its package, then use the new executable after installation. Preserve IPC identity, settings, state, recovery evidence, and authorization digests. Publish and verify the renamed dependency before releasing Pi Sync; publication and real-data cutover still require separate approval.

## 0.2.0

### Minor Changes

- 8bba72d: Extract the existing synchronization engine into the standalone TypeScript `@narumitw/sync-daemon` package and keep Pi Sync as its reviewed local API client. Share a detached root-bound owner across Pi sessions, retain existing formats and recovery safeguards, and separate service lifetime from unattended transfer and resolver permission.
  
  Preserve reviewed external-session destinations across all participating Pi queues and setup-scoped explicit Continuous retry without resetting request accounting.
  
  The daemon must be available before the dependent Pi client is released. Publication and real-data cutover require separate approval and the migration verification gates.

Initial development; not published.
