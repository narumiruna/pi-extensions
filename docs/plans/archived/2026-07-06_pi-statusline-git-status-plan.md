## Goal

Add compact Git status information to `@narumitw/pi-statusline` so the branch segment can show ahead/behind, staged, modified, untracked, and conflict counts without slowing footer rendering.

## Context

`pi-statusline` currently uses Pi's footer data provider for `getGitBranch()` only. Pi's footer API does not expose full `git status`, so the extension must run and cache `git status --porcelain=v1 --branch` itself.

## Assumptions

- Clean repositories should not show an extra clean marker.
- Compact tokens are `⇡N`, `⇣N`, `+N`, `~N`, `?N`, and `!N` for ahead, behind, staged, modified, untracked, and conflicts.
- Git status refresh should be event-driven plus a low-frequency 30s poll.

## Plan

- [x] Add parser/formatter tests in `extensions/pi-statusline/test/statusline.test.ts` for porcelain v1 branch status, dirty counts, clean output, and branch text with PR links; verified red first with `npm test` failing on missing `formatGitBranchText`, `formatGitStatusSummary`, and `parseGitStatusPorcelain` exports.
- [x] Implement git status parsing and compact formatting in `extensions/pi-statusline/src/statusline.ts`; verified by `npm test` passing parser/formatter tests.
- [x] Add asynchronous cached refresh logic in `extensions/pi-statusline/src/statusline.ts` that runs on session start, branch change, tool/turn completion, and every 30 seconds without running git commands during render; verified by tests for non-TUI skip, cached render, stale-event ignore, plus final reviewer PASS.
- [x] Update `extensions/pi-statusline/README.md` to document compact git status tokens; verified the README includes all six token meanings.
- [x] Run package-level and repository checks relevant to the change (`npm test`, `npm run typecheck`, and `npm run biome:check`); verified by `npm run check` passing, including Biome, boundary checks, typecheck, and 156 tests.

## Risks

- Running `git status` too often could make the TUI feel sluggish in large repositories; mitigate by caching, avoiding render-time commands, and using a 30s poll plus event refreshes.
- Async refreshes can outlive a session reload; mitigate with generation checks and by clearing timers on footer disposal/session shutdown.

## Completion Checklist

- [x] The branch segment shows no extra clean marker for clean repositories, verified by `git status formatter omits clean markers` in `npm test`.
- [x] Dirty repositories render compact tokens for ahead/behind, staged, modified, untracked, and conflicts, verified by `git status parser and formatter produce compact dirty tokens` in `npm test`.
- [x] Footer rendering does not execute git commands synchronously, verified by `statusline renders cached git status without executing git during render` in `npm test` and final reviewer PASS.
- [x] Git status documentation is present in `extensions/pi-statusline/README.md`, verified by token descriptions for `⇡`, `⇣`, `+`, `~`, `?`, and `!`.
- [x] The change passes `npm test`, `npm run typecheck`, and `npm run biome:check`, verified by `npm run check` passing with 156 tests.
