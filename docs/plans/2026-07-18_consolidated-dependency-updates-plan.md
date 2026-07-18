## Goal

Replace open Dependabot PRs #238–#243 with one verified PR that applies all six dependency updates and resolves their combined TypeScript 7 and Pi 0.80.10 compatibility failures.

## Context

- PRs #238, #240, #241, and #243 pass independently.
- PR #239 fails because TypeScript 7 no longer exposes the legacy compiler API from the package root.
- PR #242 fails against Pi latest because `ThinkingLevel` adds `max`, SDK session creation replaces `modelRegistry` with `modelRuntime`, and partial Pi package upgrades duplicate nominal `pi-tui` types.
- The repository CI matrix must continue passing with Pi 0.79.10, Pi 0.80.3, and Pi latest.

## Plan

- [x] Audit PRs #238–#243, including files, release notes, checks, reviews, issue comments, and inline comments; verified through `gh pr view` plus `gh api repos/{owner}/{repo}/pulls/<number>/comments` (no review comments found).
- [x] Add or reuse focused regression coverage for TypeScript 7 module extraction, Pi `max` thinking behavior, and SDK child-session compatibility; the new `pi-btw` test failed on `max`, while PR CI logs captured the boundary-check and SDK/latest failures before implementation.
- [x] Consolidate the six manifest/workflow upgrades, align direct Pi package versions at 0.80.10, and regenerate `package-lock.json` with npm 11.16.0; verified with a clean `npm ci` and `npm ls --all`.
- [x] Migrate the boundary checker to TypeScript 7's supported API and add cross-version Pi compatibility adaptations without weakening the 0.79.10/0.80.3 matrix; verified by focused typechecks, SDK smoke coverage, and the boundary check.
- [x] Run the full local gate and reproduce all three Pi matrix variants; `npm run check` passed with Pi 0.79.10, Pi 0.80.3, and the committed Pi 0.80.10 dependency state.
- [ ] Inspect the final diff, commit only intended files, push the branch, open the replacement PR, and close superseded PRs #238–#243 with a link to it; verify GitHub reports the new PR and closure state.

## Risks

- Pi's new `ModelRuntime` is not exposed on `ExtensionContext`; the child-session adapter must use public APIs and preserve extension provider registrations rather than reaching into private runtime fields.
- TypeScript 7's compiler API is explicitly under `typescript/unstable/*`; keep usage narrow and covered by boundary-check tests.
- Matrix installation mutates manifests and the lockfile locally; restore the committed dependency state before final diff/commit review.

## Completion Checklist

- [x] All six requested updates are present in the branch, verified by the manifest, lockfile, and workflow diffs.
- [x] TypeScript 7 boundary checking and Pi 0.80.10 runtime/type changes are covered by passing regression tests.
- [x] `npm run check` and all three Pi compatibility variants pass locally.
- [ ] The branch is committed and pushed, the replacement PR is open, and PRs #238–#243 are closed as superseded.
