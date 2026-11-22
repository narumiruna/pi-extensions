---
"@narumitw/pi-sync": patch
---

Make the configuration skill verify the active ignore file with the existing local daemon before editing it. Stop on older daemon builds, and leave settings changes that require consent or policy review in `/sync`.
