# Side-thread workflows

[Back to README](../README.md#-commands)

## Choose context and resume threads

`/btw` lets you start from the current conversation or choose **Start from main thread tree…** to use the root-to-selected-entry path, including the selected entry.
The tree snapshots persisted entries and preserves the main editor draft without navigating, forking, appending to, or switching the main conversation.

For either context source, only user and assistant messages contribute text and formatted tool-call or tool-result blocks.
Images, standalone tool-result messages, compaction summaries, branch summaries, and other session entries are excluded.
The side thread retains the last 40,000 characters of this text and adds a truncation notice when earlier content is omitted.
The initial snapshot stays immutable. Later main progress reaches the side model only after an explicit import; see [Import main updates](#import-main-updates).
An explicit `Shift+L` label edit is the selector's only main-session mutation and persists through Pi.
Native tree copying reports success or failure; Escape returns to the manager and Ctrl+C closes the flow.

**Resume side thread** searches retained in-memory threads by their first question and question count; threads containing only confirmed imports use **Main context updates** as their title.
The first question remains the title; threads are ordered by their newest answer or visible error.
Opening and closing without a new result does not reorder them.
`/btw <question>` bypasses selection and always starts a new thread.

## Import main updates

While the side composer is idle, use **Import main updates** (`F9` by default, then the first usable `F10` or `F11`) to review new persisted main-thread context.
The shortcut is configurable in `/btw` → **Settings**.
A `(new)` hint indicates eligible updates when the footer has room; main progress never imports content automatically.
If no shortcut is available, change the BTW shortcut or the conflicting Pi binding.
Import is unavailable while answering or draining queued side questions.

The read-only preview shows the source session, entry range, retained character count, and any omission notices.
Confirm to append exactly that snapshot, or press Escape to return without changes.
Ctrl+C closes the side flow without applying the pending import.
The main agent keeps running; entries added after the preview opens remain available for the next explicit import.
The side draft is restored when returning to the composer.

Imports contain new user text, finalized assistant text, and textual tool calls and standalone tool results in source order.
Finalized error, aborted, and length-limited assistant responses retain their status labels; they are not evidence of successful work.
Tool calls on error or aborted responses are not executed by Pi; length-limited calls receive synthetic error results instead of execution.
A tool-call batch waits until all its results exist, including parallel results; live stream deltas and partial tool updates are excluded.
Thinking, images, system instructions, and unrelated state entries are excluded.
Persisted pending responses or deferred provider handles block the cursor from advancing past them; start a new side thread from a later completed source if needed.
Each text or tool-call block is limited to 8,000 characters, and each import is limited to 40,000 characters including explicit omission notices.
Imports are limited background snapshots, not complete transcripts. Repeated imports increase total context and can increase provider cost or reach the model's context limit.
Confirmed text is sent to the selected side model's provider with the next question, not at confirmation time.

Each import appears as a searchable **Main context update**, between earlier side exchanges and later questions.
It does not count as a question or change the title.
The existing bring-to-main scopes still export successful side Q&A only, not imported main content.
Repeated imports do not duplicate the same entry range, and a later failed or cancelled side response does not undo a confirmed import.
Closing and resuming retains imports in memory, including imports made before the first question; these appear as **Main context updates** until the first question supplies a title.

The cursor must remain on the current main branch.
Navigation to an ancestor or another branch, a missing cursor, or a compaction, branch summary, or context edit after the cursor blocks import without changing the side thread.
Start a new side thread from the desired context in those cases.
Historical-tree sources can import only when they are ancestors of the current main branch.
Session replacement, reload, and restart discard imports with the rest of the retained side thread.
The [runtime audit](./main-context-runtime.md) records source boundaries, tests, and terminal-only verification limits.

## Read, select, and search

The dedicated workspace places the scrollable transcript above pending questions, the editor, and a compact footer.
The footer identifies BTW and shows the selected side model and thinking level when space permits; a split workspace also shows **BTW focus** or **Main focus**.
Reachable shortcut hints appear below the editor, not above it.
At constrained sizes, the active input cursor takes priority over queue previews, metadata, and hints; zero-sized views remain empty.
The [appearance reference](./native-appearance.md) records native-default comparisons and limits.
The default **Fullscreen** layout gives the side thread the complete workspace.
**Side thread left** and **Side thread right** place it beside Pi's native, live main-thread rendering; terminals narrower than 80 columns show only the side thread.
A single muted divider separates the panes; click either pane or use the displayed pane-switch key to move keyboard focus.
By default, the switch key is the first usable F6, F7, or F8; it can be changed in [Keybindings](../README.md#keybindings).
Nested overlays keep their input ownership and block background pane switching.
Drag the divider with the primary mouse button to resize the side thread between 20% and 80% of the workspace.
Releasing the button saves that side-thread ratio for either pane placement; a failed save restores the last saved width and reports the error.
Pi's search and keyboard viewport controls apply to the active pane.
The mouse wheel scrolls the pane under the pointer without moving keyboard focus, and a narrow terminal returns focus to the visible side thread.
A branch selected through **Start from main thread tree…** supplies side-model context but does not replace the active main thread shown in the other pane.
The main agent may keep running, and the main pane redraws its progress while either pane is active.
Submit each question with Pi's effective editor submission binding, Enter by default; successful prior questions and answers remain available to the side model.

Drag the primary mouse button across the transcript to select text.
Automatic selection copying requests Pi's host clipboard helper immediately and is enabled by default.
With **Copy selection automatically** off, the selection stays highlighted and Pi's effective `app.message.copy` binding copies it.
Manual copying requires Pi's fullscreen selection APIs; if unavailable, pi-btw restores the main TUI and asks you to update Pi or re-enable automatic copying.
The view reports `No selection to copy`, `Copied!`, or a sanitized clipboard error for the request; actual clipboard access still depends on the operating system and terminal.
Right-click clipboard paste is not installed because Pi has no public clipboard-read callback for this workspace.
Ctrl+C always cancels the side flow, even if `app.message.copy` is also mapped to Ctrl+C.

Use Pi's effective transcript-search binding (`Ctrl+Shift+F` by default) to search the displayed transcript, excluding the footer.
Search remains available while answering, covering previous turns and the current question; the current answer appears only after the response completes.
The default next-match keys are Enter or `Ctrl+G`; previous-match keys are `Shift+Enter` or `Ctrl+Shift+G`.
Pi's effective search-close binding, Escape by default, closes search and returns focus to the composer.

Scroll with the mouse wheel, trackpad, or Pi's effective viewport paging bindings (`PgUp`/`PgDn` by default).
Remapped or disabled bindings control behavior; the composer does not retain hidden literal paging shortcuts.
The native transcript uses automatic scrollbars and previous/next-message navigation metadata.
Manual scrolling stays fixed when new turns appear, during resize, and when content temporarily fits; explicitly returning to the latest content resumes follow mode.
On Pi 0.85 or newer, scrolling away from the latest content reveals **Jump to latest message**.
Click it or use Pi's effective `tui.altScreen.bottom` binding (`Ctrl+End` by default) to resume following new output.

## Thinking and queued questions

The footer shows the current side-thread thinking level when space permits.
Use the thinking-cycle shortcut shown below the editor to cycle supported levels for later questions.
It inherits Pi's `app.thinking.cycle` (`Shift+Tab` by default) unless overridden in [Keybindings](../README.md#keybindings).
Whether that change is remembered depends on [Settings](../README.md#-settings); it never changes the main session's thinking level.

During a response, the editor's top border shows `Answering…` with a spinner.
Submit another question to queue it as `Steering next`.
Queued questions run in order after the current response, using the thinking level effective when each turn starts.
They do not interrupt the current provider response or enter Pi's main-session steering/follow-up queue.
A failed response remains visible without discarding later queued questions.
The bounded preview above the editor shows queued questions in order and an omitted-item count when needed.
Steering does not append to the main conversation or editor.

The configured exit shortcut, or the permanent Ctrl+C hard-cancel key, cancels the active response and discards the current draft and steering queue.
Completed questions, answers, and visible errors remain resumable until the extension instance ends.

## Bring context to the main editor

After a successful answer, use the bring-to-main shortcut (`Ctrl+R` by default) to choose the latest question and answer, everything from one question onward, an exact range, or the full thread.
All scopes, including the exact-range selector, use successful question-and-answer exchanges only; failed questions and error messages are excluded.
The scope chooser reports the latest exchange and full-thread sizes.
Question-suffix, exact-range, and full-thread choices show an exact, read-only preview before closing the side thread.
The context block is editable after it is loaded into the main editor.
Escape returns; Ctrl+C closes without bringing context back.

The exact-range selector works on raw source text, not terminal-wrapped rows, and reports line, message, and approximate token counts.
Press Space to select the current raw line, extend with Up or Down, and press Space again to clear.
Alternatively, move with arrow keys and extend character selection with Shift plus an arrow key; starting a Shift selection replaces an active line selection.
Selected lines have a `●` marker and highlighting.
Pi's effective navigation, submission, and back bindings apply, with Up, Down, Enter, and Escape as defaults.

Bringing context closes the side thread and loads a deterministic, editable block into the main editor **without sending it**.
For an existing draft, append is recommended; replace is destructive and requires a second confirmation.
Cancel returns to the side thread without changing either draft, and concurrent editor updates are preserved.
The success message reports whether context was loaded, appended, or replaced and its approximate size.

Without an explicit bring action, closing `/btw` never changes the main conversation.
Resume state is memory-only: `/new`, Pi `/resume`, `/fork`, `/reload`, extension replacement, and process restart discard it.
Unsent drafts, steering queues, interrupted answers, and model credentials are not retained.

## Core compatibility and verification

The [core-alignment handoff](./core-alignment.md) records finding dispositions, deterministic evidence, retained workspace deviations, and proposed Pi APIs.
The [appearance reference](./native-appearance.md) contains native CLI reference frames, before/after BTW frames, public API reuse decisions, and terminal-review instructions.
The package-directory smoke is non-interactive and does not contact a provider.
Terminal-specific mouse, clipboard, IME, keyboard-protocol, and visual acceptance still require a terminal operator.
