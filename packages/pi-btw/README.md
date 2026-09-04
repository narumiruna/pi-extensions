# 💬 pi-btw — Ask Side Questions Without Derailing the Main Task

[![npm](https://img.shields.io/npm/v/@narumitw/pi-btw)](https://www.npmjs.com/package/@narumitw/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Ask questions in a temporary side thread without adding them to the main Pi conversation.
Only context you explicitly bring back is loaded into the main editor.

## ✨ Features

- Starts a side thread immediately with `/btw <question>` or opens the manager with `/btw`.
- Uses any persisted main-session branch as context without switching branches.
- Supports scrollable answers, transcript search, a clickable jump-to-latest control, follow-up questions, queued steering, and in-memory resume.
- Keeps side questions and answers out of the main conversation by default.
- Brings back the latest answer, a question suffix, an exact range, or the complete thread only when requested.
- Uses Pi's current model and thinking level or saved pi-btw choices.

## 📦 Install

```bash
pi install npm:@narumitw/pi-btw
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-btw
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-btw run build
pi -e ./packages/pi-btw
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.
Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

In TUI mode, run `/btw <question>` to start immediately or `/btw` to choose context and settings first.
The side thread stays separate until you explicitly bring context to the main editor.

## 💬 Commands

`/btw` is TUI-only.
Open the manager or provide the first question immediately:

```text
/btw
/btw <your side question>
```

Examples:

```text
/btw
/btw what does this TypeScript error mean?
/btw summarize the current implementation before we continue
/btw is this API name idiomatic?
```

### Choose context or resume a thread

Running `/btw` opens a manager with **Start side thread** selected first.
**Start from main thread tree…** opens Pi's session tree and uses the root-to-selected-entry path, including the selected entry, as context.
This choice preserves the main editor draft and does not navigate, fork, append to, or switch the main conversation.
The tree is a snapshot of persisted entries, and the side thread keeps immutable context even if the main conversation later changes.
Escape returns to the manager, and Ctrl+C closes the flow.
Native tree copying reports success or failure.
An explicit `Shift+L` label edit is the only main-session mutation available from this selector and persists through Pi.

When non-empty threads exist in memory, **Resume side thread** opens a bounded searchable list.
Search matches the first question and question count while retaining each raw thread ID.
Each row uses the first question as its fixed title and shows the question count.
Rows are ordered by the newest recorded answer or visible error; opening and closing without a new result does not reorder them.
**Settings** controls the starting thinking level, fixed-level shortcut memory, and automatic selection copying.
`/btw <question>` bypasses the manager and always starts a new thread.

### Use the side-thread workspace

The side thread uses a dedicated full-screen terminal view with answers above the editor.
The main agent can continue running, but main-screen rendering stays suspended until `/btw` closes so new output cannot move a mouse selection.
Returning to Pi redraws everything produced while the main view was hidden.

A fixed `btw · side thread` header identifies the workspace while scrolling.
Messages use Pi's normal user and assistant presentation without turn numbers or role labels.
Type a question and press Enter for each turn.
Previous successful questions and answers remain visible and available to the side model.

Drag the primary mouse button across transcript text to select it.
Automatic selection copying is on by default and immediately requests a copy through Pi's host clipboard helper.
When **Copy selection automatically** is off, the selection stays highlighted and Pi's effective `app.message.copy` binding copies it.
Manual mode requires Pi's current fullscreen selection APIs.
If those APIs are unavailable, pi-btw restores the main TUI and asks you to update Pi or re-enable automatic copying.
The view reports `No selection to copy` when that binding is used without an active selection.
It reports `Copied!` when Pi accepts a clipboard request and `Copy failed` when Pi rejects it.
Actual clipboard access still depends on the operating system and terminal.
Ctrl+C always cancels the side flow, even when `app.message.copy` is also mapped to Ctrl+C.

Press `Ctrl+Shift+F` to search completed or in-progress transcript content.
Press Enter or `Ctrl+G` for the next match, `Shift+Enter` or `Ctrl+Shift+G` for the previous match, and Escape to close search.
Search uses Pi's active theme, excludes fixed header and footer text, and returns focus to the composer when closed.

### Change thinking level or queue steering

The header shows the side thread's current thinking level.
In the composer, use Pi's configured `app.thinking.cycle` shortcut (`Shift+Tab` by default) to cycle levels supported by the side model.
Later questions use the displayed level until it changes again.
For a fixed starting level, shortcut changes are saved to `pi-btw.json` by default.
Turn **Remember thinking level changes** off to keep them local to the thread.
With **Same as main thread**, shortcut changes are always local.
Neither setting changes the main session's thinking level.

During a response, the transcript and composer remain visible above `Answering…`.
Submit another question to queue it as `Steering`.
Queued questions appear in submission order and run one at a time after the active response.
Each queued question uses the side thread's thinking level when its turn starts.
A failed response remains visible and does not discard later queued questions.
Steering never appends to the main conversation or editor.

Use the mouse wheel, trackpad, or `PgUp`/`PgDn` to scroll transcript history.
On Pi 0.85 or newer, scrolling away from a following transcript shows **Jump to latest message** over its final visible row.
Click the control or use Pi's effective `tui.altScreen.bottom` binding (`End` by default) to resume at the latest content.
The control disappears after the transcript returns to follow-end mode.
The footer shows history keys only when scrolling is available.
Ctrl+C cancels the active response and discards the current draft and steering queue.
Completed questions, answers, and visible errors remain available through Resume until the extension instance ends.

### Bring context to the main editor

After a successful answer, press `Ctrl+R` to choose context for the main editor.
The scope menu shows the size of the latest question and answer and the full thread.
Choose the latest question and answer, everything from one question onward, an exact range, or the full thread.
Question-suffix, exact-range, and full-thread choices preview the editable context block before the side thread closes.
Escape returns, while Ctrl+C closes without bringing context back.

The exact-range selector supports whole-line and editor-style character selection.
It reports selected line, message, and approximate token counts.
Press Space to select the current raw source line, use Up or Down to extend by lines, and press Space again to clear.
Alternatively, move with arrow keys and extend a character selection with Shift plus an arrow key.
Starting a Shift selection replaces an active line selection.
Selected lines show a `●` marker as well as highlighting.
Pi's configured keys control vertical navigation, bringing, and going back, with Up, Down, Enter, and Escape as defaults.
Selection follows raw source text rather than terminal-wrapped rows.

Bringing context closes the side thread and loads a deterministic, editable block into Pi's main editor without sending it.
If a draft already exists, append is the recommended default.
Replace is marked destructive and requires a second confirmation.
Cancel returns to the side thread without changing either draft, and concurrent editor updates are preserved.
A success message reports whether context was loaded, appended, or replaced and gives its approximate size.

Without an explicit bring action, closing `/btw` never changes the main conversation.
Non-empty threads remain in memory only for Resume during the current extension instance.
`/new`, Pi `/resume`, `/reload`, extension replacement, and process restart discard retained threads.
Unsent drafts, steering queues, interrupted answers, and model credentials are not retained.

## ⚙️ Settings

By default, `/btw` uses the current session model.
To use an independent model for side questions, create:

```text
$PI_CODING_AGENT_DIR/pi-btw.json
```

The normal location is `~/.pi/agent/pi-btw.json`.
`PI_CODING_AGENT_DIR` is an existing Pi setting; pi-btw does not add any environment variables.

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "low",
  "rememberThinkingLevelChanges": true,
  "fullscreenCopyOnSelect": true
}
```

The `model` value uses `provider/model-id` format.
Only the first `/` is the separator, so model IDs may contain additional slashes, such as `openrouter/anthropic/claude-sonnet`.
The configured model must exist in Pi's model registry and have usable credentials.
If it is missing or unauthenticated, pi-btw warns and falls back to the current session model.
If neither model is available, `/btw` reports an error and stops.
This selection affects only `/btw`; it does not change the main session model.

Pi calls its reasoning setting the **thinking level**.
In Settings, choose **Same as main thread** to start each new side thread from the main thread's current thinking level.
This is stored by omitting `thinkingLevel` from `pi-btw.json`.

Set `thinkingLevel` only when you want a fixed pi-btw starting level.
Accepted fixed values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
The initial value and shortcut cycle are clamped to the selected side model's capabilities using Pi's model rules.
Resumed side threads keep their own local thinking level instead of re-syncing with the main thread.
Pi-btw does not read, write, or change the main session's `defaultThinkingLevel`.

`rememberThinkingLevelChanges` controls only persistence for fixed thinking levels and defaults to `true` when omitted.
A side-thread shortcut always changes that side thread immediately.
When a fixed thinking level is selected and remembering is on, the concrete level is written for the next invocation; when off, `pi-btw.json` stays unchanged.
When **Same as main thread** is selected, shortcut changes stay local even when remembering is on.
If a shortcut write fails, the local change remains active and pi-btw warns that it was not remembered.
A failed Settings-screen save instead restores the previous displayed value.

`fullscreenCopyOnSelect` controls only pi-btw's dedicated fullscreen view and defaults to `true` when omitted.
Turn **Copy selection automatically** off to retain highlighted selections and copy them with Pi's effective `app.message.copy` binding.
Pi-btw does not inherit Pi core's setting of the same name because Pi's public extension API does not expose its effective value.

Reading a missing settings file has no side effects.
Pi-btw creates it only after a Settings change or a remembered shortcut change.
Within one Pi process, saves run in order and publish atomically through a same-directory temporary file and rename.
Saves preserve `model` and unknown fields.
Malformed or invalid files block saves and remain unchanged.
Files must be valid UTF-8 and no larger than 64 KiB.
Separate Pi processes and external editors are outside the in-process ordering boundary.
The file is read for every `/btw` invocation, so edits apply without `/reload`.

## 🚧 Limitations

- `/btw` supports TUI mode only.
- Resume state is memory-only and lasts only for the current extension instance.
- A side thread retains the latest 40,000 characters of main-conversation context and adds a truncation notice when earlier content is omitted.
- Clipboard access depends on Pi's host helper, the operating system, and the terminal.
- Pi versions before 0.85 omit the clickable jump-to-latest control.

## 🗂️ Package layout

```txt
packages/pi-btw/
├── dist/                  # Generated TypeScript runtime loaded by Jiti
├── scripts/
│   └── build-runtime.mjs  # Deterministic runtime builder and boundary validator
├── src/
│   ├── index.ts
│   ├── btw.ts
│   ├── bring-to-main.ts
│   ├── fullscreen-ui.ts
│   ├── main-tree-picker.ts
│   ├── menu.ts
│   ├── settings.ts
│   ├── side-thread.ts
│   ├── text.ts
│   └── transcript-pager.ts
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.ts"]
  }
}
```

The generated runtime is built from the authoritative `src/index.ts` graph and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, side question command, agent chat workflow, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
