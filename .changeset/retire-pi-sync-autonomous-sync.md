---
"@narumitw/pi-sync": minor
"@narumitw/pi-sync-daemon": minor
---

Breaking: retire Autonomous sync, Continuous sync, model-assisted conflict resolution, and unattended sync. Existing `sync.agentMode` and `sync.continuous` settings remain readable but have no effect. Reviewed manual sync, Automatic sync, and Startup transfer retain their existing rules. Drain and replace older daemons safely; revoke retained after-exit grants if they block an upgrade.
