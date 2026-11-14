---
"@narumitw/pi-sync": minor
---

Use a shared agent-root `.syncignore` instead of JSON include lists for new setups. Synchronize exact Git-style exclusion rules with snapshots, protect credentials and internal state, review policy differences before transfers, and provide an explicit conservative migration for legacy setups. Existing setups keep their include behavior until migration; upgrade all machines before using settings version 6 and snapshot version 4.
