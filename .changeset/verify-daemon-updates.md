---
"@narumitw/pi-sync": patch
"@narumitw/pi-sync-daemon": patch
---

Report the verified Pi Sync daemon build after an update and compare the running and expected builds in daemon status. For a same-version local build, use the explicit daemon restart, which now shares the guarded upgrade path and refuses to downgrade a newer owner.
