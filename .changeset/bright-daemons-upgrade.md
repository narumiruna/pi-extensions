---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

Replace an older, reachable Pi Sync daemon on the first active connection after an upgrade. Wait for the old daemon to stop and exit before starting the new build. Passive and shutdown paths do not start a replacement. If an interactive session switch cannot upgrade the daemon, keep file protection when the old owner can still accept the session. Use `status` to find the pending owner and `repair-upgrade` to recover after verified exit without starting unattended work.
