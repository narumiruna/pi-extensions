---
"@narumitw/pi-sync": minor
"@narumitw/pi-sync-daemon": minor
---

**Breaking change:** Remove `/sync status`, `/sync doctor`, `/sync config`, and the Check remote status and Diagnostics menu actions. Review sync setups and storage connections in **/sync → Settings** instead of `/sync config`. Use `/sync diff` for an immediate file comparison without Debug mode, or enable Debug mode and reload Pi for the `pi_sync_debug` tool. The model can call the tool directly or through codemode. It reads recent sanitized results from `pi-sync.log` or rechecks the current setup's remote storage without a confirmation prompt. `/sync daemon status` is unchanged.

Log structured check outcomes for startup checks and read-only rechecks. Keep WebDAV history repair as a separate, confirmed action under History when the active snapshot is missing. The daemon keeps the existing status and doctor operations for compatible clients. The main menu shows the six standard actions without a search field; Settings remains searchable.
