---
"@narumitw/pi-goal": patch
---

Use Pi's native provider retry and context-overflow classifiers without Goal-owned retry patterns or usage/authentication vetoes. Preserve quiet waiting after transient failures, select final usage limits after native recovery, and pause when Pi reports a cancelled run or automatic compaction. Pi's native retry-only cancellation has no public extension signal and remains waiting; use `/goal pause` for an explicit pause. Keep automatic accounting through native truncated-response compaction. Unsupported premature-close wording now follows Pi's terminal classification and requires explicit resume.
