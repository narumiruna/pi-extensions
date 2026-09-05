# Side-thread workflows

[Back to README](../README.md#-commands)

## Choose context and resume threads

`/btw` lets you start from the current conversation or choose **Start from main thread tree…** to use the root-to-selected-entry path, including the selected entry.
The tree snapshots persisted entries and preserves the main editor draft without navigating, forking, appending to, or switching the main conversation.
Side-thread context stays immutable if the main conversation later changes.
An explicit `Shift+L` label edit is the selector's only main-session mutation and persists through Pi.
Native tree copying reports success or failure; Escape returns to the manager and Ctrl+C closes the flow.

**Resume side thread** searches non-empty in-memory threads by their first question and question count.
The first question remains the title; threads are ordered by their newest answer or visible error.
Opening and closing without a new result does not reorder them.
`/btw <question>` bypasses selection and always starts a new thread.

## Read, select, and search

The fullscreen workspace keeps answers above the editor and identifies itself with a fixed `btw · side thread` header.
The main agent may keep running, but its rendering is suspended so new output cannot move a mouse selection; returning to Pi redraws that output.
Submit each question with Enter; successful prior questions and answers remain available to the side model.

Drag the primary mouse button across the transcript to select text.
Automatic selection copying requests Pi's host clipboard helper immediately and is enabled by default.
With **Copy selection automatically** off, the selection stays highlighted and Pi's effective `app.message.copy` binding copies it.
Manual copying requires Pi's fullscreen selection APIs; if unavailable, pi-btw restores the main TUI and asks you to update Pi or re-enable automatic copying.
The view reports `No selection to copy`, `Copied!`, or `Copy failed` for the request; actual clipboard access still depends on the operating system and terminal.
Ctrl+C always cancels the side flow, even if `app.message.copy` is also mapped to Ctrl+C.

Press `Ctrl+Shift+F` to search completed or in-progress transcript text, excluding the fixed header and footer.
Enter or `Ctrl+G` finds the next match; `Shift+Enter` or `Ctrl+Shift+G` finds the previous match.
Escape closes search and returns focus to the composer.

Scroll with the mouse wheel, trackpad, or `PgUp`/`PgDn`.
On Pi 0.85 or newer, scrolling away from the latest content reveals **Jump to latest message**.
Click it or use Pi's effective `tui.altScreen.bottom` binding (`End` by default) to resume following new output.

## Thinking and queued questions

The header shows the current side-thread thinking level.
Use Pi's `app.thinking.cycle` shortcut (`Shift+Tab` by default) in the composer to cycle supported levels for later questions.
Whether that change is remembered depends on [Settings](../README.md#-settings); it never changes the main session's thinking level.

During a response, submit another question to queue it as `Steering`.
Queued questions run in order after the current response, using the thinking level effective when each turn starts.
A failed response remains visible without discarding later queued questions.
Steering does not append to the main conversation or editor.

Ctrl+C cancels the active response and discards the current draft and steering queue.
Completed questions, answers, and visible errors remain resumable until the extension instance ends.

## Bring context to the main editor

After a successful answer, press `Ctrl+R` to choose the latest question and answer, everything from one question onward, an exact range, or the full thread.
The scope chooser reports the latest exchange and full-thread sizes.
Question-suffix, exact-range, and full-thread choices preview an editable context block before closing the side thread.
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
Resume state is memory-only: `/new`, Pi `/resume`, `/reload`, extension replacement, and process restart discard it.
Unsent drafts, steering queues, interrupted answers, and model credentials are not retained.
