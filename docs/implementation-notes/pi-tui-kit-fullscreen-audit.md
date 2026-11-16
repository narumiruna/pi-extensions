# Pi TUI Kit fullscreen compatibility audit

Historical audit: 2026-10-08. The baseline, decisions, and verification results below describe that change; later corrections are identified separately. Use the [current Kit API reference](../../packages/pi-tui-kit/docs/api.md#fullscreen-input-and-custom-ui-limits) for present limits.

The retained changes fix interaction cleanup races, stale error notifications, and zero-width review rendering. Overlay and viewport APIs are deferred; existing exports, consumer floors, domain ownership, and RPC adapters remain unchanged.

## Evidence baseline

The execution branch starts at `366c62e0` on `origin/main`. Root and Kit manifests and `package-lock.json` resolve Pi Coding Agent and Pi TUI to `1.1.0`; `npm ls` confirmed deduplication after `npm install`, with no manifest or lockfile changes. The Kit manifest identifies the existing published baseline as `0.65.3`. These are audit snapshots, not new minimum-support promises.

Research compared tagged Pi TUI exports at `v0.80.0`, `v0.84.0`, `v0.87.1`, and `v1.1.0`, plus the coding-agent changelog across the intervening releases. The relevant additions are constrained layouts, mouse routing, search, adaptive system themes, fullscreen as the default, tool-renderer context, and program-status reporting.

Authoritative installed implementations reviewed:

- `@earendil-works/pi-tui/dist/tui.js`: input-listener order, focus, visibility, release filtering, mouse target retargeting, and overlay ownership.
- `@earendil-works/pi-tui/dist/tui-alt-screen.js`: viewport input, normalized pointer routing, capture, scroll chaining, links, and transcript search.
- `@earendil-works/pi-tui/dist/keybindings.js`: effective default viewport actions and deliberate PageUp/PageDown shadowing.
- `@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`: replacement/overlay custom factory completion, editor restoration, and native dialog program status.
- `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`: the public custom UI and lifecycle surfaces.
- Pi `docs/tui.md`, `docs/themes.md`, `docs/extensions.md`, `docs/sdk.md`, and the checked SDK extension example.

Production changes do not import or inspect these implementation paths. Tests use public renderer APIs; the custom-dialog adapter is simulated and explicitly identified as such.

## Admission decisions

### Overlay API: defer

| Prospective consumer | Required contract | Decision |
| --- | --- | --- |
| `pi-btw/src/fullscreen-ui.ts` | Parent overlay plus specialized terminal handoff, side-thread focus, nested UI, and transcript state | A passthrough would not supply the full lifecycle contract; retain extension ownership |
| `pi-starship/src/command-preview.ts` | Bounded preview and actions, independent selection/document scrolling, distinct cancellation, and caller-owned preview state | Current replacement flow has no demonstrated overlay requirement |
| `pi-recall/src/menu.ts` | Scoped picker with initial query/selection, typed result, ownership signal, and RPC adaptation | Existing replacement flow does not establish a matching overlay lifecycle need |

At this baseline, there were not two compatible overlay consumers, and no exception was requested. This change added no overlay options or public testing API. Pi's custom overlay close path then used the top overlay rather than an extension-owned handle, so unrelated-overlay preservation remained an admission requirement. The focused-overlay test characterized public renderer behavior without promising nested custom-dialog safety.

The top-overlay close defect was subsequently fixed upstream: the installed host closes its own overlay handle. That historical defect is not a current admission blocker. Kit later added the separate [physical-terminal handoff resource](../../packages/pi-tui-kit/docs/fullscreen-handoff.md), shared by Starship and BTW, with a public testing harness. It does not add generic overlay options to `runCustomInteraction()` or replace document viewports.

### Document viewport adapter: no-go for this iteration

`pi-starship/src/command-configuration.ts` reviews text/code/diff documents with consumer-owned apply policy. `pi-recall/src/menu.ts` reviews saved content with distinct navigation and confirmation semantics. `pi-tool/src/tool-catalog.ts` supplies exact documents inside browse detail, which must restore catalog cursor and query state. The common requirements are exact whitespace and graphemes, cell-aligned search coordinates, document position after resize, Back/Close separation, regular-mode presentation, and deterministic RPC pagination.

Kit already supplies these contracts through `review.ts`, `browse.ts`, `document-formatting.ts`, and their tests. Calling `ScrollView.render(width)` directly produces an unbounded document; bounded viewport semantics require host layout participation. A public custom factory does not grant an isolated layout-root ownership contract. Replacing the session's root would expand scope and interfere with the transcript/dock. No missing consumer capability or measurable improvement was established, so no prototype or new public API is retained.

### Program status: upstream integration required

Native select/input/editor paths set and clear blocked program status; `showExtensionCustom()` does not. `ExtensionUIContext` has no program-status ownership setter. Kit does not emit OSC 7501, change Pi's reporter, or claim native-dialog equivalence. An upstream follow-up should request a public, interaction-scoped blocked-status contract with completion, failure, cancellation, and shutdown cleanup. No external issue was opened in this change.

## Routing branches and acceptance evidence

| Relevant branch/equivalence class | Behavior and evidence |
| --- | --- |
| Regular vs. fullscreen | Regular leaves mouse bytes unnormalized; fullscreen interprets mouse and viewport actions. `renderer-interaction.test.ts` drives both real renderers through `Terminal.start()` callbacks |
| Earlier input listeners | Fullscreen transcript search and default PageUp/PageDown/Ctrl+Home/Ctrl+End precede replacement components; plain Home/End reach the component. Explicit host page remaps make document paging available. Tests assert both reserved and reachable paths |
| Search focus vs. custom focus | Host search handles activation and its focused navigation/close before component input; Kit local search uses its own Input. Tests exercise host search open/close and local query/edit/resize |
| Focused overlay vs. replacement | Explicit overlay focus owns page keys; hide/show and `unfocus({ target })` transfer ownership. Tests retain the unrelated overlay after the Kit interaction finishes |
| Key aliases and terminal protocols | Hint cases cover alias equivalence, modifier order, invalid keys, hard-cancel exclusion, first usable fallback, legacy Tab collision, and extended-protocol distinction through earlier listeners. Existing `pi-selectors.test.ts` covers the broader legacy collision table |
| Release filtering | TuiBase drops releases unless the focused wrapper opts in; press/repeat/release reach an opted-in component. Existing questionnaire review tests cover editor-owned key cycles |
| Wheel | Handled component wheel events suppress transcript fallback; unhandled events chain to the primary scroll view. Tests use explicit one-line wheel settings and verify Alt's five-times multiplier. Source review also covers SGR/X10 parsing and accelerator/overscroll branches |
| Pointer capture and links | Capture retains drag/release ownership outside component bounds. An unhandled link press can reach the enclosing handler, but link activation suppresses the synthesized click. Tests verify actual normalized coordinates and URL activation |
| Remaining terminal branches | Focus reports and malformed mouse sequences are consumed; hidden overlays redirect focus; debug and terminal query replies precede component input. Source review records these host-owned branches; Kit neither changes nor reimplements them |
| Width, rows, and themes | Review tests cover zero/negative/non-finite widths, one/two-cell widths, wide graphemes, combining characters, row/width resize, dark/light callbacks, terminal-default colors, and cache rebuilding. Existing browse, review, document-search, and RPC tests retain cross-mode contracts |

## Retained lifecycle fixes

`runCustomInteraction()` now retains its creation promise after Pi has resolved `done()`. It waits for creation, disposes a late component once, and drains pending component work before returning. Accepted completion aborts the interaction signal immediately, including completion from inside a still-running factory. Factories and pending work must honor the signal; an uncooperative factory is not hidden behind a timeout.

Custom interaction and task error reporting now revalidate ownership before a rejected reporter falls back to a notification. Task execution also checks its interaction-owned signal, so user cancellation and external loader disposal suppress delayed fallback notifications. Review of all standalone reporters found the other reporters already guard owner state before fallback. Their existing await ordering is preserved.

Regression tests first reproduced early runner settlement, missed disposal after factory-time completion, and stale fallback notification. The new lifecycle tests cover replacement, shutdown, cancellation, late rejection, late completion, cleanup failure, and unsupported RPC/print/JSON modes. The existing error-routing matrix now requires stale notification suppression consistently and retains distinct task cancellation/stale outcomes.

Review rendering returns no rows for non-positive or non-finite width, invalidates its old mouse hit map, and floors positive widths. It does not mutate the raw document, query, or confirmation contract. No domain state, settings persistence, active tools, system prompt, or model-visible context changes.

## Verification and handoff

Completed verification:

- `npm run format` and `git diff --check` pass; no unrelated formatting changes are retained.
- `npm run check` passes builds, Biome, package boundaries, and every workspace typecheck. Initial new-test import/regex diagnostics were corrected before the final passing gate.
- Focused Kit suite: 45 test files and 799 tests pass, including the renderer input cases, Jiti smoke, package exports, RPC reviews, and lifecycle/error-routing matrix.
- `npm test`: 545 test files pass; 7,490 tests pass and one platform/filesystem-dependent test is skipped by the existing suite.
- `npm run package:pack -- tui-kit` passes. An additional actual npm tarball was extracted and inspected: 95 files, all 15 export pairs present, all 45 JavaScript modules' relative import targets present, no coding-agent runtime imports, and no source/test fixtures published.
- A fenced-code-aware heading audit passes for all 34 package READMEs; Kit title/badges and the new API-reference anchor are preserved.
- `npm run changeset:status` identifies only the intended Kit patch; manifests, lockfile, exports, API version, and consumer floors are unchanged.

The complete diff audit reviewed every new await and callback, early host completion, late factory success/rejection, exactly-once cleanup, stale notification suppression, original reporter await ordering, terminal-width guards, raw/display separation, supported and rejected modes, test cleanup, package graphs, and API admission. The internal error-reporting matrix is deliberately corrected for stale owners; no public types or current-owner payloads change. No settings, secrets, model-visible prefix, external service, or terminal ownership policy is introduced.

`npm install` reported five existing dependency-audit findings (three high and two critical). The dependency graph is unchanged; dependency remediation is outside this focused change, and no audit-fix command was run.

The representative smoke is `renderer-loader-smoke.test.ts`: Pi's `DefaultResourceLoader`/Jiti loads the actual existing extension fixture, then runs its selector command through real regular/fullscreen renderers and a scripted terminal. The smoke observes keyboard actions, notification output, focus restoration, and preserved main-editor drafts without an interactive shell or provider request.

Physical terminal emulators, platform clipboard backends, real terminal palette discovery, and live-provider behavior are not exercised. Callback-theme tests use real `Theme` values and the stable delegating callback model, not a terminal palette probe. The custom-dialog adapter is tested against reviewed Pi completion semantics, not a private `InteractiveMode` method. These limits do not add new support claims.

Applicable guides: `docs/extension-conventions.md`, `docs/readme-conventions.md`, and `packages/pi-tui-kit/AGENTS.md`. Settings guidance is not applicable because no extension-owned settings or persistence change. No publication, version tags, visibility changes, release dispatch, or consumer migration is included.
