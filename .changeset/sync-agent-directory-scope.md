---
"@narumitw/pi-sync": minor
"@narumitw/pi-sync-daemon": minor
---

Default new Pi Sync setups to the Pi agent directory, with editable exclusions for sessions, managed binaries, and npm installations. Directory scope can restore selected exceptions to exclusions, but Pi credentials and project trust stay local. Existing selected-path setups keep their rules.

Recheck the directory scan limits before deletions and writes. If a recovery staging attempt stops before ownership is saved, retry in a fresh path and preserve the unverified files.
