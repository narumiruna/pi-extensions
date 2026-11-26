---
"@narumitw/pi-sync": minor
"@narumitw/pi-sync-daemon": minor
---

Breaking: remove `.syncignore` and custom ignore-file policies. New setups recommend Selected paths; agent-directory scope with explicit exclusions remains available. Existing ignore-file settings, snapshot versions 6 and 7, and pending ignore-file recovery stop without converting or deleting data. Run `/skill:configure-pi-sync` for manual recovery guidance before resuming sync.
