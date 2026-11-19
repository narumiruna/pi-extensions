# @narumitw/pi-sync-daemon

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
