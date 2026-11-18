---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

Replace an older, reachable Pi Sync daemon on the first active connection after an upgrade. Wait for the old daemon to stop and exit before starting the new build. Passive and shutdown paths do not start a replacement. If an interactive session switch cannot upgrade the daemon, keep file protection when the old owner can still accept the session. Use `status` to find the pending or last recorded owner. After verified exit, `repair-upgrade` confirms that unattended grants have been revoked and keeps the recovery records in one private archive across retries. It does not start a daemon.
