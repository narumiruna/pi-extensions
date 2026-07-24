# Extension E2E Test Plan

## Goal

Add a reproducible E2E test suite with explicit timeouts and no real model credentials. Use the
repository-installed Pi CLI/RPC runtime to verify that every active extension loads and shuts down
correctly, and use `pi-goal` to verify a real prompt → model response → tool → persisted state flow.
This allows the existing latest-Pi CI compatibility check to catch runtime integration failures that
unit tests and mocked lifecycle tests cannot detect.

## Context

- `scripts/run-tests.mjs` currently compiles and runs only `*.test.ts`. It primarily covers unit and
  integration tests and does not start a real Pi CLI process.
- `.github/workflows/ci.yml` updates the Pi packages to latest and then runs only `npm run check`.
- `extensions/pi-goal/test/goal-runtime-smoke.mjs` already uses the Pi SDK, an in-memory session, and
  a faux provider for a deterministic runtime smoke test, but `npm run check` does not run the
  package's `test:runtime` script.
- The globally installed `pi` version may differ from the repository manifests. E2E tests must use
  `node_modules/.bin/pi` rather than relying on the global binary from `PATH`.
- Pi RPC uses strict JSONL framing. Records must be split only on LF, so Node's `readline` cannot be
  used.

## Architecture

- Add a separate `e2e/` TypeScript suite and `tsconfig.e2e.json`, emitting to
  `node_modules/.cache/pi-extensions-e2e` so the existing unit-test discovery does not include it.
- `e2e/support/pi-rpc-harness.ts` starts the repository-local Pi runtime, parses JSONL strictly,
  correlates response IDs, captures events and stderr, enforces timeouts, and cleans up process trees.
- Each scenario uses an isolated temporary workspace, `PI_CODING_AGENT_DIR`, and session directory,
  with offline and no-discovery flags enabled. Tests do not read the developer's settings,
  credentials, sessions, or project resources.
- `e2e/fixtures/control-extension.ts` provides test-only inspect and shutdown commands and writes a
  sentinel during `session_shutdown`, allowing tests to prove command routing and graceful lifecycle
  cleanup.
- The load smoke runs each active package in its own isolated Pi process and passes the package
  directory directly so Pi loads the production entrypoint from `package.json#pi.extensions`.
  Per-package isolation prevents extension state from leaking across tests and identifies failures
  precisely.
- A functional `pi-goal` scenario uses a test-only faux provider with fixed responses, sends `/goal`
  through RPC, waits for `agent_settled`, and verifies the `goal_complete` tool and completed state
  through message and session evidence. The existing deeper SDK runtime smoke is also included in the
  E2E runner.
- `npm run test:e2e` is the standalone entrypoint and is called by `npm run check`, preserving the
  existing CI-equivalent command without relying on a separate workflow gate that might not run.

## Non-Goals

- Do not call Anthropic, OpenAI, Google, or any other real external model or API.
- The first phase does not automate TUI, PTY, OAuth/browser login, or external services.
- The first phase does not add Playwright. Browser journeys for `pi-webui` and `pi-image-drop` can be
  planned separately after the CLI/RPC E2E suite is stable.
- Do not duplicate every command or tool edge case in E2E tests. Existing unit and integration tests
  remain responsible for detailed behavior.
- The first phase does not test npm registry publication. Boundary checks and `npm pack --dry-run`
  continue to verify package contents.

## Assumptions

- After `npm ci`, the repository-local Pi CLI and faux provider API are available.
- Isolated default settings for active extensions do not proactively require external credentials.
  Any optional server, watcher, or process must be closable through `session_shutdown`.
- Linux GitHub runners are the primary E2E platform, while process invocation and path handling should
  remain compatible with Windows `.cmd` binaries.

## Risks

- **Latest Pi API drift:** The test-only faux provider API may also change. Keep the provider fixture
  in one module and retain the CLI load smoke so faux-fixture failures can be distinguished from
  extension-loader failures.
- **Hanging child processes:** Give every request and scenario a deadline. On failure, attempt graceful
  shutdown first, then terminate the entire process group and print bounded stderr and event tails.
- **Shared environment contamination:** Do not modify the parent process's
  `PI_CODING_AGENT_DIR`. Pass environment changes only to children and clean temporary directories on
  success, failure, and cancellation paths.
- **Longer execution time:** Run package smokes with bounded concurrency and do not share sessions. If
  the complete `npm run check` becomes too slow, measure and isolate the slow path rather than removing
  lifecycle assertions.
- **False positives:** Process exit code 0 alone is insufficient. Every package must complete an RPC
  handshake, emit no `extension_error`, execute the control command, and write the shutdown sentinel.

## Plan

