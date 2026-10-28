# Consumer UI consolidation audit

This change adopts existing Kit APIs in Progress, Subagents, Sync, Notes, Ticker, and Usage. It adds no Kit runtime API. Extensions retain settings policy, persistence, session guards, and specialized UI.

## Registry evidence

On 2026-10-24, npm reported Kit `0.66.0` as the current published release. `npm pack @narumitw/pi-tui-kit@0.66.0` downloaded the exact registry artifact. Its integrity is `sha512-LIOHvYth8ntps6DGxSlkSkvWb4U2j2lk2oifyqHrqPxyB9sim5qSj+ZqVa0EAC5QJbIpvV4s1JDlGJS0imudog==`.

The inspected artifact contains `dist/index.js`, `dist/index.d.ts`, and the runtime and declaration modules for bounded frames, configured-key matching, secret input, and custom interactions. The root exports `renderBoundedFrameLayout`, `canonicalizeConfiguredKey`, `runSecretInput`, and `runCustomInteraction`. Sync's cursor correction is included. All six changed consumers require this verified release through their manifest floors. This is an artifact-verification snapshot, not a requirement to synchronize unrelated consumers.

Root `npm install` initially left a stale nested Notes installation. A workspace-scoped `npm install --workspace @narumitw/pi-notes` corrected it without manual node_modules changes. The subsequent `npm ls @narumitw/pi-tui-kit` passed. Only the six intended dependency floors and their obsolete nested lock entries changed.

## Preserved contracts

The review used `AGENTS.md`, Sync and Kit scoped instructions, `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`. Runtime inspection included the installed Pi `SettingsList` render, mouse, input, activation, and submenu branches, plus Kit's published layout, normalization, secret, and custom-interaction implementations.

| Decision class | Required behavior and ownership | Evidence |
| --- | --- | --- |
| Full frame / compact frame | Preserve both border-role rules when five screen rows fit; retain the focused native row first at smaller heights. Extension supplies its row reservation. | Progress framing and settings tests; Subagents settings UI dimension matrix. |
| Narrow / zero / invalid width | Normalize dimensions and clip the final frame. Native list rows render at a minimum of four cells so compact retention can identify their cursor before clipping. | Progress narrow mouse tests, Subagents dimension tests, and native `SettingsList.renderMainList()`. |
| Main list / submenu | Map only retained content rows to their original indexes. Progress retains its native numeric submenu, focus, draft validation, and paste state. | Progress item-limit and mouse tests. |
| Press / click / wheel / passive row | Keep native `SettingsList` selection and activation. Replace a stale native press before an unpaired click. Reject unmapped headers, rules, descriptions outside native item rows, and out-of-width input. Clear geometry on input, resize rendering, invalidation, and disposal. | Progress mouse matrix and Subagents settings UI tests. |
| Key syntax / input routing | Kit validates configured syntax; Notes retains its length bound, literal-plus rejection, lowercase protocol lookup, and historical modifier ordering. Ticker does not turn malformed modifiers into valid blockers. Actual matching, host ownership, legacy collisions, terminal-mode policy, and fallback remain local. | Notes delete-key tables and terminal-mode tests; Ticker remapped-navigation, editor-priority, paste, and malformed-blocker tests. |
| Secret submit / blank / controls | Sync maps only a submitted secret to its existing string result; optional blank remains empty, required blank retries, and controls cannot submit. Non-TUI paths never open plaintext input. Kit clears its draft and editing state on disposal. | Sync secret-input, secret-cursor, credentials, and backend setup tests. |
| Secret cancel / paste | Sync retains Ctrl+C root cancellation during unfinished paste through the public `ctx.ui.custom()` boundary. Its adapter aborts the interaction signal and delegates all other input, focus, mouse, and disposal to Kit. Key releases do not trigger cancellation. | Sync unfinished-paste hard-cancel tests and regular/fullscreen native-renderer cursor tests. |
| Save pending / failed / durable | Usage closes the visible UI on cancellation, aborts owned work, and drains its save queue before returning. A successful rename still invokes caller-owned `onApplied(id, uiClosed)` cleanup even after cancellation; the callback owns the session-generation guard. Failed publication leaves later queued saves usable. | Usage lifecycle tests with a controlled rename gate, handoff tests using real Pi replacement methods, and settings persistence tests. |
| Abort / replacement / disposal / shutdown | Kit owns interaction cancellation and cleanup. Extensions continue supplying owner signals and generation guards. Delayed work must not redraw disposed UI or publish into a replacement session. | Usage lifecycle and handoff tests; Progress publication tests; Subagents settings lifecycle tests; Sync secret disposal tests. |
| RPC / print / JSON | Keep existing manual-settings guidance or unsupported behavior; do not enter custom TUI or add protocol output. | Usage non-TUI tests, Progress RPC tests, and Sync non-TUI secret tests. |

No settings schema, path, permission, storage algorithm, prompt prefix, tool definition, or command route changes. Settings read/write review retains latest-document reads, invalid-file protection, unknown-field preservation, serialized writes, failure recovery, and temporary-file-plus-rename publication.

## Admission decisions

### No new SettingsList adapter

After replacing row tokens with `contentRows`, the remaining common code is a small frame call and native mouse dispatch. Progress owns a numeric submenu, focus forwarding, draft and paste state, and its complete native footer. Subagents has no submenu and removes the native footer before framing, using callback-themed values and an explicit hard-cancel hint. Save queues and rollback policies are not presentation primitives.

