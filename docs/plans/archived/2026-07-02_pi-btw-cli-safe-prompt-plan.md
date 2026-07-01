## Goal

Make the Ghostty `/btw` fork-tab launch robust without relying on unsupported Pi CLI `--` argument terminator behavior. Success means `/btw --help`, `/btw @file`, and normal side questions all open a forked Pi tab as a prompt, not as Pi CLI flags or file arguments.

## Context

Pi CLI exists and supports `pi --fork <path|id>`, but the installed Pi parser currently treats bare `--` as an unknown extension flag instead of an option terminator. The Pi CLI source is not part of this `pi-extensions` repository, so this PR should not patch the installed global Pi package or `node_modules`.

## Non-Goals

- Do not create a new `pi-fork` package.
- Do not edit generated or installed Pi CLI files outside this repository.
- Do not change non-Ghostty `/btw` inline pager behavior.

## Plan

- [x] Update `extensions/pi-btw/src/btw.ts` so Ghostty initial input stays ASCII, decodes UTF-8 in the shell, and passes one safe prompt argument that cannot start with `-` or `@`; verify by inspecting `buildGhosttyForkTabInitialInput()` output.
- [x] Add regression tests in `extensions/pi-btw/test/btw.test.ts` for questions beginning with `--help`, `--model x`, and `@README.md`; verify generated input contains no bare ` -- ` sentinel and the prompt argument starts with safe text.
- [x] Keep the previous no-`exec` behavior so Ghostty tabs remain open on Pi errors; verify with the existing `doesNotMatch(input, /^exec /)` assertion.
- [x] Run `npm test -- --package pi-btw`, `npm run typecheck`, `npm run check`, and `npm run pack:btw`; verify all commands pass.
- [x] Commit the extension-only fix and push it to PR #134; verify with `gh pr view --json number,url,headRefOid`.

## Risks

- The forked Pi prompt will include a small `Side question:` prefix. This is intentional to avoid CLI misparsing and should be harmless for model behavior.
- True `pi --fork <session> -- <question>` support requires a separate Pi CLI change in the upstream Pi repository.

## Rollback / Recovery

- Revert the extension commit on the PR branch to restore the current `pi --fork <session> <question>` behavior.
- If a future Pi CLI release supports `--` as an option terminator, replace the safe-prefix workaround with `pi --fork <session> -- <question>` and keep the same regression tests.

## Completion Checklist

- [x] Ghostty `/btw` no longer depends on Pi CLI bare `--` behavior, verified by `extensions/pi-btw/test/btw.test.ts` assertions.
- [x] Questions beginning with `--` or `@` are delivered as side-question prompt text, verified by new unit tests.
- [x] Existing Ghostty tab-open, fallback, and non-Ghostty inline flows still pass, verified by `npm test -- --package pi-btw` and `npm run check`.
- [x] PR #134 contains the final fix, verified by `gh pr view --json number,url,headRefOid`.
