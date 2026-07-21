## Goal

Add a clear, low-noise deprecation path for `@narumitw/pi-codex-accounts` so users who still load it are warned to migrate to `@narumitw/pi-accounts`, with verified code, docs, and release guidance.

## Context

`pi-accounts` now manages Codex plus additional subscription OAuth providers and already documents that users should not load both packages together. `pi-codex-accounts` still registers commands and runs on `session_start`, making that extension the reliable place to warn users who have only the legacy package loaded.

## Non-Goals

- Do not remove or break existing `pi-codex-accounts` commands in this change.
- Do not publish an npm deprecation notice without explicit maintainer approval for the exact npm action.
- Do not make `pi-codex-accounts` hard-fail on startup during this warning phase.

## Plan

- [x] Add a module-level deprecation warning message in `extensions/pi-codex-accounts/src/codex-accounts.ts` that names `@narumitw/pi-codex-accounts`, points to `@narumitw/pi-accounts`, includes uninstall/install commands, and says not to load both packages; verified by source inspection of exported `DEPRECATION_WARNING_MESSAGE` in `extensions/pi-codex-accounts/src/codex-accounts.ts`.
- [x] Emit the deprecation warning once per Pi session from the existing `session_start` handler before or near the migration notice without blocking `sync(ctx)`; verified by `session_start warns once that pi-codex-accounts is deprecated` and source inspection of the `deprecationWarningShown` guard before `await sync(ctx)`.
- [x] Add or update `extensions/pi-codex-accounts/test/*.test.ts` coverage to assert the warning is shown once on `session_start` and existing migration notice behavior remains intact; verified by `npm run check` with 962 passing tests, including the new session-start warning test and updated migration test.
- [x] Add a deprecated banner near the top of `extensions/pi-codex-accounts/README.md` with migration commands and the “do not load both” warning; verified by reading `extensions/pi-codex-accounts/README.md`.
- [x] Not applicable: `extensions/pi-codex-accounts/package.json` metadata was reviewed and left unchanged because no package metadata change was needed for runtime or README discoverability in this implementation pass.
- [x] Run formatting, typechecking, and relevant tests for the touched package; verified by `npm run check` from the worktree root, which completed Biome check, boundary check, workspace typechecks, and 962 passing tests.
- [x] Prepare release notes and, only after explicit maintainer approval, run the npm deprecation command for the published legacy package; verified by the release-notes draft below. The npm deprecation action is not applicable for this implementation pass because no explicit maintainer approval for the public npm action was given.

## Risks

- A warning every startup may annoy users, but showing it once per session keeps the reminder visible without repeating every turn. Mitigated by the `deprecationWarningShown` per-extension-instance guard.
- Loading both packages can still cause credential-refresh conflicts; mitigated by stating this clearly in both the runtime warning and README banner.
- npm deprecation is a public package action and must be explicitly approved before execution. Accepted for this implementation pass; the command was not run.

## Rollback / Recovery

- If the runtime warning is too noisy, revert the `session_start` notification change or gate it behind a persisted acknowledgement in a follow-up.
- If package users report confusion, update the README and warning copy without changing credential storage or auth behavior.

## Release Notes Draft

`@narumitw/pi-codex-accounts` now warns once per Pi session that the package is deprecated and directs users to migrate to `@narumitw/pi-accounts`. The README includes matching migration commands and warns not to load both extensions at the same time. Existing account-switching behavior is unchanged.

Optional npm deprecation command, pending explicit maintainer approval for the exact public action:

```bash
npm deprecate @narumitw/pi-codex-accounts "@narumitw/pi-codex-accounts is deprecated; please migrate to @narumitw/pi-accounts. Do not load both extensions at the same time."
```

## Completion Checklist

- [x] Users loading `pi-codex-accounts` receive a once-per-session deprecation warning verified by `session_start warns once that pi-codex-accounts is deprecated` and `npm run check`.
- [x] The warning and README both tell users to migrate to `@narumitw/pi-accounts` and not to load both packages, verified by `extensions/pi-codex-accounts/src/codex-accounts.ts` and `extensions/pi-codex-accounts/README.md` source inspection.
- [x] Existing account-switching behavior remains working, verified by `npm run check` completing workspace typechecks and 962 passing tests.
- [x] Any public npm deprecation action is either explicitly approved and verified with `npm view`, or marked not applicable for this implementation pass; no approval was given, so the npm deprecation action was not run and is documented as not applicable above.
