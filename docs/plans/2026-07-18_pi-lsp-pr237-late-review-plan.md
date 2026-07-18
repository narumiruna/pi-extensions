## Goal

Address every actionable comment in PR #237 review 4727878361 and deliver the verified fixes in a new pull request.

## Context

PR #237 merged before a late automated review reported five issues: a save-only Terraform setting, incorrectly shaped Intelephense settings, Windows `Path` override handling, and language IDs for OCaml interfaces and literate Haskell.

## Plan

- [x] Add regression expectations for Intelephense/Terraform defaults, `.mli`/`.lhs` language IDs, and case-insensitive Windows `Path` handling; `tsc -p tsconfig.test.json` fails on the missing Windows helpers before implementation.
- [x] Correct the catalog settings and language IDs, and normalize Windows environment lookup/child environment merging; focused pi-lsp tests pass 10/10.
- [x] Run the repository and package gates; `npm run check` passes 600/601 with one intentional skip, `npm run pack:lsp` contains the expected 12 files, `git diff --check` passes, and the bounded attribution search is clean.
- [ ] Commit and push the focused changes, create a new PR against `main`, then reply to and resolve all five late-review threads with the new PR evidence.
- [ ] Confirm the new PR is open, all checks pass, all targeted threads are resolved, the branch is synchronized, and the worktree is clean.

## Risks

- Windows environment behavior is tested through platform-parameterized pure helpers because the repository CI matrix runs on Linux.
- Sending save notifications to every language server could change diagnostics behavior globally, so the Terraform fix removes the unsupported save-only default instead of broadening the client protocol flow.

## Completion Checklist

- [x] All five review findings are covered by code and regression assertions in `extensions/pi-lsp`.
- [x] Full verification and the pi-lsp package dry run pass.
- [ ] A new PR exists with the fixes, passing CI, and no unresolved targeted review threads.
- [ ] The final branch and remote are synchronized with a clean worktree.
