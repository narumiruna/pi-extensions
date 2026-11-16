---
"@narumitw/sync-daemon": minor
"@narumitw/pi-sync": minor
---

Extract the existing synchronization engine into the standalone TypeScript `@narumitw/sync-daemon` package and keep Pi Sync as its reviewed local API client. Share a detached root-bound owner across Pi sessions, retain existing formats and recovery safeguards, and separate service lifetime from unattended transfer and resolver permission.

Preserve reviewed external-session destinations across all participating Pi queues and setup-scoped explicit Continuous retry without resetting request accounting.

The daemon must be available before the dependent Pi client is released. Publication and real-data cutover require separate approval and the migration verification gates.
