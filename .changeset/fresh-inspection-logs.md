---
"@narumitw/pi-sync-daemon": patch
---

Attempt to write Pi Sync inspection diagnostics before returning the result so the next settings read does not race the log write.
