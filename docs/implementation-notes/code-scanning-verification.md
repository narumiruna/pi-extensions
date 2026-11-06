# Code scanning verification

The changes address 22 CodeQL findings without changing published extension behavior. Fourteen findings have code fixes; eight findings were dismissed with source-based false-positive evidence.

## Findings and scope

| Alerts | Disposition | Evidence |
| --- | --- | --- |
| 29–41 | Test fixes | Full request equality or parsed URL components replace hostname regular expressions and partial URL checks; terminal tests check raw OSC/BEL removal and expected visible text. |
| 44 | Smoke-provider fix | HTTP errors use a fixed body; detailed diagnostics stay in local stderr. |
| 21–22 | False positives | The loopback servers use random opaque session cookies, HttpOnly/SameSite attributes, one-use bootstrap tokens, and timing-safe comparisons. These are not stored user passwords or application payloads. |
| 23 | False positive | A random process key and HMAC-SHA256 identify in-memory authentication caches; this is not a persisted password verifier. |
| 24–28 | False positives | `JSON.stringify` encodes primitive string literals in Node-only fixtures, not HTML script elements. |

The cookie review does not establish protection against hostile local services or public-network exposure. The HMAC review does not establish protection against process-memory compromise.

## Verification

PR [1820](https://github.com/narumiruna/pi-extensions/pull/1820) verifies source revision `7b576828`. Its JavaScript CodeQL analysis `2109313907` completed without errors and reported zero results. Its CI run `42158884424` passed checks and 18,246 affected tests, but did not run the full root inventory.

A separate Linux clone verified the same source revision with the Node version from `.node-version`, its own dependencies, a non-root user, and a read-only Git input. Git supported `sparse-checkout check-rules`. No source file changed during verification, and the owned container was removed after its successful exit.

| Check | Result |
| --- | --- |
| `npm run format` | Passed without changes. |
| `npm run check` | Passed builds, Biome, package boundaries, and workspace typechecks. |
| Focused tests across 15 files | 501 passed, one existing platform test skipped, zero failed. |
| Unfiltered `npm test` across 909 files | 19,465 passed, 16 existing platform tests skipped, zero failed, zero unhandled errors. |
| Root test inventory | All 40 files selected; 507 tests passed and one existing platform test skipped. |
| LSP package smoke | Diagnostics, preview, write, reload, shutdown, four server exits, and eight loopback provider requests passed. |
| LSP error-path probe | Fixed HTTP 500 body and separate detailed local diagnostics confirmed. |
| `git diff --exit-code` in the clone | Passed; no repository file changed. |

The full test runner explicitly reported that no affected-test base was provided. No failure was excluded or waived.

Initial Linux setup attempts exposed missing emitted test modules before direct execution, an unexported `SHELL` for inhibitor fixtures, and Git ownership checks after changing the clone owner. These prerequisites were corrected without repository changes.

A full run in the older image then passed 19,464 tests but failed one sparse-checkout test because its Git lacked `check-rules`. The passing full run used the newer cached image instead; no test was modified or skipped to remove that failure.

The LSP smoke verifies diagnostics, preview, write, reload, shutdown, and child-server exit with a loopback-only scripted provider. The error-path probe checks a fixed HTTP 500 body and separate detailed local diagnostics. Neither path uses a live provider.

## Semantic audit

The full diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope against `docs/extension-conventions.md` and the applicable Kit/LSP rules. The review traced request construction, terminal sanitization before rendering, Node fixture consumers, and smoke cleanup. An independent read-only review found no actionable defect.

No settings, metadata, runtime-loading, or published behavior changed. A Changeset, package pack smoke, and additional runtime-loading smoke are not applicable to those unchanged areas.

## macOS baseline results

The earlier full macOS run had 19,444 passing tests, 34 skipped tests, and four failures. All four reproduced at unchanged `ce8a19ce` in an external detached worktree:

- `test/background-timer-exit.test.ts`: the long temporary path exceeds Fleet's Unix socket path limit.
- `packages/pi-edit-scope/test/menu.test.ts`: two canonical-target assertions expect unwrapped text, but the long temporary paths wrap at the test width.
- `packages/pi-edit-scope/test/paths.test.ts`: the filesystem treats composed and decomposed Unicode filenames as equivalent, contrary to the test's rejection expectation.

Those unrelated tests were not changed. No macOS test exception is approved.

## Default-branch handoff

The maintainer owns merge and the following CodeQL run on `main`. After the verified patch is merged, confirm that alerts 29–41 and 44 close without new findings. The PR analysis does not establish that the default-branch dashboard is already clear; the 14 alerts remain open there until merge and re-analysis.

Do not report default-branch alert closure before that result. No merge, release, publication, or version tag is authorized by this verification work.
