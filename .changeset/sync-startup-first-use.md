---
"@narumitw/pi-sync": patch
---

Reduce Pi startup loading by deferring command, transfer, and recovery implementations until needed. Preserve awaited recovery for pending file transactions and all existing sync settings.
