# Fullscreen terminal handoff

`createFullscreenHandoff()` transfers physical ownership of one terminal between a parent TUI and a child TUI. It is an explicit resource, not a screen framework. Starship's configuration chat and BTW's multi-screen workspace use the same contract. Ordinary Kit menus and `runCustomInteraction()` are unchanged.

## Boundaries and compatibility

Pi's official [TUI guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md) says not to create a second terminal renderer inside an extension. This opt-in resource supports an intentional deviation: a separate TUI instance exists, but only one renderer owns the shared terminal at a time. It is not an official Pi integration guarantee. Prefer Pi-owned `ctx.ui` controls and one TUI when they meet the complete lifecycle requirement.

Kit requires two compatible consumers before adding a public lifecycle API. Starship retains one chat component; BTW retains one child across screen transitions, nested overlays, fullscreen, and split-pane layouts. Both adapters use this resource without extension-specific Kit branches or reduced capabilities.

The resource imports only public `pi-tui` types and has no eager runtime dependency. It does not import the coding-agent runtime, inspect a consumer, compose layouts, decode paste, select action bindings, or create an agent. Input policy, domain state, cancellation outcomes, settings transactions, and reporting remain consumer-owned. BTW's private Pi layout adapter remains in BTW.

## Resource contract

```ts
import { createFullscreenHandoff } from "@narumitw/pi-tui-kit/fullscreen-handoff";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

interface FullscreenHandoffOptions {
  isCurrent?(): boolean;
  canRestoreParent?(): boolean;
}
interface FullscreenHandoff<T extends TUI> {
  enter(createChild: () => T): Promise<T | undefined>;
  restore(): Promise<void>;
  setOverlayHandle(handle: OverlayHandle): void;
}
```

Create one resource per physical handoff lifetime. Both predicates default to true. `isCurrent()` controls entry ownership; `canRestoreParent()` controls whether the physical parent may restart. A replaced flow can be stale while the shared parent terminal is still live. Shutdown must prevent restart. Neither predicate permits obsolete context or editor state to be reused.

`enter()` accepts a synchronous child factory. It defers physical transfer until the active input callback unwinds, awaits the native entry drain when available, rechecks ownership, stops the parent, and creates and starts the child. Repeated entry shares that operation. Cancelled or stale entry returns `undefined` after restoration. Initialization failures reject; cleanup failures remain observable. Consumers must not start the returned child again.

The factory owns any child it cannot return. If layout, focus, or component setup throws after allocation, cancel its work and stop the unreturned child before rethrowing. Native layout setup can schedule rendering before `start()`. Kit owns the child only after the factory returns it. Preserve setup and cleanup errors if both fail.

`restore()` cancels entry and joins its drain before teardown. It awaits the exit drain when required, stops the child, hides only the supplied owned overlay after physical transfer, and restarts and redraws a live parent. An entry drain can change keyboard protocols even when no child starts; restoration resets the live parent in that case. Repeated restoration shares one settlement, including rejection. Report restoration errors rather than treating them as successful cancellation.

`setOverlayHandle()` receives only the parent interaction's owned handle. A handle supplied after restoration starts is hidden immediately. Unrelated overlays remain untouched. Complete a `ctx.ui.custom()` interaction through its completion callback, not `OverlayHandle.hide()`.

Consumers synchronously cancel root work and consume hard-cancel input before awaiting restoration, including under nested overlay focus. They dispose components, release listeners and timers, abort and drain domain work, await queued writes, and join restoration on replacement and shutdown. The resource does not call a domain cancel callback or replay bytes. After restoration, the next separately dispatched input uses the parent's normal pipeline; bytes coalesced with the closing key have no replay guarantee.

Keep every distinct failure observable. Single failures retain their identity. Kit aggregates multiple physical failures and combined entry/restoration failures. Consumers must not replace these aggregates with an earlier local cleanup error or report successful completion after restoration fails.

## Retained contract matrix

The native harness drives actual Pi TUI dispatch, rather than calling components directly. `FullscreenTerminal`, `createFullscreenHarness()`, and `fullscreenMounted()` are exported only from `@narumitw/pi-tui-kit/testing`; both consumers use this shared test boundary.

