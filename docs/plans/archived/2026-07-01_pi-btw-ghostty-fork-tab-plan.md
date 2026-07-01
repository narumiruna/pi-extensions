## Goal

Replace the current macOS Ghostty `/btw` temp-file answer tab with a forked Pi tab flow. In Ghostty, `/btw <question>` should open a new Ghostty tab, start a separate `pi --fork <current-session>` session in the same cwd, and submit the text after `/btw` as that fork's first prompt. Non-Ghostty terminals keep the existing inline `/btw` answer pager.

## Context

The temp-file answer tab works like a display pane, but it cannot continue the side conversation and leaves best-effort temp cleanup. Pi already supports `--fork <path|id>`, which creates a new session file from the current session instead of having two Pi processes write the same session.

## Non-Goals

- Do not create a new `pi-fork` package.
- Do not sync or merge the forked side conversation back into the original session.
- Do not keep the temp answer-file Ghostty implementation.

## Assumptions

- `ctx.sessionManager.getSessionFile()` is available in command context and returns the current session path when session persistence is enabled.
- The `pi` executable is available in the new tab's PATH, matching normal user usage.

## Plan

- [x] Remove the Ghostty temp-answer implementation from `extensions/pi-btw/src/btw.ts`, including temp file writes, answer display shell command, and related tests; verified with `rg "pi-btw-|answer.md|buildGhosttyTabShellCommand" extensions/pi-btw` returning no matches.
- [x] Add a Ghostty fork-tab path before `askSideQuestion()` so macOS Ghostty `/btw <question>` does not spend a model call in the original session; verified by `btw opens Ghostty fork tab before asking locally` in `extensions/pi-btw/test/btw.test.ts` asserting `pi.exec("osascript", ...)` and zero custom UI/model calls.
- [x] Build Ghostty AppleScript using `new tab ... with configuration cfg`, `initial working directory`, and `initial input` that runs `exec pi --fork <session-file>` with the escaped question; verified by helper tests covering spaces, quotes, Unicode, and newlines in cwd/session/question.
- [x] Add fallback behavior: if no session file exists or AppleScript fails/times out, notify a warning and use the existing inline pager flow; verified by no-session and AppleScript-failure tests in `extensions/pi-btw/test/btw.test.ts`.
- [x] Update `extensions/pi-btw/README.md` to describe Ghostty fork-tab behavior and remove temp-file answer-tab wording; verified with `rg "temp answer|temp-file|answer file|answer.md|generated answer" extensions/pi-btw/README.md extensions/pi-btw/src/btw.ts extensions/pi-btw/test/btw.test.ts` returning no matches.
- [x] Run `npm test`, `npm run typecheck`, `npm run check`, and `npm run pack:btw`; verified all pass and `npm run pack:btw` dry-run package contains only `LICENSE`, `README.md`, `package.json`, and `src/btw.ts`.

## Risks

- Mitigated: instead of delayed typing into an already launched Pi, the new tab runs `pi --fork <session> -- <question>` as one startup command, so the question is the fork's initial prompt without terminal-input races; verified by generated-command tests.
- Accepted: `pi` must be in PATH in the new tab's shell. Add a configurable command only if real users hit it.

## Completion Checklist

- [x] Ghostty `/btw` creates a separate forked Pi session instead of a temp answer display, verified by source review and helper tests in `extensions/pi-btw/test/btw.test.ts`.
- [x] Original-session `/btw` still works outside Ghostty, verified by `btw uses inline pager outside Ghostty` and `npm test`.
- [x] README documents the new fork-tab behavior and non-goals, verified by `extensions/pi-btw/README.md` review.
- [x] Release gates pass, verified by `npm test`, `npm run typecheck`, `npm run check`, and `npm run pack:btw`.
