---
"@narumitw/pi-sync": minor
"@narumitw/pi-sync-daemon": minor
---

Add independent, default-off file and directory transfer size limits for each sync setup. The daemon checks the selected uncompressed content before a new transfer writes locally or publishes remotely, including automatic sync. Enabling either limit requires local settings version 9, which older processes refuse even after the limits are cleared. Remote snapshot formats are unchanged.
