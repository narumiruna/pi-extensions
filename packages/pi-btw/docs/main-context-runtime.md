# Manual main-context import: runtime audit

[Workflow](./workflows.md#import-main-updates)

Manual import reads finalized main-session entries and appends a quoted background message to the side conversation. It does not navigate the main tree, submit a main message, stop main work, execute tools, or call a provider at confirmation time.

## Authoritative runtime decisions

The installed Pi implementation is authoritative for the following decisions. Dependency versions come from the workspace manifests and lockfile.

| Runtime source | Relevant behavior | Import policy |
| --- | --- | --- |
| `pi-coding-agent/dist/core/agent-session.js`, `_handleAgentEvent()` | Extension and public `message_end` notifications run before `SessionManager.appendMessage()`. User, assistant, system, and tool-result messages are appended; custom messages use a separate entry type. | Read the session tree, not event payloads. Notifications request rendering only; they never commit an import. |
| `pi-coding-agent/dist/core/session-manager.js`, `getBranch()` | Walks parent IDs from the selected/current leaf; returns all entry types in source order, not the compaction-aware model projection. | Capture initial text and the last entry ID from the same synchronous branch read. Require the cursor and preview target to remain ancestors of the current leaf. |
| `pi-agent-core/dist/agent-loop.js`, `runLoop()` | Finalized error/aborted assistant responses finish the turn with no tool execution. Length-limited tool calls receive synthetic failed results instead of execution. Other completed responses can execute their calls. | Preserve response status in text. Do not wait for results from calls in error/aborted responses; wait for synthetic results from length-limited calls. |
| `pi-agent-core/dist/agent-loop.js`, tool execution and `emitToolResultMessage()` | Tool calls can execute in parallel; each final result emits message start/end. `turn_end` follows all final tool results. | Track outstanding tool-call IDs and advance only through a complete batch. Include final textual results, including error results, in actual append order. Do not use partial tool events. |
| `pi-coding-agent/dist/core/session-manager.js`, context projection and append methods | Compaction, branch summaries, and context edits change interpretation without removing all raw historical entries. | Reject any such boundary after the cursor, including one added during preview. A newly created source after a boundary uses the existing initial-context policy and starts a new import range. |

Streaming assistant deltas never enter the import snapshot. The normal runtime does not persist `pending` stream messages, but restored `pending` entries and `deferred` provider handles are treated as incomplete barriers: only earlier complete entries are eligible, and the cursor does not cross the barrier. A new side thread can use a later completed source. A finalized aborted or failed response can contain partial text; its status remains visible and no success is inferred. Pending tool batches can coexist with earlier complete entries: those earlier entries can be imported, and the pending batch remains available for a later import. A source selected between a call and its results still waits for all outstanding results.

User and assistant text, tool-call arguments, and standalone tool-result text are eligible. Thinking, image data, system messages, custom messages, and non-message state are not. Initial context retains its established extraction policy, including exclusion of standalone tool-result messages. Incremental imports deliberately add standalone tool evidence; they do not change that initial policy.

The cursor is scoped by the source session ID and the session-owned in-memory thread. Empty roots use a null entry ID. A missing cursor, an ancestor/sibling navigation that removes it, or a different session rejects import. The extension lifetime additionally aborts work on session replacement and reload.

## Publication and request ordering

Preview data is fixed before awaiting the UI. Confirmation rechecks cancellation, session-manager ownership, source identity, current branch compatibility, side-turn count, and update count. It then commits the immutable text payload and target cursor synchronously. A duplicate or stale confirmation cannot append another update. Preview failure and cancellation leave the cursor unchanged.

Updates are separate records indexed by their position among existing side turns. Errors remain display-only. Imports are not side answers, do not enter Q&A export scopes, and do not change question counts or resume ordering. Imported-only threads remain resumable without inventing a question title.

Successful request user messages retain their serialized timestamps. Stored import messages and the optional initial background message also retain theirs. Later successful turns keep the prior serialized message sequence as an exact prefix. A failed or cancelled unanswered question is excluded as before; it is not a committed request-prefix baseline. Imports before the first successful answer use a stable initial background message followed by the imported updates and the new side question.

The provider receives each import as a user-role background message whose payload is a JSON-quoted string, not as tool traffic or an assistant response. This labels provenance but is not a general prompt-injection protection guarantee. The side model still has no tools.

## Verification evidence

The package tests cover snapshot scope, historical/empty sources, missing or divergent cursors, context boundaries before confirmation, parallel tool results, finalized errors/aborts/length limits and their synthetic failures, pending/deferred barriers, content exclusions, and explicit size limits. Import tests cover chronology, exact serialized request prefixes, fixed previews while main advances, duplicate/stale confirmations, provider failure, cancellation, draft recovery, and imported-only resume.

The preview uses Kit's existing read-only review component, plain-text document hard wrapping, framing, theme roles, and lifecycle cancellation. Tests drive the real review with confirmation, back, hard cancel, disposal, and shutdown; callback evidence is asserted after interaction completion. Native fullscreen search tests include imported context. Shortcut tests cover fallback selection, remapping, collisions, aliases, invalid inputs, and legacy/enhanced terminal modes. Existing settings tests cover the new action through the same atomic store and invalid-file safeguards.

## Terminal-only handoff and release limits

A terminal operator must check physical keyboard protocols, IME placement, actual clipboard behavior, and subjective visual placement after a successful build and deterministic checks. Exercise manual import while main output continues in fullscreen and both split layouts; cancel a nested preview, then verify the restored draft and pane focus. These terminal-specific behaviors are not established by mocked rendering or the non-interactive package smoke.

No live-provider request is required to verify the context-ordering contract. Do not claim terminal-only acceptance until the operator completes it. Package publication, tags, and release workflow dispatch require separate explicit user approval.
