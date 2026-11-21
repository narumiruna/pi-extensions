---
"@narumitw/pi-sync": patch
"@narumitw/pi-sync-daemon": patch
---

Fix Windows recovery when NTFS changes a restored file's creation time during rename. Keep exact content, file ID, spelling, and pre-rename ownership checks, and preserve existing recovery journal formats. Make the daemon build use the Node compiler entrypoint instead of spawning a Windows command script.
