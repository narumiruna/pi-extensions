---
"@narumitw/pi-sync": patch
---

Ship the daemon with Pi Sync so npm installs no longer require the standalone daemon package. The daemon still runs in a separate Node.js process with the same ownership and upgrade rules. If you only install Pi Sync, run `node <pi-sync-package>/dist/daemon/dist/cli.js` to use the daemon CLI. Standalone daemon releases do not update the bundled copy; update Pi Sync to get a newer bundled build.