The existing bounded-frame API already provides the shared operation. Another public wrapper would mainly add options for these differences and would not remove a missing primitive. Do not add an adapter in this change.

### BTW normalization remains blocked

BTW imports its synchronous key normalizer from `settings.ts` in its eager runtime graph. The published canonicalizer is exported only from the Kit root, not a focused display-only subpath. Importing it there would evaluate the menu graph at startup and violate BTW's existing `forbiddenEagerExternals` builder contract. BTW also persists its historical modifier order and lowercase paging spelling and rejects literal plus, unlike the general helper.

Keep BTW's implementation and dependency floor unchanged. A follow-up can adopt a published focused key-syntax export with a compatibility adapter, or propose a separately reviewed loading change. Do not deep-import Kit internals, weaken the eager-graph tests, or require an unpublished API. This plan item remains incomplete, rather than claiming that the six compatible migrations complete BTW adoption.

### Other deferred candidates

Safe Input/Editor rendering lacks a proven second compatible consumer: Imagegen sanitizes displayed raw drafts while Progress rejects and hides unsafe drafts. Reorder, fullscreen handoff, tree/session pickers, transcript workflows, and commit-aware cancellation retain specialized contracts. Langfuse's plaintext RPC setup requires a separate compatibility decision before masked-input adoption.

## Verification

Final serial verification on 2026-10-24:

| Check | Result |
| --- | --- |
| Root installation and typechecks | `npm install`, workspace-scoped Notes install, `npm ls @narumitw/pi-tui-kit`, and `npm run typecheck` passed. |
| Focused regressions | Initial frame/secret/settings run: 43 files and 651 tests passed. Final Usage run: 48 files and 980 tests passed, including real Pi replacement methods, controlled rename/cancellation races, and stale-owner cancellation. Notes and Ticker syntax, legacy collisions, remaps, paste, and fallback tests passed in the full run. |
| Root gates | `npm run format`, `npm run check`, and `npm test` passed. Final test result: 772 files and 14,619 tests passed; one file and two tests skipped by existing gates; zero unhandled errors. |
| Package inspection | All six consumer `package:pack` workflows and actual tarball checks passed. File counts: Progress 16, Subagents 48, Sync 306, Notes 13, Ticker 18, Usage 53. Declared entrypoints, README/license, dependency floors, and relative runtime import targets were verified. Notes retains source-loader extension resolution; generated runtimes require exact emitted targets. Kit's documentation pack contains 106 files. |
| Published runtime comparison | Local built bounded-frame, key-matching, secret-input, and custom-interaction JavaScript and declaration files match the inspected registry artifact byte-for-byte. No Kit production runtime changes. |
| Pi package-directory smokes | All six packages passed `pi --offline --mode rpc --no-session --no-extensions -e <absolute-package-path>` with isolated agent directories: readiness response, idle state, command registration, and EOF shutdown. No agent/provider turn was started. |
| Jiti/lazy boundaries | Existing Progress, Subagents, Sync, Ticker, and Usage generated-entry tests and Notes source-loader tests passed in the full suite. Changed component behavior is covered separately by native-renderer and interaction tests. Physical interactive command smokes are impractical in this non-interactive harness. |
| Documentation and release intent | Fenced-code-aware required-heading audit passed for 37 package READMEs; changed local links and section scope were reviewed. Changeset status passed and lists six patch releases; its existing warnings about unrelated consumers' older compatible Kit ranges were not repaired by raising unrelated floors. `git diff --check` passed. |

Initial verification found synchronous Usage test drivers that could not await the newly shared custom factory; all affected settings drivers now await it. A later full run found that returning early for an invalidated owner could suppress hard cancellation. The input path now closes stale interactions instead, and a controlled stale-owner regression plus the full Usage and repository suites pass. The new queue tests use abort-cooperative stalled writes and separately gate a rename that wins cancellation; no test timeout was increased.

The complete-diff review checked correctness, terminal/secret security, async lifecycle, compatibility, regressions, and scope against the applicable guides. No new plaintext secret route, extension-to-extension dependency, storage writer, or model-visible context path was added. The stale-cancellation failure class was audited across all changed input paths: Sync cancels through its signal, Usage settles stale owners, frame consumers retain their existing owner guards, and key consumers retain local routing policy. BTW remains blocked rather than weakening its eager-graph or persisted-key contract.

## External handoff and release restrictions

**BTW prerequisite:** The Kit maintainer owns any future focused key-syntax export and its approved release. The prerequisite is a reviewed public contract and explicit release approval; the action is to publish through the established workflow and verify the exact artifact. Expected result: BTW can import syntax normalization without evaluating the menu graph. That adoption remains unverified and blocked; this change neither adds nor publishes the export. The six completed consumer migrations use an already-published artifact and do not depend on this follow-up.

**Physical terminal checks:** A maintainer or tester with the target terminal must check IME placement, hardware/fake cursor visibility, keyboard negotiation, mouse input, resize, and theme changes in regular and fullscreen modes after deterministic tests pass. Use only synthetic credentials. Expected result: native editing and focus remain correct with no secret disclosure. Scripted native-renderer captures do not establish physical-device or subjective acceptance. Preserve this limitation in release notes; any observed correctness or security failure must be resolved before release.

No package publication, visibility change, version tag, or release-workflow dispatch is authorized or performed by this work.
