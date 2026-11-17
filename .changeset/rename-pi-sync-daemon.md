---
"@narumitw/pi-sync-daemon": minor
"@narumitw/pi-sync": patch
---

Rename the daemon package to `@narumitw/pi-sync-daemon` and its executable to `pi-sync-daemon`, and update Pi Sync to use the renamed dependency. The new package does not provide the old `sync-daemon` executable alias. Stop an existing daemon before replacing its package, then use the new executable after installation. Preserve IPC identity, settings, state, recovery evidence, and authorization digests. Publish and verify the renamed dependency before releasing Pi Sync; publication and real-data cutover still require separate approval.