| Area | Retained evidence |
| --- | --- |
| Single and multi-screen lifetimes | Starship `settings-chat-fullscreen.test.ts`; BTW `fullscreen-ui.test.ts` screen transitions, nested overlays, late factories, and single restoration. |
| Parent modes and layouts | Kit's `awaits entry and exit drains with a … parent`; BTW native regular/fullscreen × fullscreen/left-pane/right-pane matrix and six CLI/PTY cases; existing narrow-layout regressions. |
| Entry ordering | Kit native input-depth checks, missing drain, gated entry, cancellation/staleness before and after drain; BTW entry trace proves drain before stop/start at depth zero. |
| Entry cancellation and partial failure | Kit cancelled-drain/finally callback and keyboard-protocol recovery tests; both consumers cover disposal, replacement, shutdown, rejected entry, and failed creation. Starship's unreturned-child tests cover listener, component, layout getter, layout mount, and focus failures, including pending rendering and stop errors. |
| Exit and errors | Kit gated exit, drain/stop/overlay/start/render failures, repeated restore, and entry-plus-cleanup errors. BTW tests preserve mixed flow, local, component, and physical errors, aggregate identity, overlapping causes, and arbitrary thrown values. |
| Context versus terminal | Live session replacement restores a shared parent without stale UI/editor calls; dead-terminal and shutdown cases do not restart it. Starship's generated Jiti test and isolated artifact smoke join a gated real shutdown hook. |
| Owned overlays and cancellation | Both native adapters hard-cancel under nested focus. Kit preserves unrelated overlays after success, failure, and repeated restoration, including late owned-handle registration. |
| Input and paste | Consumer native key suites cover default/remapped bindings, release events, complete/fragmented paste, editor/search focus, selection/copy, and viewport priority. BTW PTY cases use an explicit native search binding to avoid platform-default differences. |
| Restored input | Both native adapters test the first separate parent input and viewport routing. Starship and BTW PTY smokes wait for the public parent-start handshake before separate input. |
| Domain and persistence | Complete Starship and BTW regressions retain preview authorization, draft-only tools, anchors, review/name cancellation, confirmation, conflicts, queued writes, main updates, imports, and bring-to-main behavior. No persistence or prompt policy moved into Kit. |
| Ordinary Kit behavior | Existing custom-interaction, menu, lifecycle, and RPC suites remain unchanged; the root test gate covers them separately from opt-in handoff tests. |
| Runtime and declarations | `package-exports.test.ts` verifies root/focused identity, strict external usage, async-factory rejection, testing-only helpers, and a dependency-free focused graph. The isolated tarball smoke loads both consumer package directories and their lazy UI paths through Pi's Jiti loader. |

## Release-floor propagation

Read versions from manifests and the lockfile. A consumer floor must include the Kit release that first contains this API; workspace resolution alone does not prove that guarantee.

The Changeset requests Kit minor and both consumers patch. The repository's independent Changesets configuration raises both generated floors to that Kit API release without putting a nonexistent registry version into current manifests. `test/changesets-release.test.ts` runs the real version command against versions and ranges derived from all three real manifests. Its publish-plan fixtures prove dependency ordering.