- [x] Record the pre-implementation active-package inventory and baselines for `npm test`,
  `npm --workspace @narumitw/pi-goal run test:runtime`, and `npm run check`. There were 20 active
  packages; the repository-local Pi CLI and package were both 0.80.10; the runtime smoke passed; and
  `npm test` and `npm run check` both passed 1,178 tests.
- [x] Add `tsconfig.e2e.json` and `scripts/run-e2e-tests.mjs` so only `e2e/**/*.test.ts` is compiled and
  run from a cache-local output directory. The no-input run exited nonzero; after adding a minimal Node
  test, the runner and runtime smoke both passed.
- [x] First add red contract tests in `e2e/pi-rpc-harness.test.ts` covering fragmented JSONL, CRLF input
  tolerance, `U+2028/U+2029` within strings, response-ID correlation, stderr capture, deadlines,
  unexpected exits, and child cleanup. The initial compile produced the expected red state because the
  harness module was missing.
- [x] Implement `e2e/support/pi-rpc-harness.ts` to resolve the repository-local CLI from the installed
  package manifest and provide an isolated child environment, strict LF JSONL, correlated requests,
  bounded diagnostics, deadlines, and graceful/forced process-group cleanup. Eight runner and harness
  tests passed, and the process audit found no remaining children.
- [x] Add `e2e/fixtures/control-extension.ts` and a fixture-focused test that emits a unique marker via
  an RPC command, requests graceful shutdown, and writes a sentinel during `session_shutdown`.
  Assertions for the isolated agent directory, credential stripping, repeated close, and forced-timeout
  cleanup all passed.
- [x] Add `e2e/extension-load.test.ts` with an explicit, recursive inventory of all 20 active packages.
  Load each production entrypoint from its package directory, complete the RPC handshake, reject load
  or extension errors, execute the control shutdown, and verify the sentinel. All 20 named package
  scenarios passed in the complete E2E run.
- [x] Add a centralized faux-provider fixture and `e2e/pi-goal-flow.test.ts`. Execute a fixed two-step
  `/goal` completion flow through the real Pi CLI/RPC runtime and verify `goal_complete`, settled state,
  an empty queue, the tool message, cleared persisted goal state, and graceful shutdown. The missing
  fixture first produced the expected load/provider error; the scenario now passes offline without
  credentials.
- [x] Include `extensions/pi-goal/test/goal-runtime-smoke.mjs` in `scripts/run-e2e-tests.mjs` without
  duplicating its deeper SDK scenarios. The normal smoke passed, and a temporary exit-23 smoke proved
  that the runner forwards nonzero status unchanged before the original file was restored.
- [x] Update the root `package.json` to add `test:e2e` after unit tests in `check`, and add `just e2e`.
  An actual `npm run check` executed and passed 32 E2E tests plus the goal runtime smoke.
- [x] Update `docs/extension-conventions.md` to distinguish unit/integration, SDK runtime, and CLI/RPC
  E2E coverage; require an active-package inventory and representative orchestration flow; and
  explicitly exclude TUI, browser, real-provider, and external-service coverage.
- [x] Run Biome write/check and the complete `npm run check` on the intended files, including boundary
  checks, 20 workspace typechecks, 1,178 unit/integration tests, 32 E2E tests, and the goal runtime
  smoke. `git diff --check` also passed. E2E took about 12.4 seconds, and no process or temporary
  directory remained after the isolated offline runs.
- [x] Install and verify Pi CLI/package 0.82.0 through the npm 11.16.0/latest-Pi flow, then rerun the
  complete `npm run check`; all 1,178 unit/integration and 32 E2E tests passed. The original CI install
  was still constrained by lockfile pins, so `--package-lock=false` was added before restoring the
  manifests, lockfile, and `node_modules` to 0.80.10.

## Completion Checklist

- [x] `npm run test:e2e` passes after a clean npm 11.16.0 install without model credentials, a browser,
  or external services.
- [x] All 20 active extensions pass an isolated real Pi CLI/RPC load, command handshake, and graceful
  shutdown. The explicit inventory verifies that each canonical entrypoint exists.
- [x] A `pi-goal` prompt-to-tool-to-state flow runs through a real Pi process, and the root E2E gate also
  runs the existing SDK runtime smoke.
- [x] Child processes and temporary agent, session, and workspace directories are cleaned on success,
  failure, and timeout paths. Bounded-diagnostics and process-group tests pass, and the final process
  and temporary-directory audit is empty.
- [x] The complete `npm run check` passes with both pinned Pi 0.80.10 and latest Pi 0.82.0, and the
  documentation accurately describes the non-goals.
- [x] The final diff contains only E2E infrastructure and tests, necessary scripts/configuration and CI
  fixes, and verification documentation. Extension product behavior, package versions, and the
  lockfile are unchanged.
