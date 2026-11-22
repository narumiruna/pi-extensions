---
"@narumitw/pi-sync": patch
"@narumitw/pi-sync-daemon": patch
---

Reduce sync work without changing transfer approvals or recovery formats. Pull and rollback avoid reinstalling identical files, inspection avoids building unused payloads, and local requests wait for state changes instead of repeatedly polling jobs. Reduce repeated setup reads, review downloads, and backend work while preserving fresh checks and existing peer compatibility.
