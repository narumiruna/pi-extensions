# BTW idle main-submission plan

## Outcome and scope

Release Pi's command wait after a BTW split workspace mounts, so the native main editor can start requests while BTW remains open.
Keep the complete workspace task owned by the session until cleanup finishes.
Initial menus and fullscreen-only workspaces remain modal.

This plan addresses [issue #1752](https://github.com/narumiruna/pi-extensions/issues/1752).
[PR #1753](https://github.com/narumiruna/pi-extensions/pull/1753) provides a related readiness-boundary proposal; it is not merged or modified by this work.
The implementation stays in `pi-btw` and adds no dependency, settings field, environment variable, Pi-core change, or Kit API.

Use the external implementation worktree on `narumi/fix/btw-idle-main-input` to preserve the original checkout's line-ending-only differences.
Do not change issue labels, close an issue, publish a package, create a version tag, or dispatch a release workflow.

## Reproduction evidence

The investigation used repository baseline `98807f61b2b3a9e67ebc494a8f7fb98ae27ae412` and the dependency versions declared by that baseline.
Node was the repository-pinned release.

The failure was reproduced in native Windows 11 ConPTY and WSL with an offline local provider:

1. Wait for an idle main session.
2. Run `/btw`, select **Start side thread**, and switch to **Main focus**.
3. Enter `ISSUE_1752_MAIN` and submit it.
4. Observe that Pi accepts the text into its idle queue but starts no provider request.
5. Close BTW with Ctrl+C and observe that the main request starts.

The direct `/btw <question>` route also reproduced the failure.
WSL tests covered both split placements and regular/fullscreen parents; its bundled CLI comparison reproduced the same behavior.
Native Windows tests used `dist/cli.js`, regular parent/right-pane, and a 140-by-40 ConPTY.
A streaming-start control completed a subsequent main request after `agent_settled`, before BTW closed.
These automated results do not prove physical-terminal, IME, clipboard, or visual acceptance.

The source confirms the wait chain: Pi's idle loop awaits `session.prompt()`, extension dispatch awaits the command handler, and BTW returns its full UI task.
A disposable focused assertion failed because the handler was still pending with the split open.
The unchanged baseline passed 719 BTW tests, the existing six-case terminal-handoff smoke, and the package-directory smoke.
Investigation setup and reproduction files were removed before approval.

## Approach

1. Add a package-internal split-readiness callback to `fullscreen-ui.ts`.
   - Invoke it once, after the first non-overlay split root mounts, receives focus, and requests rendering.
   - Do not invoke it for fullscreen-only roots, failed mounts, closed factories, or disposed/cancelled owners.
2. Separate command completion from workspace completion in `btw.ts`.
   - Race the command wait against split readiness.
   - Keep the full task in `BtwSessionLifetime`; do not replace it with an unmanaged background task.
   - Retain a session-lifetime command guard through final cleanup, including initial manager and startup work.
   - Propagate startup failures normally and report sanitized failures after command release.
   - Suppress stale notifications after session cancellation.
3. Add focused lifecycle and mount regressions.
4. Extend the local-provider PTY smoke for idle-start and streaming-start main submissions.
   - Use `agent_settled`, not `agent_end`, for final-idle synchronization.
   - Prove provider completion before closing BTW, rather than only checking rendered text or submission acceptance.
5. Update the package README, workflows, and core-alignment explanation, and add a package patch Changeset.

The native main editor, steering policy, input handling, context snapshots, model-visible prefix, settings storage, and physical terminal handoff remain unchanged.

## Touched areas and required verification

| Area | Applicable MUST rules | Named verification |
| --- | --- | --- |
| Command and lifecycle | Keep factories free of session work; retain and drain owned tasks; reject stale contexts; preserve command routes and non-TUI guards. | Lifecycle `Test`, asynchronous ownership `Review`, and workspace typecheck `Validator`. |
| Split mounting and teardown | Cancel owned work on disposal; preserve idempotent cleanup, nested hard cancel, input-drain boundaries, owned overlays, and first post-restoration input. | Mount and existing native-input `Test`, terminal `Smoke`, and handoff `Review`. |
| Settings durability | Preserve ordered writes, failure recovery, atomic publication, and the shutdown durability boundary. | Existing settings/lifecycle `Test` and read/write ordering `Review`; no settings implementation change is planned. |
| Documentation and release | Match implementation, retain warnings and required README sections, keep package entrypoints valid, and record the package patch. | Documentation and Changeset `Review`, heading/link audit, generated-entry `Test`, package load/pack `Smoke`, and repository `Validator`. |

Applicable guides are `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`, plus Pi's extension and TUI contracts.
A passing root check does not replace these semantic reviews.

## Acceptance criteria

- A main request completes while a split remains open when BTW starts from idle.
- Opening during a response preserves native steering and later idle submissions.
- Both split placements work with regular and fullscreen parents.
- Initial menus and fullscreen-only workspaces remain modal.
- A split releases its command only after successful mounting and focus assignment.
- Overlapping invocations cannot start another manager or workspace, including during startup.
- Pre-release and post-release failures remain observable without unhandled rejections or unsafe terminal controls.
- Cancellation, disposal, session replacement, reload, quit, and settings-write draining retain their existing ownership and cleanup guarantees.
- Existing input editing, paste, remapped bindings, bring-to-main, and unsupported-mode behavior remain intact.

## Verification sequence

1. Install dependencies with `npm install` in the implementation worktree.
2. Build Kit before consumer tests.
3. Add and run the new blocking regression against the unchanged implementation; record its expected failure.
4. Implement the fix and run focused lifecycle/mount tests, then all BTW tests.
5. Run the original PTY matrix and new idle/streaming submission routes with an isolated local provider.
6. Verify a representative patched native Windows ConPTY route and retain its exact runtime limits.
7. Run `npm run format`, `npm run check`, and `npm test`; do not race a Kit build with root checks or consumer tests.
8. Run the package build, Jiti/package-directory smokes, and `npm run package:pack -- btw`; inspect the tarball.
9. Review the full diff for asynchronous ownership, stale continuations, settings durability, input/terminal behavior, command modes, and documentation accuracy.
10. Stage only intended paths, inspect the index, commit a nonempty Conventional Commit, push the branch, and open a pull request with evidence and limits.

## Risks and limits

Releasing too early could leave the main loop running before split ownership is established.
Releasing the command could hide later errors or let a second invocation overlap the retained workspace.
Session replacement can invalidate delayed callbacks, so tests must cover late completion and shutdown draining.
These risks are addressed by the readiness boundary, full-task ownership, command guard, and lifecycle regressions.
No live-provider entitlement or physical-terminal claim is required for the deterministic local-provider proof.

## Verification record

- The four manager/direct and left/right command-readiness regressions failed against the unchanged implementation, then passed with the fix.
- The new PTY manager acceptance route failed against an isolated baseline because the main provider could not complete while BTW remained open.
- All 751 BTW tests passed across 25 files, including 32 added lifecycle/mount regressions.
- `npm run format` and `npm run check` passed; the existing informational `pi-sync` lint diagnostic remains unchanged.
- The unfiltered `npm test` run completed with 16,368 passed, one failed, and 15 skipped tests across 810 files, with no unhandled errors.
  - The failure is `packages/pi-starship/test/settings-chat-ui.test.ts`, `stop key respects preserve delete`, at line 1095.
  - The same focused test fails in the unchanged baseline snapshot; no Starship file was changed.
  - This unrelated failure is retained and must be disclosed rather than hidden by a passing narrower run.
- The Unix PTY combined matrix passed all 22 cases, including native active-run steering, both split placements, manager/direct openings, and regular/fullscreen parents; the separate original matrix passed all six cases.
- Native Windows ConPTY passed six cases through the published bundled CLI: regular/fullscreen parents with idle manager, idle direct, and gated-streaming openings.
  - Each main prompt completed and reached public `agent_settled` before BTW closed; restored input and normal shutdown also passed.
  - The fixture recorded 20 provider completions, 14 settlements, six clean shutdowns, and no provider errors, with no side-question contamination.
  - Coverage was right-pane at 140-by-40 with default F6; physical-terminal, IME, clipboard, and visual acceptance remain unverified.
- The package-directory RPC smoke passed; generated-entry/lazy-boundary tests passed as part of the BTW suite.
- `npm run package:pack -- btw` and a real local pack passed; inspection found the declared runtime, source, documentation, license, and manifest in the 29-file tarball, with no tests or repository-only plan.
- The fenced-code-aware heading audit passed for all 37 package READMEs, and all 19 relative links in the touched BTW documentation exist.
- Independent source review found no blocker and enumerated the actual Pi idle, streaming, follow-up, compaction, built-in-command, and extension-dispatch branches.
  - Its two coverage suggestions were addressed with notification-failure and released-session-generation regressions.
- The CI-selected root/workspace test gate passed with `PI_EXTENSIONS_TEST_BASE=98807f61b2b3a9e67ebc494a8f7fb98ae27ae412 PI_EXTENSIONS_BUILD_READY=1 npm test`: 1,048 passed, one platform-skipped test, 53 passing files and one skipped file.
  - This is the same affected-test selection used by `ci.yml`; it does not replace or erase the unfiltered failure above.
- The staged pre-commit checks passed: Biome and affected workspace build/typecheck.

The semantic review covered command modes, lifetime ownership, stale continuations, one-time readiness, nested hard cancellation, terminal drain/restoration, settings-write durability, unchanged model-visible context, and documentation accuracy.
The existing private-layout and second-renderer deviations remain documented.
Native temporary setup was removed with no surviving owned processes; the original checkout was unchanged.

## What looks good

The implementation changes the confirmed wait boundary and preserves Pi's native submission pipeline and existing session-lifetime owner.
Regression negative controls and Windows/WSL local-provider smokes verify the requested behavior without external provider credentials.

## What looks bad

The existing private-layout and second-renderer compatibility limits remain; this fix does not provide a public workspace-composition API.

## Verdict

**Incomplete:** The BTW acceptance criteria and package checks pass, but the full repository test gate retains a reproduced, unchanged Starship failure.
The pull request must disclose this limitation and distinguish the CI-selected gate from the unfiltered test run; fixing Starship is outside this approved scope.
