---
"@narumitw/pi-goal": patch
---

Store independent Goal state snapshots in session history so later accounting and waiting-state updates do not change earlier entries. Keep in-memory history aligned with JSONL records and preserve append-time state during deferred writes and branch restoration.
