---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

On the first active connection after an update, Pi Sync can replace an older daemon only if compatible, authenticated IPC works and no retained unattended grant blocks the upgrade. The replacement waits for the old daemon to release its identity and exit. If any check fails, follow the [manual recovery guide](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-sync/docs/daemon-migration.md#ownership-and-upgrade). Passive and shutdown paths do not start a replacement. If an interactive session switch cannot upgrade the daemon, keep file protection when the old owner can still accept the session. Use `status` to find the pending or last recorded owner. When `repair-upgrade` successfully repairs a pending upgrade after verifying exit, it revokes all retained unattended grants and keeps the recovery records in one private archive across retries. It does not start a daemon.
