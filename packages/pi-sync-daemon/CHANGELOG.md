# @narumitw/pi-sync-daemon

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
