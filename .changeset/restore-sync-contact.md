---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

Restore a live Pi session after its heartbeat expires without reloading Pi. The
daemon distinguishes heartbeat expiry from deliberate disconnection and keeps
file-queue and session protection in place. Pi Sync reconnects to the same owner
without resubmitting interrupted operations, and checks participation before
reporting that it is connected.
