# pi-subagents PR #328 review follow-up plan

## Goal

Resolve all three inline comments from review `pullrequestreview-4757424505` without steering users toward unavailable lifecycle tools or delaying required synthesis under the default completion policy, then open a verified follow-up pull request.

## Plan

- [x] Inspect PR #328, the targeted review, and every inline thread; verified three unresolved comments: `discussion_r3632715103`, `discussion_r3632715110`, and `discussion_r3632715117`.
- [x] Add focused metadata regression tests for default next-turn delivery, non-contradictory blocking guidance, and disabled stateful tools; the initial focused run failed four assertions against the merged PR #328 behavior.
- [x] Update pi-subagents prompt metadata so detached final-dependent work requires auto-resume, blocking guidance distinguishes root-doable work, and only registered lifecycle tools advertise detached spawning; all 25 focused tests pass.
- [x] Align the package README and implementation notes with both completion-delivery policies and the stateful-disabled behavior; intended files are formatted, `git diff --check` passes, and stale-guidance searches find final-dependent detached recommendations only under auto-resume.
- [x] Run focused tests, the CI-equivalent `npm run check`, and `just pack-subagents`; 25 focused tests and all 1,041 repository tests passed, package typecheck passed, and the dry run contained the expected 22 files.
- [ ] Commit and push the bounded follow-up branch, then create a new pull request referencing PR #328 and all three review comments.

## Completion Checklist

- [x] Every comment in review `4757424505` has a corresponding code, test, or documentation resolution.
- [x] Default `next-turn` guidance keeps final-answer-dependent work on the blocking path; opt-in `auto-resume` may prefer detached final-dependent work.
- [x] Blocking guidance is internally consistent and does not advertise `subagent_spawn` when stateful tools are disabled.
- [x] All required checks pass and the package dry run contains only expected files.
- [ ] The follow-up commit is pushed and a new pull request is open.
