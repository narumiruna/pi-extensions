---
"@narumitw/pi-goal": patch
---

Treat prematurely closed connections and prematurely ended streams as retryable Goal interruptions, including proxy-wrapped HTTP 400 errors. Keep the Goal active through the existing provider-recovery wait instead of marking it blocked.
