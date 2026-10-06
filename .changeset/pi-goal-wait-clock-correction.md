---
"@narumitw/pi-goal": patch
---

Re-arm a `goal_wait` deadline timer that fires before `resumeAt` after a backward wall-clock correction, so the safety deadline still wakes the goal instead of being silently dropped.
