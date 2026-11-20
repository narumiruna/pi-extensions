---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

Retry lost file-queue release acknowledgements on the same daemon without
replaying transfers. Keep brief retries quiet and show a recovery status for
longer waits. The daemon client exposes an optional queue-release delivery
observer without changing the IPC protocol.
