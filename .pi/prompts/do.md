---
description: Complete a plan on a new branch and deliver it as a pull request
argument-hint: "<plan path>"
---

Plan: $ARGUMENTS

If no plan path was provided, ask for it and stop.
Execute and complete the specified plan end to end.

1. Read the repository instructions and the complete plan before changing anything.
2. Inspect the working tree, preserve unrelated changes, and create a focused new branch from the appropriate base branch.
3. Execute every required plan item in dependency order, keeping the plan synchronized with discoveries and verified progress.
   If a material scope, architecture, risk, or acceptance criterion changes, update the plan and wait for explicit approval before continuing.
4. Create or update the code, tests, documentation, configuration, and other artifacts required by the plan.
5. Run focused verification and all repository-required checks.
6. Review the complete diff for correctness, security, lifecycle safety, compatibility, regressions, and unnecessary changes.
7. When executable behavior is affected, harden plausible edge cases and failure paths within the approved scope, add applicable regression coverage, and rerun affected checks.
8. Audit the finished work against every plan requirement and completion criterion.
9. After every required checkbox has passed, delete the completed plan file; keep any incomplete plan and its unchecked evidence.
10. Stage only the intended files, create focused signed commits that follow repository conventions, and push the branch.
11. Open a pull request with a concise summary, verification evidence, and relevant risks or unverified paths.

Do not discard user changes, conceal failing checks, or claim completion without evidence.
Do not publish packages, create version tags, or dispatch release workflows.
