---
"@narumitw/pi-sync": minor
"@narumitw/pi-sync-daemon": minor
---

**Breaking change:** Remove `/sync status`, `/sync doctor`, and their menu actions. Use `/sync diff` for an immediate file comparison without Debug mode, or enable Debug mode and reload Pi for the `pi_sync_debug` tool. The tool reads recent sanitized results from `pi-sync.log` or rechecks the current setup after user confirmation. `/sync daemon status` is unchanged.

Log structured check outcomes for startup checks and approved rechecks. Keep WebDAV history repair as a separate, confirmed action under History when the active snapshot is missing. The daemon keeps the existing status and doctor operations for compatible clients.
