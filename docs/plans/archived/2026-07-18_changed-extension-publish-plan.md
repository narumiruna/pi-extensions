## Goal

Change tag-driven npm publishing so a release publishes only production extensions changed since the previous release, while retaining the shared repository version bump and accepting skipped npm version numbers for unchanged extensions.

## Context

`bump-version.yml` currently creates a final `chore(release): vX.Y.Z` commit that updates every production extension's version. `publish.yml` then sees every new `package@version` as unpublished and publishes all production extensions. GitHub Actions does not evaluate `paths` filters for tag pushes, so candidate selection must happen inside the workflow.

## Architecture

Add a small, testable repository script that emits publish candidates as package/version TSV. In release mode it will compare the previous reachable `v*.*.*` tag with the tagged release commit's parent, deliberately excluding the generated all-package version-bump commit. In all-packages mode it will preserve manual recovery behavior. The existing npm registry check remains the final idempotency guard before each publish.

## Non-Goals

- Do not change the shared version-bump model or assign independent package versions.
- Do not publish experimental, deprecated, private, deleted, or unchanged packages.
- Do not infer that root-only changes affect every extension; an extension is changed only when a path under its direct `extensions/<package>/` directory changed.

## Assumptions

- Normal release tags are created by `.github/workflows/bump-version.yml` on its generated `chore(release): <tag>` commit.
- A missing previous release tag or a nonstandard tag/commit shape should safely fall back to considering all production packages, preventing accidental under-publishing.
- `workflow_dispatch` remains a recovery path that considers all production packages; npm's existing-version check still prevents duplicate publication.

## Plan

- [x] Add `scripts/list-publish-workspaces.mjs` with release and all-packages modes, deterministic deduplicated TSV output, direct production-workspace discovery, previous-tag lookup, and the release-parent diff rule; its CLI passed temporary Git repository tests in `test/publish-workspaces.test.ts` (7/7).
- [x] Cover release selection cases in `test/publish-workspaces.test.ts`: one/multiple changed extensions, root-only changes, version-bump-only release commits, newly added and deleted packages, experimental/deprecated/private exclusions, first release, nonstandard release tags, deterministic ordering, and all-packages recovery mode; the focused compiled selector test passed (7/7), including a package introduced inside a noncanonical release commit.
- [x] Update `.github/workflows/publish.yml` to checkout full Git history, invoke release-mode selection for `v*.*.*` tag pushes, invoke all-packages mode for `workflow_dispatch`, log the selected candidates, and feed only those candidates into the existing npm existence-check/publish loop; the focused workflow/selector tests passed (11/11), including an empty candidate list, and the registry/provenance settings remain unchanged.
- [x] Validate the selector against repository history: `node scripts/list-publish-workspaces.mjs --release v0.18.0` selected exactly `pi-chrome-devtools`, `pi-firecrawl`, `pi-google-genai`, `pi-plan-mode`, `pi-subagents`, and `pi-telegraph`, demonstrating that the generated v0.18.0 bump commit does not select every package.
- [x] Run `npm run check` to verify formatting, boundary checks, workspace typechecks, and the complete test suite; the gate passed with 608 tests passed and 1 compatibility test skipped, and `git diff --check` passed.

## Risks

- Excluding the tagged commit would miss real extension changes placed directly in a manually created tag commit. Mitigation: only use diff-based selection for the canonical generated release shape and fall back to all production packages otherwise.
- A selector bug could omit a package from automated publishing. Mitigation: keep `workflow_dispatch` as an all-packages recovery path and retain the per-version npm existence guard.
- Root tooling or lockfile-only changes will not trigger any extension publication. This is intentional under the path-based definition and should be explicit in tests.

## Rollback / Recovery

- Re-run `Publish` through `workflow_dispatch` to publish any still-unpublished production `package@version`; already published versions will be skipped.
- Reverting the workflow and selector-script change restores the current publish-all-unpublished behavior without changing package metadata or npm state.

## Completion Checklist

- [x] A canonical tag release publishes only changed direct production extensions, verified by 7 temporary Git-history tests and the historical v0.18.0 check selecting exactly its 6 changed extensions.
- [x] Unchanged, experimental, deprecated, private, and deleted packages cannot enter the automated tag candidate list, verified by `test/publish-workspaces.test.ts`.
- [x] First-release, nonstandard-tag, and manual-dispatch recovery paths consider all production packages, verified by selector tests and `.github/workflows/publish.yml` event branching.
- [x] Publishing remains idempotent and provenance-enabled, verified by the retained `npm view "${package}@${version}"` guard and `NPM_CONFIG_PROVENANCE: "true"` in `.github/workflows/publish.yml`.
- [x] Repository quality gates pass, verified by `npm run check` (608 passed, 1 skipped) and `git diff --check`.
