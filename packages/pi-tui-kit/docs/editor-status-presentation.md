# Editor status presentation

[API reference](./api.md#-editor-status-widgets) · [README](../README.md)

The optional editor status helpers update one extension-owned widget without taking over Pi's layout, input, or terminal.
`EditorStatusWidget` remains the passive horizontal frame with its original API.
The owner supplies immutable display snapshots, safe text, summaries, priority, row budgets, and domain policy.

## Ownership and admission

| Helper | Real consumers | Shared responsibility |
| --- | --- | --- |
| `createEditorStatusPublisher` | Progress, Subagents, Herdr | Retain a visible component, replace its latest snapshot, request rendering, and clear its exact key. |
| `createEditorStatusView` | Progress, Subagents | Session-local manual modes and explicitly armed one-shot compaction. |
| `createEditorStatusCollection` | Progress, Subagents | Bounded authoritative replacement and independent item presentation. |

Herdr retains its authoritative topology reads, invalidation handling, retries, sorting, and five-item limit.
Progress retains its saved progress, model-context contract, and completion timer.
Subagents retains its runtime, active-job projection, subscriptions, and elapsed-time refresh.
No helper imports another extension, identifies extension-specific state, or owns a shared registry.

The approved collection scope is whole-snapshot `replace`.
Current Progress and Subagents sources do not provide two compatible incremental display-data boundaries; `upsert`, `push`, and `append` are deliberately absent.
Herdr subscription payloads are invalidations, not authoritative incremental updates.
Do not manufacture an incremental API by splitting a complete snapshot into item updates.

## Stable publication

Import `createEditorStatusPublisher` from `@narumitw/pi-tui-kit/editor-status-publisher`.
Pass `key`, `context`, `isCurrent`, and `render(snapshot, theme, width, rows)`.
The render callback returns complete terminal lines, including the standard `EditorStatusWidget` frame.

`publish(snapshot)` mounts once when visible.
Later immutable snapshots invalidate that component and request a Pi render rather than calling `setWidget()` again.
The callback receives the current public theme and terminal dimensions; do not retain already-styled lines across theme changes.
`publish(undefined)` hides the widget, and `dispose()` releases its owned mount idempotently.
Headless contexts acquire no UI resources; RPC receives plain string snapshots at 80 columns and 36 rows.
The owner may retain its existing TUI-only scope instead of enabling RPC.

This prevents ordinary updates from moving a widget after its siblings.
It does not reserve global positions: Pi inserts a hidden widget at the end when it is shown again.
The publisher cannot find, merge, or protect a widget owned by another extension using the same key.

Create a fresh publisher per owner lifetime, with `isCurrent` checking a session identity and generation or an equivalent owner token.
Dispose it while the owner is still current, before transferring ownership or invalidating its context.
Do not key ownership by `ctx.ui`, because headless sessions can share that object.
Host component disposal invalidates only its mount; an older component cannot clear a replacement.
Failed initialization clears the owned key and reports the original error.
The owner remains responsible for releasing listeners, timers, pending reads, and domain tasks.

## View state and explicit events

Import `createEditorStatusView` from `@narumitw/pi-tui-kit/editor-status-view`.
Supply `onChange()` to publish the current presentation and `canCompact()` to enforce the owner's disabled/attention policy.

Modes are `default`, `expanded`, `compact`, and `hidden`.
`default` follows the owner's existing display settings.
Explicit `setMode()` cancels the selected automatic trigger, so a later event cannot undo that manual choice.
`setPinned(true)` prevents automatic reduction; it does not override persistent disable settings or physical width/row limits.
Hidden views retain the owner's latest data.
The helper does not cancel jobs or edit saved state.

`setTrigger()` selects `manual`, `user-message`, or `settled-cycle` and arms against the current event position.
The selected automatic rule is consumed once after successful compaction, then becomes `manual`.
Pinning, hidden mode, an ineligible cycle, or a failed `canCompact()` check does not consume it.

Owners connect only the relevant public hooks:

| Owner call | Pi event | Meaning |
| --- | --- | --- |
| `agentStarted()` | `before_agent_start`, automatic `session_before_compact`, or `agent_start` | Begin a processing cycle if one is not already active; preparation and retry starts remain in the same cycle until settlement. |
| `userMessage()` | `message_start` filtered to role `user` | A user-role message has joined processing, including consumed queued or extension-generated messages. |
| `settled(eligible)` | `agent_settled` | Finish the cycle after automatic continuation stops; eligibility is owner policy. |

A settled-cycle rule excludes a cycle already active when it was armed.
Do not equate `!ctx.isIdle()` with an agent cycle: manual context compaction and tree navigation also make Pi busy, without a matching `agent_settled`.
Owners use public preparation/run hooks and automatic compaction reasons (`threshold` or `overflow`) as run evidence; a live `ctx.signal` can identify late attachment to a low-level run.
An earlier extension can hold preparation before an owner's hook runs, so a provisional busy exclusion must be cleared on positive idle or a manual-compaction/navigation hook.
Observe an idle `input` only to clear abandoned tracking, not to count accepted input.
An unfinished preparation closes as ineligible before the next preparation; its earlier automatic compaction remains in the same cycle.
Pi exposes no exact session-run query to extensions, so owners must not infer completion from a missing signal or a maintenance-success hook.
One limit remains: maintenance can end and a custom-triggered run can start without an idle observation reaching the owner. Its public state can match a run that was already preparing when the rule was armed.
The conservative busy exclusion preserves the current run, but can delay that future custom-triggered cycle by one settlement. A live high-level run query or an ordered cycle-identity API from Pi is needed to distinguish those cases without changing busy-time arming behavior.
An eligible future cycle must itself consume a user message after arming; user activity in an earlier excluded or failed cycle cannot expire the rule during a later autonomous cycle.
Queued inputs can share one cycle.
`agent_settled.aborted === false` is not evidence of success; inspect relevant owner outcomes if success is required.

`input` is not accepted-message evidence: it can be handled, rejected, transformed, or queued, and slash commands can bypass it.
Assistant message completion precedes tools, and `agent_end` can precede retries or further work.
The helper makes no physical-human-only, N-turn, first-text, or universal auto-hide claim.

Call `revision(value)` only when meaningful content changes.
It rearms the selected rule against the new event position; repaint, resize, theme changes, elapsed-time ticks, and identical snapshots must not supply new revisions.
`reset()` clears session-local choices and tracking; `dispose()` rejects later actions.
The owner defines and tests session start, tree-navigation, shutdown, and context-replacement reset behavior.

## Bounded item presentation

Import `createEditorStatusCollection` from `@narumitw/pi-tui-kit/editor-status-collection`.
Supply finite safe nonnegative `maxItems`, per-item `maxContentSize`, and `measure(value)` in documented owner-selected units.
`replace([{ id, value, revision }])` validates the entire input before replacing it.
Duplicate/empty IDs, oversized content, unsafe measurements, or capacity failures throw without partially changing the previous collection.
The aggregate measured sum must also remain a safe integer.
Values remain caller-owned immutable snapshots; this is not an arbitrary-data deep-clone service.

`snapshot()` returns visible entries in caller order with their `expanded` or `compact` mode.
`item(id)` returns a handle with `compact()`, `expand()`, and `remove()`.
These operations affect display only; the owner publishes after an actual change.
An owner can reconstruct the collection for an explicit reset of all item views.

Use raw stable identities, not sanitized labels or wrapped rows.
Progress identifies duplicate step text by raw text and occurrence without adding an ID to the model schema; Subagents uses job IDs.
Routine replacements preserve item modes and removed-item markers while that ID remains in authoritative input.
After absence followed by reuse, an ID has a new incarnation; old handles cannot change it.
A meaningful revision also invalidates previously obtained handles, while cosmetic refreshes with the same revision keep them valid.
A removed item stays hidden across refresh and does not silently reappear until absence/reuse or an explicit owner reset.
All markers are bounded by the current authoritative input, not accumulated as history.

The owner supplies a truthful summary and item priority.
Count the separator in a supplied total row budget, include omitted/hidden counts, and do not infer available space across other widgets.
When no visible entries remain, clear the widget rather than leaving only a separator.
Manual item removal never deletes a task or hides it from the owner's domain manager.

## Verification and handoff

Deterministic tests cover native regular/fullscreen publication, sibling order, mount/dispose counts, immutable snapshots, themes, narrow widths, RPC/headless behavior, stale owners, and failed initialization.
Pure view/collection tests cover event positions, retries, pin/manual precedence, bounded replacement, atomic failure, removed markers, and stale item handles.
Consumer tests cover existing menus, settings, authoritative state, completion retention, and selected event policies.
Strict external-consumer and eager-graph tests keep the original widget entry unchanged and each optional helper dependency-free at runtime.
Changesets fixtures verify that the Kit minor release raises each adopting consumer's generated dependency floor; exact-artifact publication guards remain required.

The implementation verification passed both repository gates: `npm run check` and separate `npm test` (797 files, 15,384 tests; the existing one-file/two-test skips remain).
These passing gates do not establish exact tracking across an unobserved maintenance/custom-run boundary; a separate native diagnostic reproduces the one-extra-cycle limit above.
The complete intended diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope against the extension, settings, README, Kit admission, and coordinated-release guides.
Failure-injection tests cover cleanup exceptions across all three consumers, joining source/menu/settings/runtime work, stale context getters, retrying failed publication cleanup, reentrant policy/measurement callbacks, and capacity bypass attempts.

| Text/render contract | Previous behavior | Verified result |
| --- | --- | --- |
| Update widget A while B remains visible | Delete/dispose/reinsert could order B before A. | Retained native regular/fullscreen component keeps A before B and preserves editor input. |
| Progress completion | Completion publication replaced its component. | The existing component changes to the two-row completion summary, then its owned dwell hides it. |
| Compact active jobs | Only detailed job rows were available. | Consumer summary retains active/running/queued and omitted counts within its row budget. |
| Removed item receives cosmetic updates | No independent presentation state. | The raw identity stays hidden until owner reset or absence/reuse; domain data remains available. |
| Cleanup throws during replacement/shutdown | Later invalidation or task release could be skipped. | Cleanup attempts complete, old generations become invalid, tasks are joined, and failures remain observable. |

`npm run package:pack -- <unscoped-name>` passed for Kit, Progress, Subagents, and Herdr.
`node test/editor-status-artifact-smoke.mjs` additionally packs the actual built artifacts, inspects files/exports/licenses, installs them offline outside the workspace with scripts disabled, and verifies isolated ESM/Jiti loading, lifecycle, lazy RPC menus, and provider-free widget behavior.
Its bounded child operation deadline starts after an IPC readiness handshake; package identities, SHA256 hashes, and packed file lists are retained in the temporary evidence directory printed by the script.
This does not publish packages or establish registry availability.

An interactive `pi -e` smoke is not run by the non-interactive coding harness.
Native mock-terminal tests and isolated installed-package Jiti/RPC smokes cover the executable paths without opening an interactive terminal or calling a live provider.
These are automated contracts, not physical-terminal acceptance.
The terminal operator must inspect regular/fullscreen behavior, concurrent widgets, short/narrow resize, themes, manual controls, queued work, typing/paste, and IME placement after passing builds and tests.
Expected results are stable positions during updates, truthful summaries, predictable compaction, and unchanged editor ownership.
Actual terminal appearance, physical input protocols, and IME placement remain unverified until that check; do not release a known correctness or safety defect.

Package publication, tags, registry availability, and release dispatch require separate maintainer authorization.
Publish and verify the exact Kit artifact before dependent publication; a local workspace, pack, or mock registry does not prove registry availability.
