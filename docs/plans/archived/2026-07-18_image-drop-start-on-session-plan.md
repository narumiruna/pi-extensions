## Goal

Allow users to configure global `pi-image-drop.json` settings so Image Drop starts automatically and provides a link when a Pi session starts, while preserving the current behavior of requiring `/image-drop` when the option is disabled.

## Context

- Currently, `ImageDropRuntime.start()` only creates the session batch and processor. The HTTP server starts lazily when `/image-drop` first calls `ensureServer()`.
- The settings file uses strict whole-file validation. A new field must be added to the type, defaults, allowed keys, and documentation, or the entire settings file will be ignored.
- Here, “automatic startup” means starting the loopback server, issuing a one-time link, and displaying the link in a Pi widget and notification. It does not open a browser through the operating system.

## Architecture

Add a boolean `startOnSessionStart` setting with a safe default of `false` to preserve backward compatibility. After `session_start` finishes initializing the settings and batch, a `true` value calls `ensureServer()` and `issueLink()` through the same link-presentation helper used by `/image-drop`, then displays the link. Automatic startup failures only display an error notification and must not fail Pi session startup. The existing generation guard and `releaseServer()` continue to handle session replacement and shutdown races.

## Non-Goals

- Do not open a browser automatically or add an external launcher dependency.
- Do not add a project-local override or environment variable.
- Do not change the bootstrap token, cookie, Host/Origin, or client lease security model.

## Plan

- [x] Add failing `startOnSessionStart` tests to `extensions/pi-image-drop/test/settings.test.ts`, covering the default `false`, valid `true`/`false`, non-boolean values, and unknown-field whole-file fallback. `npm test` failed with TS2339 because the setting did not yet exist, proving the tests detected the missing implementation.
- [x] Update the settings type, defaults, and key validation in `extensions/pi-image-drop/src/settings.ts`, separating numeric hard-limit types from the boolean setting so `HARD_LIMITS` does not need a boolean value. `npm --workspace @narumitw/pi-image-drop run typecheck` passed, the settings tests passed in the root test run, and the existing defaults expectation was updated.
- [x] Add failing lifecycle tests to `extensions/pi-image-drop/test/lifecycle.test.ts`: `false` does not start the server; `true` starts it during `session_start` and displays a usable link; a later `/image-drop` reuses the server and rotates the token; startup failure only notifies; and session replacement/shutdown close stale servers. Before implementation, `npm test` produced the two expected failures (`serverStarts` was `0` instead of `1`); after implementation, the full root suite passed.
- [x] Refactor `extensions/pi-image-drop/src/runtime.ts` so automatic startup and `/image-drop` share one path for ensuring the server, issuing a link, updating the widget, and notifying the user, while preserving concurrent startup and generation guards. Lifecycle tests verify server reuse, replacement cleanup, shutdown cleanup, and startup error isolation.
- [x] Update the settings example, field table, and workflow in `extensions/pi-image-drop/README.md`, clearly stating that `startOnSessionStart: true` only starts the service and displays a link; it does not open a browser. Documentation review confirmed that both the lazy default and opt-in workflow are documented.
- [x] Run `npm --workspace @narumitw/pi-image-drop run check`, root `npm test`, `npm run check`, and `just pack image-drop`: all 678 tests passed, and the package contained the expected 15 files. Non-interactive Pi smoke tests using isolated `PI_CODING_AGENT_DIR` directories and both `true` and `false` settings exited successfully.

## Risks

- `session_start` can overlap with a fast reload or session replacement. If the generation is not checked again after awaited operations, the old session's server or link could remain active.
- The automatically issued bootstrap token is rotated when the user later runs `/image-drop`; the widget and notification must display only the latest link.
- Mixing the boolean field directly into the existing numeric limits type could break settings comparisons and warning logic.

## Completion Checklist

- [x] `startOnSessionStart` defaults to `false`, and its `true`, `false`, and invalid-value behavior is verified by passing `extensions/pi-image-drop/test/settings.test.ts` tests.
- [x] When enabled, each session starts only one loopback server and displays a link; when disabled, startup remains lazy, as verified by passing lifecycle tests.
- [x] Automatic startup errors, reload/session replacement, and shutdown do not leak listeners or stale UI, as verified by lifecycle race and cleanup tests.
- [x] The README documents the setting format, default, and “does not open a browser” behavior, as verified by documentation review.
- [x] The package check, root `npm run check` with 678 passing tests, `just pack image-drop` with 15 files, and non-interactive Pi smoke tests with both `true` and `false` settings all passed.
