# Native TUI alignment audits

Kit retains its cross-mode adapters. Native transcript search does not replace document-local search, exact document formatting, RPC pages, or asynchronous settlement. The selector audit below covers plan findings F8 and F10 and their F2 input-ownership dependency. [Shared helper alignment](#shared-helper-alignment) records the later cursor, frame, key syntax, and consumer-lifecycle work.

## Fullscreen handoff extraction

The [fullscreen handoff contract matrix](./fullscreen-handoff.md) is the retained admission and verification record for `createFullscreenHandoff()`. Starship's single-component chat and BTW's multi-screen workspace use the same physical lifecycle contract. The linked record names the extraction's tests, artifact checks, release guard, and remaining physical-terminal limits; historical checks below do not replace that evidence.

The resource does not move private host-layout access, input priorities, paste handling, cancellation outcomes, or domain state into Kit. Ordinary `runCustomInteraction()` behavior stays unchanged. Pi's advice against a second renderer remains applicable: the intentional deviation permits a second instance, not two active terminal owners. Same-batch consumer publication requires the production guard's exact Kit registry-artifact verification; dependency ordering alone does not meet that requirement.

## Corrections

| Proven gap | Correction | Regression evidence |
| --- | --- | --- |
| A compact searchable selector could retain only its query and drop the selected row or empty-result explanation. | Retain the selected row first. With no results, retain the empty-result explanation before the query. | `selector-presentation.test.ts`: choice and model-style matrices, empty filtered selectors. |
| Native `SelectList` omits descriptions when an inline column does not fit. Action and choice wrappers did not provide a fallback. | Wrap the selected description below the list when it is not fully displayed inline. Keep disabled reasons separate and inert. | `selector-presentation.test.ts`: action and choice descriptions at widths 20, 40, 41, 79, 80, and 120. |
| Model-style descriptions were truncated to one line. | Wrap the selected description and retain its rows after the selected row and query. | `selector-presentation.test.ts`: wrapped descriptions. |
| Empty-result text did not explain recovery. | Add “edit search” to filtered selector, choice, settings, and browse empty states. | Presentation tests and existing screen/browse tests. |
| Model/thinking selector rules used `borderMuted`, unlike the required editor-area frame. | Use the callback `border` role. | `selector-presentation.test.ts`: callback-theme invalidation with dark, light, and terminal-default palettes. |
| Some declarative screens rendered one cell at zero or invalid width. | Reject those dimensions at the shared screen boundary. | Choice width/height matrix and existing review dimension tests. |
| Remapped host keys could be advertised for component actions that never received them. Browse and live-choice paging hints also advertised default transcript-owned paging keys. | Filter component hints against public native host bindings. Keep host dispatch, editor bindings, and callback ownership unchanged. Apply the same filter to selector, menu, review, live-choice, secret-input, questionnaire, and task-loader hints. | `selector-host-boundary.test.ts`: every native host-action branch, matcher aliases, modifier order, legacy collision, usable fallback, regular/fullscreen adapters, and host-owned Space. |
| The native test fixture replaced its initial readiness promise when a lazy factory first opened a dialog. | Keep the first readiness promise until the first mount. | Native questionnaire tests now reach the actual Editor and finish without a timeout. |

The frame matrices cover widths 0, 1, 20, 40, 79, 80, and 120 and terminal heights 4, 5, 6, 8, 10, and 24 or 30. Normal-height frames keep both horizontal rules. At one content row, the selected item or empty-result explanation takes priority. Extra descriptions and hints cannot all remain visible at that size. Width clipping remains cell-bounded; it does not change raw identities or selection.

## Retained behavior

The audit found no reason to replace these contracts:

| Contract | Existing evidence, included in the focused package run |
| --- | --- |
| Cursor, current value, and saved default are separate states. Model/thinking rows use `→`, `✓`, and `· default`. A choice uses a cursor plus textual `✓ current`; `initialItemId` is not the current value. | `pi-selectors.test.ts`, `screen-components.test.ts`, and the new presentation matrices. |
| Model filtering selects the best match; clearing its query retains its cursor position. Thinking filtering preserves the selected value while it remains present, otherwise it selects the first result. | `pi-selectors.test.ts`; authoritative `createPiSelector()` filter branches. |
| Searchable choices and browse lists restore the prior raw ID after temporary filtering removes it, unless explicit navigation changes the selection. Browse Back from detail preserves query and selection. Settings filtering intentionally resets to the first result. | `searchable-choice.test.ts`, `browse-screen.test.ts`, `search-restoration.test.ts`, and `screen-components.test.ts`. |
| Disabled action, choice, setting, and multi-select rows remain explanatory and cannot activate. Settings use their description for an explanation; no new disabled-reason API was added. | `screen-components.test.ts`, including disabled reasons, long values, mouse activation, and inert actions. |
| Browse status is textual, selected descriptions remain available in detail, and detail views are read-only. Exact documents are not fuzzy-search metadata. | `browse-screen.test.ts`; unchanged browse layout and document source rules. |
| Standalone Space activates local document search or changes settings/multi-select state. Spaces inside pasted chunks remain text. | `document-search.test.ts`, `screen-components.test.ts`, and native document-search tests. |
| Back differs from Close. Search-close closes local search before later Back/Close; Ctrl+C closes the root interaction under ordinary host bindings. | `pi-selectors.test.ts`, `renderer-interaction.test.ts`, `selector-host-boundary.test.ts`, and lifecycle tests. |
| Input cursor editing and native Editor Backspace, newline, paste expansion, and remapped submission remain native. Custom editors retain their own editing semantics. | Native regular/fullscreen Editor and Input tests; `questionnaire-editor.test.ts`. |
| Settings saves serialize, reject safely, restore committed values, and drain before navigation or hard-close settlement. | `screen-components.test.ts`; native regular/fullscreen pending-settings rollback tests. |
| Owner abort, replacement, disposal, late factories, and pending callbacks settle and drain without retaining obsolete ownership. | `custom-interaction-lifecycle.test.ts`, `custom-interaction.test.ts`, `task.test.ts`, and questionnaire lifecycle tests. |
| RPC retains bounded source pages, raw identity, cancellation, and unsupported-mode results without opening terminal components. | `testing-rpc.test.ts`, `document-review.test.ts`, `browse-screen.test.ts`, `runtime.test.ts`, and selector unsupported-mode tests. |
| Exact text/code/diff wrapping and terminal sanitization remain document-owned. | `terminal-document.test.ts`, `terminal-text.test.ts`, `review-screen.test.ts`, and `document-search.test.ts`. |

## Native host boundary

The native tests use `test/fixtures/renderer-host.ts`, real `TuiAltScreen` and `TuiMainScreen`, a primary transcript `ScrollView`, and a replacement editor dock. Scripted bytes enter through the terminal's registered input callback, not directly through a component handler. Only the extension custom-dialog adapter and terminal device are simulated.

The audit inspected the installed native `handleViewportInput()` and `handleTerminalInput()` implementations. The decision classes are:

1. Focus reports and mouse sequences are handled by the renderer. Existing renderer tests cover wheel input, component mouse routing, drag capture, links, and regular-mode mouse behavior.
2. Native transcript search always has an earlier listener. Search-next, search-previous, and search-close are intercepted when the native search overlay has focus; the replacement component then does not own input.
3. A focused non-search overlay receives viewport input instead of the transcript. Kit does not transfer overlay ownership. Existing overlay tests retain that behavior.
4. Without that overlay focus, the transcript owns page, half-page, line, previous/next prompt, and top/bottom actions. Tests remap each of these actions and prove that the replacement handler receives no triggering bytes.
5. The public debug callback reserves its native debug key when present. Other extension-installed input listeners are not exposed by a public ownership API; Kit cannot infer them.
6. Remaining input reaches the focused component. Pi filters key-release events unless that component opts in.

Hint filtering uses public `getKeybindings()`, `tui.mode`, terminal-protocol capability, and Kit's matcher-overlap logic. Alias, modifier-order, legacy collision, and disambiguated-protocol tests remain in place. It does not deep-import renderer internals or change the host's configured actions. It conservatively omits transcript-owned keys for replacement screens, even when another overlay could temporarily receive those keys.

`native-key-overlap.test.ts` adds native regressions for malformed host bindings, literal `+`, Kitty physical/logical shifted symbols, modifyOtherKeys, and printable base-layout alternatives. Invalid modifier syntax is rejected without repairing it into another key. Protocol probes use Pi's public matcher in both directions; they do not invent functional-key layout alternatives. Native authoritative Latin/symbol identities and the first usable fallback remain tested.

Default PageUp/PageDown continue to scroll the fullscreen transcript. Regular mode leaves them available to Kit documents. Non-conflicting host remaps make document paging reachable in fullscreen. Standalone Space retains independent local document search unless a standard component action or an earlier host action owns it. A native search overlay is not a search of the Kit document.

Kit emits no application-owned OSC program-status codes and does not claim native blocked-status reporting for custom screens. The selector and host-input corrections above add no public API, setting, persistence schema, coding-agent runtime import, or extension-specific branch.

## Verification record

The focused run used installed `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` runtime manifests reporting 1.3.0. This is a verification snapshot, not a compatibility floor.

Completed commands from the repository root:

```sh
npm --workspace @narumitw/pi-tui-kit run build
npm --workspace @narumitw/pi-tui-kit run typecheck
node node_modules/vitest/vitest.mjs run packages/pi-tui-kit/test
npm run package:pack -- tui-kit
```

The final focused package run passed **49 files and 907 tests**, including 73 added regressions. It includes package-export and representative Jiti fixture smokes. The Vitest configuration loads emitted JavaScript; final test emission passed. The Kit package typecheck also passed separately.

The package Biome check passed for 107 files, `git diff --check` passed, and the fenced-code-aware README heading audit passed for 36 packages. The pack dry run passed. Its 100-file inventory contains built JavaScript and declarations, README, license, manifest, and the three package-owned documents; it excludes source and tests.

The final semantic review applies `AGENTS.md`, the Kit guidelines, `docs/extension-conventions.md`, `docs/extension-settings.md`, `docs/readme-conventions.md`, and Pi's TUI, extension, theme, and RPC UI contracts. No settings persistence path or asynchronous production task changed. The audit checks rendering bounds, callback theme roles, focus propagation, cancellation, stale ownership, callback draining, public imports, and API admission separately from build success.

Final serialized root verification passed: `npm run format`, `npm run check`, and `npm test` (**673 files and 11,318 tests passed; one file and two tests skipped by existing platform/environment gates**). Initial integration fixture and Proxy-signal failures were corrected before the passing run. The registered BTW command now has a real fullscreen-proxy regression, not only separate mocked boundary tests. Physical terminal negotiation, IME placement, clipboard/browser integration, and subjective visual acceptance remain unverified; simulated native frames do not establish cross-terminal acceptance.

## Shared helper alignment

### API admission and native boundaries

| Operation | Consumer evidence | Decision and ownership |
| --- | --- | --- |
| Configured-key canonicalization | BTW shortcut settings and Notes picker key validation both require native key syntax; Kit has an existing canonicalizer. | Export only `canonicalizeConfiguredKey()`. Normalize aliases, case, modifier order, and literal `+`; retain caller-owned action policy. |
| Protocol overlap | Kit replacement screens, BTW's dedicated workspace, and Notes' picker use different terminal and listener boundaries. Native matching can also accept synthetic functional-key alternate fields that a terminal should not produce. | Defer a public overlap API. A context-free boolean would confuse arbitrary matcher acceptance with terminal reachability. Keep existing private host-hint policy unchanged. |
| Global availability and fallback | Focused overlays, native transcript search, editor actions, and earlier extension listeners change dispatch order. | Defer. Callers retain blockers, fallback selection, hard cancellation, and paste exclusions. Canonical equality proves none of these. |
| Frame row mapping | Progress and Subagents native settings wrappers recover clipped content rows through tokens. | Export the already shared layout result and explicit row types, without new clipping, native item identity, input ownership, or terminal reservations. |
| Paste parser | Pi's `ProcessTerminal` owns `StdinBuffer`; native `Input` and `Editor` buffer paste. | Defer. Do not add another terminal decoder. |

Native `getConflicts()` checks exact duplicate user strings rather than semantic overlap. Native `parseKey()` decodes event bytes rather than configured identifiers. Neither substitutes for the admitted syntax helper. Raw Ctrl aliases can remain accepted even with Kitty enabled; enhanced mode alone is not proof of disjoint input.

The secret-input correction uses public `renderFakeCursor()` immediately after the conditional `CURSOR_MARKER`. Raw inverse-video escapes cannot be suppressed by the native hardware-cursor path. Both Kit and Sync retain their separate controls for now, including secret clearing and mode-specific behavior.

Progress and Subagents settings use already-published `runCustomInteraction()` only for outer ownership, cancellation, disposal, and pending-work draining. Native `SettingsList`, local save queues, revisions, rollback, and durable-save application remain extension-owned. Widget migrations use already-published `EditorStatusWidget` only for passive framing; body data, sanitization, caching, publication, timers, keys, and cleanup remain local. Invalid widths normalize rather than reaching native string-repeat or fractional-width behavior; oversized indivisible Tool glyphs are clipped to maintain width bounds.

The three build-backed widget consumers allow only the exact `@narumitw/pi-tui-kit/editor-status-widget` eager external. Root Kit imports, other subpaths, and their existing first-use implementations remain forbidden. Builder-contract tests reject descendants of the exception, and a built-package graph test limits the widget entry to the three display helpers and external Pi TUI primitives.

### Publication-dependent adoption

The maintainer owns publication through the established release workflow after explicit approval and passing verification. This work does not authorize publishing, tags, visibility changes, or release dispatch. New frame/key APIs must be registry-visible before consumer imports or minimum dependency ranges require them. Installation of the future release remains unverified until publication.

The [consumer consolidation audit](./ui-consolidation-audit.md) records adoption after exact registry-artifact verification: Progress/Subagents replace row tokens, Notes/Ticker share compatible syntax normalization, Sync adopts masked input with its local hard-cancel policy, and Usage adopts interaction ownership. Native controls, collision checking, settings persistence, and session policy remain consumer-owned.

BTW adoption remains blocked because the published key helper has no focused export for its eager settings graph. Langfuse adoption still requires an explicit compatibility decision for its plaintext RPC flow: Kit's masked input is TUI-only and returns `unsupported` elsewhere. Required values, blank-to-keep semantics, validation, setup, and credential storage remain local.

### Physical terminal handoff

A maintainer or tester with the target terminal must verify IME placement, hardware-cursor visibility, mouse/trackpad behavior, resize, theme changes, and keyboard negotiation in regular and fullscreen modes after the deterministic tests and local build pass. Native-renderer captures and scripted bytes are preparation evidence, not physical-device or subjective visual acceptance. Do not claim cross-terminal verification without those results. Deterministic correctness failures still block the implementation; no provider login, real secret entry, or external service is needed for this handoff.

In a repository checkout, build Kit, start Pi with `--offline --no-session --no-extensions --tui-mode regular -e ./packages/pi-tui-kit/test/fixtures/interaction-smoke.ts`, and run `/kit-secret-smoke` with synthetic text only. Repeat with `--tui-mode fullscreen`, hardware cursor enabled and disabled, IME input, narrow resizing, and a theme change. Check that text stays masked, exactly one focused cursor is visible, cancellation restores the editor, and mouse or transcript controls retain native ownership. The fixture does not display or store the submitted value.

### Shared-helper verification record

The completed semantic review used `AGENTS.md`, the scoped package guides, the extension, settings, and README conventions, and installed native TUI implementations. Two independent read-only reviews covered security, lifecycle, compatibility, regressions, and scope. The public key result preserves native `pageUp`/`pageDown` spelling; a private lowercase adapter preserves existing protocol lookup identities. No settings schema, storage algorithm, prompt prefix, model-visible tool contract, command route, authentication policy, or terminal ownership changed.

| Check | Result |
| --- | --- |
| Focused package and runtime-builder run | 137 files and 2,253 tests passed. |
| `npm run format`, `npm run check`, and `npm test` | Passed serially; final full suite: 686 files and 11,879 tests passed, with one file and two tests skipped by existing gates. Five unchanged informational Biome diagnostics remain outside this diff. |
| Dependency installation and resolution | Root `npm install`, `npm ls @narumitw/pi-tui-kit`, and workspace typechecks passed. Progress requires the already-published cleanup patch; Cache Hit Monitor declares the already-published widget dependency. Other consumer floors are unchanged. |
| Public exports and cold passive graph | Built JavaScript/declarations and a strict TypeScript consumer passed; passive widget graph contains only widget, rule, terminal-text, and external Pi TUI. |
| Package dry runs and actual tarball inspection | Seven packages passed; manifest entries, licenses, supported exports, declarations, and exact generated relative imports were checked. File counts: Kit 102, Sync 301, Progress 16, Subagents 48, Tool 12, Plan Mode 44, Cache Hit Monitor 6. |
| Non-interactive package smokes | All six changed extensions loaded through `pi --offline --mode rpc --no-session --no-extensions -e <package>` with isolated agent directories, a session-start handshake, idle state, command discovery, and EOF shutdown. Tool also opened and cancelled its lazy RPC catalog. No provider request was made. |
| Native lazy UI smokes | Generated-entry tests exercised Progress settings and item-limit input, Subagents menus/settings, Plan Mode UI, Sync setup, and the Kit renderer fixture through Pi's Jiti loader. |
| Documentation | Fenced-code-aware required-heading audit passed for 36 packages; local links and API examples were reviewed. |

Verification corrected an obsolete synchronous generated-UI test fixture, a stale nested npm dependency resolution, and the public paging-key spelling before the passing runs. The eager display-subpath exception is bounded by graph tests rather than disabling lazy-loading validation.

Synthetic native-renderer captures in both modes showed the same nine-cell masked row (`> •••••••••`). With focus, hardware cursor off retained the inverse cursor cell; hardware cursor on suppressed it. Neither output exposed fake-cursor APC markers or the payload. Reproduce the full focused/unfocused, clipping, theme, editing, and cleanup matrix with the two packages' `secret-cursor.test.ts` suites after rebuilding Kit and emitting tests. These captures do not establish physical IME or terminal negotiation acceptance.
