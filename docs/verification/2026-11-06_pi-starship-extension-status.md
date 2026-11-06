# pi-starship individual extension status verification

## Outcome

Root `${extension_status.<raw-key>}` references place individual public statuses without changing producer keys or storage. `$extension_status` and its `$all` expansion exclude explicitly placed keys. Each expansion uses the existing module format, icons, per-key styles, and its own status limit.

The repository naming convention now uses dotted stable slots. The producer inventory found only bare aggregate keys; pi-lsp still publishes `lsp`, not per-language statuses. No producer or pi-statusline change is required.

## Verification evidence

| Check | Result |
| --- | --- |
| Root `npm install` | Passed without manifest or lockfile changes. |
| `npm run format` | Passed; formatting changes were limited to the intended tests. |
| `npm run check` on macOS and Linux | Passed: builds, Biome, boundaries, and all workspace typechecks. |
| All pi-starship tests on macOS | 67 files passed; 2,425 tests passed and one existing environment-dependent test skipped. Used the canonical temporary path, as the root runner does. |
| Full root `npm test` on Linux | Exit code 0; 911 files passed, one file skipped; 19,604 tests passed, 16 skipped, no failures or unhandled errors. No affected-test filter or per-test timeout override. |
| README and skill audits | Required headings preserved across 38 package READMEs; 56 local links resolved in the changed guidance. Both new TOML reference snippets validate without semantic warnings. |
| Generated runtime/Jiti tests | Passed: exact generated import paths, preserved lazy boundaries, new status references and empty-status updates, commands, startup, and shutdown. |
| `npm run package:pack -- starship` and temporary tarball inspection | Passed; 171 entries include the generated entrypoint, source reference helper, skill/references, changelog, license, and notices. |
| Source-package and extracted-tarball RPC smokes | Passed: command registration, valid reference settings, lazy Status/Help commands, idle state, and clean shutdown. No model request or interactive input. |
| `npm run changeset:status` | Lists only a minor pi-starship release for this feature. No package version was changed or published. |
| Complete diff review | No actionable findings from implementation, documentation, test, and independent read-only review. |

The Linux runner used the Node version from `.node-version` in a disposable `node:26.11.1-trixie-slim` container. It ran as the unprivileged `node` user, with `/bin/bash` as `SHELL`, Git 2.47.3, a short Linux temporary path, and Docker's init process to reap orphaned children. The source and tests were copied into the container filesystem, not tested through a macOS bind mount. SHA-256 checks confirmed that all 10 changed/new implementation and test files matched the successful runner byte-for-byte. The final full run wrote an explicit exit-code file; a prior attached run exceeded the tool call deadline and was not accepted as gate evidence.

## Semantic audit

- Correctness: full-format reference collection is independent of rendering order. Child references retain the remaining group through `$all`; an explicit aggregate excludes that aggregate from `$all`. Explicit repetitions remain repetitions.
- Limits and empty values: selection occurs before the per-expansion limit. Zero and disabled settings hide every expansion. Empty, self, control-only, prefix-only, and explicitly icon-suppressed emoji-only content cannot leave module decoration or consume the visible allowance.
- Security: complete raw keys retain their identity, including dots, colons, slashes, case, and prototype-like names. Matching uses safe Map/own-property access. Display values and configured display text are sanitized before transforms and layout; no shell or model execution was added.
- Lifecycle: every render reads the current public map. Tests cover additions, updates, clears, replacement, repeated disposal/shutdown, and non-TUI modes. No new process, timer, subscription, UI workflow, or model-visible hook was added.
- Compatibility: existing presets and ordinary aggregate output remain supported. Exact icon/style matching, longest colon wildcard, fallback, `none`, separators, palettes, and raw-key matching remain intact. Content that becomes empty after formatting is now omitted before limits and static decoration.
- Scope and settings: parser grammar, manifests, dependencies, settings writes, profiles, history, producer activity policies, and footer ownership are unchanged. No root wildcard, dot wildcard, per-status table, key normalization, or package alias was added. The bundled skill's standalone and hosted-preview publication protections remain intact.

The review used `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`, including their touched-area and verification checklists. No guide exception was needed for implementation behavior.

## Environment findings

The initial macOS full suite failed four tests in unchanged files: one Fleet Unix socket path-length check, two Edit Scope long-path rendering assertions, and one Edit Scope Unicode filename assertion on the macOS filesystem. The affected source, tests, and shared Kit have no diff from the base. These failures were not hidden, disabled, or fixed through unrelated code changes. The prepared Linux full suite passed, including those test classes.

Initial container attempts also identified missing shell configuration, root-user permission semantics, missing orphan reaping, and an older Git command mismatch. Preparing the runner resolved these conditions without modifying repository code. A focused check of the affected environment-sensitive classes passed 215 tests before the final full run.

Existing non-failing diagnostics remain: the Biome schema/CLI version information, a Pi Sync unnecessary-continue information diagnostic, and the Changesets warning about the unchanged Edit Scope/Kit dependency range. They are outside this feature's scope.

## External handoff and restrictions

- User terminal review is optional. With the built package and a saved test profile, inspect usage beside Provider/Model, sync on the final optional line, absent-status line collapse, and per-key colors at normal and narrow widths. Deterministic tests verify layout and width bounds, not the user's font metrics or subjective color readability. This is not an unmet coding-plan acceptance gate.
- The maintainer must obtain explicit publication approval before using the normal release workflow. Registry publication, mixed installed-version behavior, and physical-terminal appearance are not claimed as verified. No package publication, version tag, visibility change, or release workflow dispatch is authorized by this record.

For rollback after adoption, restore an earlier TOML/profile or remove new child references before returning to a package release that lacks them. No user document is rewritten automatically, and no producer key migration is required.
