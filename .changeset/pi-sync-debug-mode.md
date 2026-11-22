---
"@narumitw/pi-sync": minor
---

Rename **Debug startup timings** to **Debug mode** and keep the same default-off setting. Append safe startup, connection, and request diagnostics to the private, local-only `pi-sync.log` shared with the daemon. Client changes take effect at the next session start; existing TUI timing entries and RPC notifications stay unchanged.
