# Pi core alignment and API handoff

[Back to README](../README.md#-limitations) · [Workflows](./workflows.md)

BTW keeps its side-thread policy separate from Pi's renderer and Kit's shared screens.
Local improvements do not remove the need for a public Pi workspace API.
The upstream Pi contracts below are proposals, not available Pi APIs. No external issue, core change, or publication is implied.

## Shared physical handoff extraction

The Kit `createFullscreenHandoff()` resource shares only terminal entry, native drain, stop/start, owned-overlay hiding, and restoration. BTW retains its multi-screen context adapter, private split-pane layout integration, input priority, paste handling, selection/copy, root cancellation, main-thread updates, bring-to-main, and queued settings writes.

The [retained shared matrix and verification record](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-tui-kit/docs/fullscreen-handoff.md) records two-consumer admission with Starship, lifecycle regressions, artifact and PTY smokes, dependency propagation, and exact-artifact release guards. Historical checks below do not replace the shared resource's evidence. The proposed Pi workspace-composition API remains necessary.

Pi's official [TUI guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md) advises against a second terminal renderer. BTW intentionally deviates: a second TUI instance exists, but only one renderer actively owns the shared terminal. Extracting the physical lifecycle into Kit does not make that deviation officially supported or remove private layout access from BTW.

## Evidence boundary

The alignment review uses Pi core source at commit `1402973a9` and the installed public runtime.
Dependency reconciliation found a valid graph without tracked manifest or lockfile changes.
Root and global installations were inspected separately: each reported Pi coding-agent, TUI, and AI `1.3.0`.
The workspace Kit reported `0.65.6`, while BTW resolved its own registry Kit `0.64.0`; its compatibility floor was not raised.
The separate personal Pi-managed npm root contained top-level Kit `0.59.0`, but its installed BTW resolved nested Kit `0.64.0`.
The global CLI root did not contain Kit or BTW; its version command reported Pi `1.3.0`.
These are review observations, not future version requirements. Use the manifests, lockfile, and `npm ls` to identify the current graph.
Separate Pi managed install roots need not deduplicate libraries.
The subprocess smoke uses the repository CLI, not the global CLI; matching version strings do not prove complete runtime-graph equivalence.

Deterministic terminal tests exercise Pi's native input pipeline with a simulated terminal.
Rendered test frames are structural evidence, not screenshots or acceptance on a physical terminal.
Neither a print/RPC package load nor an in-memory menu test proves terminal negotiation, clipboard integration, or IME placement.
Kit can filter hints for public native host bindings, but it cannot infer unrelated extension input listeners that Pi does not expose.

The later [native appearance reference](./native-appearance.md) records the appearance-only follow-up against the preserved `89b0502a` baseline.
Its native reference is an actual bounded CLI/PTY capture through public `TuiAltScreen.getScreenLines()`; its BTW frames use a simulated terminal with the same runtime and callback theme.
That follow-up moves the former header and pre-editor hints below the editor, so references to the existing header in the historical findings and frames below describe the earlier alignment change.
It does not replace the input, lifecycle, settings, queue, or bring-to-main evidence retained here.

## Finding dispositions

The final disposition records local corrections separately from retained behavior and external dependencies.

| Finding | Disposition | Evidence and remaining boundary |
| --- | --- | --- |
| F0 · dependency baseline | Reconciled; no dependency-floor change. | Root `npm install` produced a valid graph without tracked churn; `npm ls` resolved cleanly. Local and global Pi versions were checked separately. The reported nullable-usage failure did not recur in the baseline root test run (666 files, 11,167 tests). |
| F1 · clicked editor focus | Reproduced and corrected locally. | Native mouse dispatch focused the embedded `Editor` and bypassed its wrapper. `BtwComposer` keeps native mouse/cursor behavior but routes keyboard input through the logical owner before forwarding editor input. `transcript-pager-native.test.ts` covers clicked composer shortcuts, editing, paste, hard cancel, and search closure for idle and answering views. |
| F2 · input ownership and hints | Corrected locally; host dispatch remains authoritative. | The native viewport handles paging once; regular fallback matches injected actions instead of literal PageUp/PageDown. Native tests cover remapped/disabled paging and submit, host-owned copy collisions, aliases, modifier order, invalid keys, first usable fallback, and legacy/enhanced input equivalence. No hidden old Enter or paging shortcut is retained. |
| F3 · prompt navigation metadata | Restored at the native boundary only. | Native prompt-jump tests cover answered, error, pending, resized, and wrapped exchanges. Payload controls are escaped before native message rendering; forged transformer OSC markers are stripped. Only trusted message-component navigation prefixes reach native layout metadata; painted text, search, clipboard, and regular rendering do not expose them. |
| F4 · scrollbar and manual follow | Native auto scrollbars enabled; intentional manual-follow policy retained. | Native scrollbar tests verify thumb/timer cleanup and explicit return to latest content. Manual scroll position survives incoming output, resize, and temporary fits without silently restarting follow mode. No extra pagination row was added. |
| F5 · transcript and input dock | Cursor-first allocation and public Editor border status implemented. | The native/regular matrix covers widths 0, 1, 20, 40, 79, 80, 120 and heights 0, 1, 2, 3, 5, 10, 24, with expanded paste, multiline text, CJK, emoji, and theme invalidation. Editor measurement uses at least three columns to avoid native CJK recursion, then clips output/cursor to the actual width. Optional headers, queue preview, and hints yield before the active input row; answering status uses public `renderTopBorder()` and thinking-aware styling with text. |
| F6 · keyboard pane focus | Locally implemented through the existing shortcut store. | `switchPane` selects the first usable F6/F7/F8 fallback without displacing existing overrides or inherited thinking keys. `workspace-layout.test.ts` covers both placements, narrow collapse, overlays, paste, and key releases; `keybindings.test.ts` covers fallbacks and preserved overrides. Native `fullscreen-ui.test.ts` cases retain main-pane focus and the active viewport. Focus is textual in the existing header. |
| F7 · renderer parity | Public behavior aligned; effective-options inheritance remains limited. | `fullscreen-renderer.ts` uses native automatic wheel behavior, search-navigation hover styling, and sanitized clipboard error detail. `fullscreen-renderer.test.ts` checks wheel acceleration, search hover, and safe clipboard errors, alongside existing native copy tests. Private host wheel overrides and right-click clipboard paste cannot be inherited safely; no duplicate setting or guessed paste source was added. |
| F8 · Kit selector presentation | Proven presentation gaps corrected; native selector semantics retained. | `selector-presentation.test.ts` covers separate selected/current/default markers, wrapped selected descriptions, disabled reasons, empty-filter recovery, callback border roles, constrained focused-row retention, resize, and theme invalidation. `selector-host-boundary.test.ts` checks advertised keys through native host dispatch rather than component-only calls. |
| F9 · private layout and terminal ownership | Contained, not removed; public-core dependency remains open. | Parent layout and authoritative viewport are validated before split handoff; runtime primary-field mutability is checked before changes. Lifecycle ownership uses an explicit signal, not the active-run `ctx.signal`. New `fullscreen-ui.test.ts` cases cover missing/incompatible layouts, stale signals, cleanup failures, signal-ignoring work, captured stale UI writes, and quit without restart. `btw-lifecycle.test.ts` covers idle/new/reload/quit, actual pending menus/tree, delayed tasks, and durability; native fullscreen tests cover input drain. The private-access inventory and proposed replacement contract follow below. |
| F10 · Kit cross-mode interaction | Existing contracts retained; host-boundary hints and cancellation audited. | Native host-boundary tests exercise reserved-action fallback, local search, standalone versus pasted Space, Input editing, expanded Editor paste/newline/Backspace/remapped submit, and pending settings rollback before hard-close settlement in regular/fullscreen parents. RPC pagination, exact wrapping/sanitization, Back/Close, and callback draining remain Kit-owned. Kit does not emit terminal program status; application-owned blocked-status reporting remains a proposed core contract. |
| F11 · queue and bring-to-main | Existing policy and safeguards retained; timing and preview wording clarified. | The capability audit below names existing regression coverage. No new queue manager, reorder, automatic submission, thread persistence, preview editor, or permanent metadata row was added. |

## Rendered-frame evidence

The frame table summarizes assertions over rendered lines and native layout allocations.
The excerpts below also capture actual `TuiAltScreen.getScreenLines()` output from the base commit `3276ad35` and the changed source, with the same installed Pi runtime and simulated terminal.
ANSI controls and trailing padding are removed for this document; these are not physical-terminal screenshots or visual acceptance.

| Area | Before | Verified frame contract |
| --- | --- | --- |
| Transcript scrollbar | The side viewport omitted native scrollbars. | Native auto thumb appears during scrolling and releases its hide timer on disposal; manual follow does not restart after temporary fits. |
| Short or narrow dock | Header/footer reservations could remove the active input row. | The width/height matrix retains the active cursor row before optional content; width or height zero paints nothing, and each line fits the supplied width. |
| Working status | Loader and hints shared the footer. | Answering status is in the public Editor top border when a composer exists; the draft and cursor remain intact. |
| Split focus | Mouse-only transfer with no explicit pane label. | The existing header shows `BTW focus` or `Main focus` and a usable switch key, without adding a permanent row or changing the muted divider. |
| Kit selectors | Selected descriptions, unavailable reasons, and empty-filter guidance could disappear under clipping. | Presentation tests retain the selected row and recovery text, separate current/default markers from cursor selection, wrap descriptions where rows permit, and preserve themed rules at normal heights. |
| Queue and context safety | Queue controls and editable preview had been proposed without a capability audit. | The bounded queue remains ordered and says `Steering next`; scope/size, exact read-only preview, append recommendation, and second replace confirmation remain visible in their existing flows. The loaded main draft, not the preview, is editable. |

### Captured native frames

At 20 columns and one row, with the draft `中🙂 draft`, the base frame contains only the header:

```text
─ btw · side thread
```

The changed frame retains the input:

```text
中🙂 draft
```

At 40 columns and five rows, a six-line draft previously reserved the first two rows for identity and hints:

```text
─ btw · side thread ────────────────────
btw • Enter send • Ctrl+C exit
line4
line5
line6
```

The changed frame uses those rows for the draft; the native cursor remains on `line6`:

```text
line2
line3
line4
line5
line6
```

At 60 columns and ten rows, the base answering dock puts both working status and hints on the same line:

```text
Steering: Next question
 ⠋ Answering…                  • Enter steer • Ctrl+C cancel
────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────
```

The changed dock separates the muted action hints from the working Editor border without adding a row:

```text
Steering next: Next question
Enter queue next • Ctrl+C cancel
 ⠋ Answering…    ───────────────────────────────────────────

────────────────────────────────────────────────────────────
```

## Appearance-only follow-up

The current conversation order is transcript, pending questions, native-style editor, then at most two footer rows.
Identity, truthful side-model metadata, thinking level, textual pane focus, and reachable hints replace the former top header and pre-editor hint row.
`BtwComposer` remains the logical input adapter over public `Editor`; public native message components remain unchanged.
The [appearance reference](./native-appearance.md#public-reuse-boundary) records exact public exports and the local working-border fallback.
No private renderer setting, main-session usage statistic, fake session, new dependency, tool, or streaming capability was added for appearance.
The private workspace dependencies listed below remain unchanged.

## F11: Existing queue and bring-to-main behavior

No queue manager, reordering control, automatic submission, persistent thread store, or new command is needed for this alignment.
For F11 acceptance, preview means the existing exact, read-only review; editability applies to the draft loaded into the main editor, not a new preview editor.
The existing capabilities and safety boundaries remain authoritative; the queue preview now says `Steering next` to make its timing clear:

| Capability | Existing evidence | Disposition |
| --- | --- | --- |
| Ordered side questions | `side-thread.test.ts`: "side-thread steering drains queued questions one at a time before reopening the composer" and "side-thread steering continues after the active answer fails". | Retain FIFO execution after the current response. Each turn uses the thinking level effective when it starts. |
| Bounded queue preview | `side-thread.test.ts`: "answering steering rejects blank questions and bounds unsafe queue display". | Retain sanitized, width-bounded previews in order, with an omitted-item count. Clarify next-response timing without adding a permanent dashboard row. |
| Hard cancellation | `side-thread.test.ts`: "cancelling an active answer discards its side-thread steering queue". | Retain discard of active draft and queued questions, with completed exchanges resumable in memory. |
| Scope and size | `side-thread.test.ts`: "bring-to-main scope menu offers the approved choices and selects a question-to-end suffix" and "large bring-to-main scopes preview the exact draft and support Back". | Retain latest, suffix, exact range, and entire thread; show approximate size. |
| Exact source selection | `side-thread.test.ts`: "custom bring-to-main line ranges retain raw text and role boundaries in either direction", "custom text ranges pass their exact formatted draft through preview", and "exact text selection survives returning from preview". | Select raw source, not wrapped terminal rows; preserve selection when returning from preview. |
| Expanded drafts | `side-thread.test.ts`: "bring-to-main preserves expanded large-paste content in the composer draft"; `fullscreen-ui.test.ts`: "native terminal smoke: custom bring-to-main preserves an expanded pasted draft". | Use expanded editor text; never transfer large-paste markers as content. |
| Preview and cancellation | `side-thread.test.ts`: "adaptive bring-to-main preview confirms the exact draft and preserves editor changes", "cancelled bring-to-main selection restores the unsubmitted side-question draft", and "cancelled main-editor loading returns to the side composer with its draft". | Retain exact read-only preview for suffix/range/full scopes, Back, Close, and draft recovery; the loaded main draft remains editable. |
| Main-editor safety | `side-thread.test.ts`: "appending a bring-to-main draft is recommended and reports the concrete outcome", "replace requires destructive confirmation with Back selected first", "replace re-prompts instead of discarding an editor update made during confirmation", and "disposing a bring-to-main standard menu closes without writing through its obsolete context". | Retain explicit load/append/replace without submission or session mutation. Recheck current draft and ownership before writing. |
| Untrusted source | `side-thread.test.ts`: "bring-to-main drafts escape terminal controls and wrapper terminators". | Keep the deterministic discussion-context wrapper and escape payload controls. |

`Steering` is an established BTW label, not a claim of Pi queue equivalence.
Pi core steering can run after the current assistant turn's tool calls and before its next model call; core follow-up waits for the agent to finish.
BTW uses a separate question queue and completes the current side response before starting the next question.
It does not interrupt the active provider response or use the main session's steering/follow-up queue.
The workflow guide states this timing; renaming or adding queue controls requires a separate product decision.

## Retained BTW runtime deviation

The workaround stays in BTW; Kit has no private-layout adapter or extension-specific coordination branch.
Public native components still provide layout, editing, selection, search, and scrolling.
The missing contract is composition with the host workspace, not a replacement rendering engine.

| Runtime dependency | Owner and purpose | Removal condition |
| --- | --- | --- |
| Private host `layoutRoot` read | `fullscreen-ui.ts` obtains the native main layout for a split workspace. | A public live main-thread surface. |
| Private host `currentLayout.primaryScrollView` read | `fullscreen-ui.ts` uses the viewport from Pi's actual layout pass instead of guessing from component children. | A public active-viewport capability. |
| Private workspace `currentLayout.primaryScrollView` write | `fullscreen-renderer.ts` points native viewport actions and search at the active pane. | An owned public viewport-selection operation. |
| Runtime mutation of readonly `ScrollView.primary` | `workspace-layout.ts` temporarily selects pane ownership and restores the original values; incompatible property descriptors are rejected. | A public pane viewport router. |
| Shared terminal and second `TuiAltScreen` | `fullscreen-ui.ts` transfers input and rendering ownership for the temporary workspace. | A public scoped mount/restore operation with equivalent cancellation and input-drain guarantees. |

Split mounts reject missing or incompatible native parent layouts rather than attempting an unsafe partial composition.
This is containment, not full F9 resolution or a cross-version guarantee.

## Proposed extension-neutral Pi contract

Pi should own terminal protocols, renderer dispatch, main-session actions, and application program status.
A public composition contract should let any extension add a temporary workspace without accessing private layouts or starting a second terminal renderer.
Kit must not become a host-layout adapter, and these proposals must not depend on another extension being installed.

### Scoped workspace mounting and restoration

Pi should provide a capability-detected, versioned workspace operation that returns an owned handle.
The operation should compose extension content with a live native main-session view and preserve the existing editor, viewport, selection, overlays, and session identity.
It should support one-pane and split layouts, resize, a bounded divider ratio, and regular/fullscreen parents without exposing the host's layout tree.
The host should continue rendering main-agent updates while the extension pane has focus.

The mount must either complete or leave the original workspace unchanged.
Close, cancellation, disposal, session replacement, shutdown, and partial initialization must release owned resources exactly once.
Restoration must affect only the owned mount and preserve unrelated overlays.
If input draining fails or a component factory finishes after closure, Pi must still settle the owner and dispose the late component.
Terminal stop/start and redraw must not occur reentrantly inside input dispatch.
The first separately dispatched input after restoration must use the restored host pipeline; replay of bytes coalesced with the closing key is not required.

### Logical focus ownership

A wrapper should be able to own keyboard actions while its native `Editor` owns cursor placement, IME markers, and text editing.
Mouse focus on that editor must not silently bypass wrapper actions.
The contract should define focus after clicks, drag selection, link activation, search closure, nested-overlay closure, resize, and workspace restoration.
It must preserve ordinary editor key handling and bracketed paste.
A root hard-cancel action must remain reachable even when a nested overlay has focus, and consume its triggering input.

### Active viewport selection

A workspace should choose the keyboard/search viewport through its owned handle, not by mutating a `ScrollView` field or the host layout.
Mouse-wheel routing should target the pane under the pointer without changing keyboard focus.
Keyboard pane transfer must respect configured bindings, host listener priority, overlays, paste state, and key releases.
The host should expose which actions it consumes so a component does not advertise unreachable paging, prompt-jump, or search keys.
Transcript metadata should accept trusted message-navigation markers separately from untrusted rendered text.
Native selection, links, scrollbars, jump-to-latest, and manual-follow state must remain usable.

### Safe main-thread composition

Pi should expose a live main-thread surface that includes its native editor and actions without exporting private component trees or requiring copies of action handlers.
The surface must retain the current main session even when an extension uses an immutable snapshot of another branch as context.
It should expose an expanded draft snapshot with a revision or equivalent compare-and-update operation.
An explicit append/replace operation must detect intervening edits and stale sessions, preserve concurrent updates, and never submit automatically.
Confirmation and context-selection policy remain extension-owned; atomic editor ownership and mutation remain host-owned.

### Effective renderer options

Pi should expose the effective, validated renderer options needed by a workspace, including wheel policy, selection-copy policy, right-click behavior, search-navigation theme roles, and clipboard/open-link callbacks.
The appearance follow-up also needs public effective message/editor padding and editor/status theme capabilities; current fallback values match native defaults rather than private host overrides.
The contract should identify unavailable capabilities and define whether a workspace receives a snapshot or live updates.
It must report clipboard failures through a safe, mode-appropriate result without requiring direct terminal output or access to private settings.
Host paste must target the active editable surface, expand clipboard text through normal editor semantics, and do nothing to a read-only viewport.
Extension-specific preferences should remain separate from inherited host behavior.

### Application-owned blocked status

Pi, not Kit or BTW, should own terminal program-status signaling.
If Pi exposes a blocked/waiting state for an extension interaction, it should be scoped to an owned interaction and reset on settlement, cancellation, disposal, replacement, or shutdown.
Nested interactions and concurrent main-agent work must not leave a stale status or overwrite a different owner's state.
RPC and regular-mode behavior must be specified; lack of terminal support must remain safe.
Document-local search, exact wrapping, RPC pagination, and asynchronous settlement remain valid Kit responsibilities and are not replaced by host transcript search or status signaling.

### Minimal reproductions and acceptance cases

These steps define contract tests, not instructions to open a live provider or interactive terminal during automated verification.

1. Mount a wrapper containing an `Editor`, click the editor, then send a wrapper shortcut through `TuiAltScreen`. Check logical focus, editing, and IME markers; repeat after search and nested-overlay closure.
2. Remap or disable viewport and submit keys. Send input through native dispatch and compare consumed actions with displayed hints; repeat with aliases, legacy collisions, enhanced reporting, and bracketed paste.
3. Mount a live main view beside an extension pane. Switch focus by mouse and keyboard, resize below the split threshold, and scroll each pane. Confirm the main editor and active viewport remain correct.
4. Close under root or nested-overlay focus, with a pending input drain and a late asynchronous factory. Retain an unrelated overlay and send a new printable key and viewport key after restoration. Check single disposal and normal host routing.
5. Read a draft, change it concurrently, and request append or confirmed replace. Reject stale revisions and stale session owners without losing either draft or sending a prompt.
6. Use custom wheel/copy/paste/search options and injected clipboard failures. Check inherited values, safe diagnostics, and correct active-pane targeting without reading private settings.
7. Open, nest, cancel, and dispose a blocked interaction while main-agent work continues. Verify that only Pi emits terminal program status and all owned state clears.

The Pi core maintainer owns API design, implementation, tests, and publication after repository-owner approval.
A later authorized BTW migration must pass the existing native-dispatch and terminal-restoration regressions before removing the workaround.
No new Kit API or raised BTW dependency floor was required for that upstream API proposal. The separate shared physical-handoff extraction above must require the Kit release that first contains its API before dependent publication.

## Verification and remaining acceptance

From the repository root, build before loading the declared package directory:

```bash
npm --workspace @narumitw/pi-btw run build --if-present
node packages/pi-btw/test/package-directory-smoke.mjs
```

The standalone smoke invokes the installed repository CLI with `-e ./packages/pi-btw` in RPC mode, isolated agent/home directories, offline mode, and no discovered resources or tools.
An IPC readiness handshake precedes the 15-second operation deadline; the calling command must also bound process startup.
It checks generated-entry provenance, command registration, observable TUI-only rejection of both routes, an unchanged empty transcript, and orderly EOF shutdown.
It does not open a TUI or call a provider.
`core-alignment-smoke.test.ts` separately loads the package directory through Pi's Jiti loader and opens/closes the lazy Kit menu with an in-memory harness, preserving the main draft.
This adds a representative lazy boundary to the existing generated-import and registration tests without claiming a real terminal smoke.

Focused preparation verified the new Jiti menu smoke (1 test), 26 representative existing F11 tests, and the standalone package-directory RPC smoke.
The pager suite passed 22 native regressions. Kit passed 49 files and 907 tests, including 73 added regressions, plus build, typecheck, package-export/Jiti checks, and pack inspection.
Kit's [detailed selector and host-input audit](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-tui-kit/docs/core-alignment-audit.md) records already-correct selection policies, RPC behavior, and exact evidence.
The fenced-code-aware required-heading audit passed for all 36 package READMEs; BTW relative documentation links and the two new smoke files' Biome checks passed.
These focused results do not replace the final root gates.

Final serialized root verification passed: `npm run format`, `npm run check`, and `npm test` (673 files and 11,318 tests passed; one file and two tests skipped by existing platform/environment gates). The first full integration run exposed stale synchronous-factory and shutdown-registration fixtures; those were corrected. Independent review also found a Proxy signal-invariant defect and incomplete enhanced-key overlap handling; both were fixed and received regressions before the passing gates. The real registered command now exercises the real fullscreen context proxy, and native keyboard-transfer tests verify both pane placements and viewport ownership.

The BTW minor Changeset adds the concrete pane-switch action and the workspace fixes; the independent Kit patch Changeset corrects presentation and input hints without a new public API. BTW retains its published Kit floor. No package, tag, visibility change, release dispatch, or upstream issue was published.
Consumer tests must not race a Kit build or a root check.
Neither deterministic frames nor a passing package-directory load replaces manual visual acceptance.

The terminal operator must still inspect regular/fullscreen parents, all three layouts, non-default bindings, mouse selection/copy/links, Chinese IME cursor placement, narrow/short resize, and light/dark/system themes.
Legacy and enhanced keyboard terminals, operating-system clipboard behavior, browser launch, and subjective readability remain manual acceptance paths.
A safety failure blocks the affected release. Publication, external issue creation, and future core adoption each require separate authorization.
