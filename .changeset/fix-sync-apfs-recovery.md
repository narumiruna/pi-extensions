---
"@narumitw/pi-sync-daemon": patch
---

Fix snapshot recovery on macOS when restoring files with older modification times. Recovery still verifies the staging file's identity and contents before restoring the backup.
