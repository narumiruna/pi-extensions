---
"@narumitw/pi-goal": minor
---

Bundle the pi-goal-writer skill with the package.

Pi now loads a `pi-goal-writer` skill from `packages/pi-goal/skills`, which drafts and reviews `/goal` objectives against the runtime contract: outcome, verification surface, constraints, boundaries, iteration policy, and `goal_blocked` / `goal_wait` stop conditions. Adapted from Michaelliv/pi-goal-writer (MIT) and tuned to the extension's command surface and 4000-character objective limit.