The production packed-artifact guard validates every local hash, uses the installed native runtime graph, and verifies exact registry dependency artifacts before invoking native Changesets for dependent chunks. It preserves packed bytes, native authentication/provenance, and native `CHANGESETS_OUTPUT` events. Failed publication, missing artifacts, or integrity failures block dependents. Retry plans still verify dependencies omitted from the plan or represented as tag-only entries; those entries use registry SRI because they have no local packed hash. Cycles, private-root references, redirects, and unsafe packed-directory overrides fail closed. See [coordinated releases](https://github.com/narumiruna/pi-extensions/blob/main/docs/coordinated-releases.md) for the full contract and recovery limits.

`test/packed-publish-guard.test.ts` covers argument, dependency-graph, local-preflight, metadata, transport, and integrity failures. `test/packed-publish-native.test.ts` uses the real installed CLI, fail-closed npm/Git executable shims, and a local HTTP server. It proves native partial reports, blocked consumers, already-published handling, and successful retry without real publication or tags. The installed CLI reports through its existing `CHANGESETS_OUTPUT` environment API; forwarding a flag does not establish that the native CLI supports it.

These fixtures are not evidence that a future registry release is available. Production npm authentication, OIDC provenance, registry propagation, and real tag/release APIs remain unverified until a separately approved release. No publication, visibility change, tag, or workflow dispatch is authorized by these tests.

## Verification record

Implementation started from `8f97a8499ec034c7fa1195ce9714ecc3088bb035`. The commands below run from the repository root. Package identities and peer versions in the artifact fixture are read from manifests, not copied into guidance.

| Check | Result |
| --- | --- |
| Two-consumer admission | Same physical-only resource accepted by both real adapters; native mode/layout, transition, overlay, input, cancellation, and failure cases pass. |
| Focused regression gate | 2,394 tests passed before semantic review; follow-up tests cover the four review findings: unreturned child cleanup, mixed BTW cleanup errors, native-equivalent argument overrides, and workspace-path dependency edges. Final root gate includes these fixes. |
| `npm run check` | Passed; final rerun includes documentation and export-test updates. |
| Separate `npm test` | Passed: 14,952 tests, two existing skips, zero failures or unhandled errors across 780 files. The explicit testing-export inventory and focused runtime/declaration assertions include the new API and shared harness. |
| Package packs and final isolated artifact smoke | All three `npm run package:pack -- <name>` commands passed for `tui-kit`, `starship`, and `btw`. `node test/fullscreen-handoff-artifact-smoke.mjs` passed again after the complete build: actual tarballs, notices/files/exports, offline isolated installation and non-workspace resolution, strict NodeNext usage, both native parent modes, Jiti package directories, Starship status/menu/chat and gated shutdown, and BTW menu/shutdown. The script prints retained artifact identities and hashes. |
| Isolated type-check limit | Consumer expressions and negative async-factory tests are strict with no emit. `skipLibCheck: true` matches repository practice because installed upstream Pi declaration internals fail full library checking; this does not audit those upstream declarations. |
| Dependency resolution | Root `npm install` and workspace-targeted `npm install` removed a stale nested Kit copy. `npm ls @narumitw/pi-tui-kit` confirms both consumers use the workspace Kit; both typechecks pass. Version-propagation and exact-artifact fixtures provide the separate release proof. |
| Starship process/PTY | `uv run python packages/pi-starship/scripts/smoke-configuration-chat.py`: both parent modes passed native history, diff, page/wheel scrolling, cancellation, restored command, and shutdown. `uv run python packages/pi-starship/test/settings-chat-smoke.py`: both modes × discard/save/save-only passed deterministic tools, steering/follow-up, confirmation, parent isolation, and draft cleanup. No live provider call. |
| BTW process/PTY | `uv run python packages/pi-btw/test/fullscreen-handoff-smoke.py`: all six mode/layout cases passed answer, page/wheel scrolling, search, nested root cancellation, restored input/command, orderly shutdown, one local side request, unchanged parent messages, and unchanged settings bytes. |
| Startup comparison | Five fresh-process cold-Jiti package-directory samples after one warmup, using the same installed toolchain on Linux: Starship median 405.9 → 409.3 ms; BTW 390.5 → 388.1 ms. These are loader samples, not latency guarantees; no threshold is enforced. Generated eager-boundary tests also pass. |
| Semantic and guide audit | Lifecycle, stale continuations, resource ownership, error causes, input, unchanged domain/persistence/security/model contracts, native graph/parser/report semantics, packaging, and scope reviewed. Complete-diff audit passed after correcting all four review findings and adding exact-cause, timer, parser, graph, native-report, and retry regressions. |
| README headings and links | Existing emoji headings, badges, warnings, and scope retained. Fenced-code-aware heading and local-link audits pass; no required section or warning was removed. |
| Physical/platform acceptance | Unverified; use the operator matrix below. PTY and simulated native rendering do not establish physical IME or terminal compatibility. |

Applicable guidance is root and Kit `AGENTS.md`, repository extension, settings, README and coordinated-release conventions, Kit API/alignment guidance, and installed Pi TUI, extension, package, theme, and RPC contracts. This extraction adds no setting, command, permission, model-visible prefix transition, or extension-to-extension protocol. Private split-layout integration and the documented second-renderer deviation remain consumer-owned.

## Physical-terminal acceptance

The maintainer records the revision, operating system, terminal/protocol, input method, parent mode, BTW layout, and effective keybindings. Use non-sensitive drafts and deterministic model fixtures where possible. Test both parent modes and all BTW layouts with default and non-default bindings.

1. Enter and leave each consumer, including a BTW transition and nested overlay; confirm one active renderer and root Ctrl+C cancellation.
2. Test wheel scrolling, selection/copy, search, complete/fragmented paste, editor newlines, IME candidates, and hardware cursor on/off.
3. Resize to narrow/short dimensions and back, change themes, and check focus and cursor placement.
4. Cancel during entry/exit where the harness permits; exercise replacement, reload, and shutdown without stale UI or orphaned work.
5. After restoration, send separate printable and viewport input; confirm normal parent routing, preserved draft, and unrelated overlays.

Record expected versus observed results and skipped paths. The BTW PTY smoke does not establish parent draft/viewport preservation; native regression tests cover those routes. Physical IME, clipboard integration, trackpad behavior, terminal negotiation, Windows, and macOS remain operator checks. See the [Starship runtime handoff](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-starship/docs/configuration-chat-runtime.md#external-physical-terminal-handoff) and [BTW alignment handoff](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-btw/docs/core-alignment.md) for consumer-specific limits.
