---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

Exit the daemon after a 30-second grace period when no registered client PID remains and no valid active-setup after-exit grant applies. Keep live, passive, disconnected, and retired clients protected; preserve paused authorization barriers and drain committed work before releasing ownership. No new setting or final synchronization is added.

Let Pi Sync retry an authenticated idle-closing owner after confirmed process exit, with bounded, cancellable startup and no replay of submitted operations. Add the lightweight `waitForDaemonExit()` client helper. Let a later Pi Sync command reconnect after a cancelled unpublished attach by draining the old connection and using a fresh client ID and generation; keep failed cleanup blocked and never replay the cancelled operation. Publish and verify the daemon dependency before releasing Pi Sync; publication and real-data cutover still require separate approval.
