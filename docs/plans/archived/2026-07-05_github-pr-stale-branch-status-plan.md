## Goal

Fix `@narumitw/pi-github-pr` so it does not keep showing the previous pull request after a Git branch switch. Success means switching to `main` or a new branch with no PR no longer lets `pi-statusline` render stale combinations such as `main (#4)`, while branches with PRs still show the correct PR for the current branch.

## Context

- `extensions/pi-github-pr/src/github-pr.ts` previously refreshed only on `session_start` and `agent_end`, and cleared only on `session_shutdown`; it did not listen for Git branch changes.
- `extensions/pi-statusline/src/statusline.ts` renders the current Git branch together with the PR link from the `github-pr` status. If the branch updates before `github-pr` refreshes or clears, the statusline can show `main (#4)`.
- Running `gh pr view --json number,url,headRefName` on local `main` returned `no pull requests found for branch "main"`, proving a refresh would clear the status; the missing piece was refreshing or clearing immediately on branch change.

## Non-Goals

- Do not add a GitHub API client, polling loop, slash command, or PR discussion-body fetching.

## Plan

- [x] Add a stale-PR regression test in `extensions/pi-github-pr/test/github-pr.test.ts`: simulate PR #4 already being displayed, trigger a branch change callback, expect `github-pr` status to clear immediately, and ensure the old refresh cannot write back later; verified first failing with `npm test -- --test-name-pattern='branch changes clear stale PR status|session shutdown disposes|branch watcher failures'`, then passing with `npm test`.
- [x] Add a minimal branch watcher in `extensions/pi-github-pr/src/github-pr.ts`: on `session_start`, run `git rev-parse --git-path HEAD` to locate `.git/HEAD` and watch it with `fs.watch`; if watching fails or the directory is not a Git repo, keep the existing session/agent-end refresh behavior; verified by the `branch watcher failures stay non-intrusive` test.
- [x] On watcher events, immediately call `clearStatus(ctx)`, increment the refresh generation, and debounce one `runGhPrView()` call; verified by `branch changes clear stale PR status and stale refreshes cannot restore it`, which checks that branch changes clear the status first and then refresh to an empty state.
- [x] Add a generation/race guard to `refreshStatus` so older `gh pr view` results cannot overwrite the status after a branch change; verified by `branch changes clear stale PR status and stale refreshes cannot restore it`, which ensures a slow old PR lookup does not re-show #4.
- [x] On `session_shutdown`, close the watcher, clear the debounce timer, and clear `github-pr` status; verified by `session shutdown disposes the branch watcher and pending refresh` plus the existing lifecycle test.
- [x] Update `extensions/pi-github-pr/README.md` Behavior/Known limits to say Git branch changes clear and refresh the status, while continuous polling is still not used; verified with `rg -n "branch change|polling|session start|agent turn|session_start|agent_end" extensions/pi-github-pr/README.md`.
- [x] Run verification commands: `npm test`, `npm run check`, and `npm run pack:github-pr`; all passed.

## Risks

- `fs.watch` may miss events on some filesystems; the existing `session_start` and `agent_end` refreshes remain as fallbacks.
- Watch callbacks capture session context; session/generation guards plus `session_shutdown` cleanup reduce the risk of stale callbacks writing status after reload or session replacement.

## Completion Checklist

- [x] Switching to a branch with no PR no longer shows a stale PR, verified by the `branch changes clear stale PR status and stale refreshes cannot restore it` regression test.
- [x] Slow old refreshes cannot overwrite the new branch status, verified by the `npm test` race test `branch changes clear stale PR status and stale refreshes cannot restore it`.
- [x] README behavior matches the implementation, verified by `rg -n "branch change|polling|session start|agent turn|session_start|agent_end" extensions/pi-github-pr/README.md` and manual review.
- [x] `npm test`, `npm run check`, and `npm run pack:github-pr` all passed.
