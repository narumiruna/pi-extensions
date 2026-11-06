---
"@narumitw/pi-goal": patch
---

Use Pi's native provider retry and context-overflow classifiers without Goal-owned retry patterns or usage/authentication vetoes. Keep unclassified assistant errors in deadline-free active waiting without adding a retry, including premature stream closures, invalid requests, authentication failures, and empty error messages. Preserve Goal identity and managed-run ownership until wake, completion, or explicit cancellation; permanent failures can wait indefinitely. Select final recognized usage limits after native recovery, and pause when Pi reports a cancelled run or automatic compaction. Preserve active waiting after native retry-only cancellation; use `/goal pause` for an explicit pause. Keep safety limits and automatic accounting through native truncated-response compaction. Preserve pending errors across threshold compaction and block failed native compaction recovery.
