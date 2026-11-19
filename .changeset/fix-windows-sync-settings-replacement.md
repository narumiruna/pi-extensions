---
"@narumitw/pi-sync-daemon": patch
---

Fix Windows settings saves that fail with `EPERM` during atomic replacement by closing the previous settings handle before rename. Preserve source validation, rollback bytes, and POSIX concurrent-edit checks.
