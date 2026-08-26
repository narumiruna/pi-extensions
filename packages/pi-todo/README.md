# ✅ pi-todo — Keep Multi-Step Work Visible

[![npm](https://img.shields.io/npm/v/@narumitw/pi-todo)](https://www.npmjs.com/package/@narumitw/pi-todo)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give coding agents a focused todo list for tracking multi-step work above Pi's editor.

The list follows the active session branch and disappears cleanly when no tracked work remains or the session ends.

## ✨ Features

- Registers one `update_todo_list` tool with clear guidance for meaningful multi-step work.
- Keeps task text concise and action-oriented, with at most one task in progress.
- Shows a compact themed task list and completion count above the editor in TUI mode.
- Restores the latest valid list when Pi starts a session or navigates between branches.
- Restores the exact current list to model context only when compaction removes its latest visible successful tool update.
- Sanitizes terminal and bidirectional controls before rendering model-provided text.
- Works without settings, files, network access, or external services.

## 📦 Install

Install persistently from npm:

```bash
pi install npm:@narumitw/pi-todo
```

Try from npm without installing permanently:

```bash
pi -e npm:@narumitw/pi-todo
```

Build and load this package directly from a repository checkout:

```bash
npm --workspace @narumitw/pi-todo run build
pi --no-extensions -e ./packages/pi-todo
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

Pi extensions run with the user's permissions, so install only trusted code.

## 🚀 Quick start

Ask Pi to perform work with multiple meaningful steps.

The agent can create a concise list through `update_todo_list`, mark one task `in_progress`, and revise the list when the plan changes.

Stable tool guidance tells the agent to update the list immediately after task status changes and to reconcile it before progress reports or the final response.

The agent sends the complete current list with every update and sends an empty list when no tracked work remains.

## 🛠️ Tools

### `update_todo_list`

Replace the complete current todo list for the active session.

Each item has this shape:

```json
{
  "text": "Run the focused tests",
  "status": "in_progress"
}
```

Accepted statuses are `pending`, `in_progress`, and `completed`.

A list may contain up to 50 items, each item may contain up to 300 characters, and at most one item may be `in_progress`.

The tool result stores a versioned snapshot in the session branch so branch navigation can reconstruct the latest valid list.

Branch reconstruction also accepts valid results stored under the previous `todo_widget` name, but the extension only registers `update_todo_list` for new calls.

During ordinary turns, the model reads the complete list from the persisted `update_todo_list` assistant tool call, while its successful result confirms the active state and preserves append-only prompt history.

If leading compaction or branch summaries remove that matching call/result pair, the extension inserts one hidden, non-persistent state-only fallback immediately after those summaries.

That restored message remains fixed for the current leading-summary epoch, including after a later valid todo update or clear.
The extension stores branch-local boundary metadata in the session so reload and branch navigation retain the established prefix without making the hidden fallback itself persistent model context.
The later tool call and result supersede the restored state at the conversation tail without rewriting the earlier provider prefix.
An ordinary context without a leading summary does not synthesize a fallback, and a new summary epoch restores only the then-current list when needed.

In TUI mode, updates appear immediately in a widget above the editor.

The widget header shows completed and total task counts, followed by themed completed, in-progress, and pending rows.
Long task text wraps to the available terminal width with continuation lines aligned beneath the text.

In RPC, print, and JSON modes, the tool still returns structured details but does not create a visual widget.

## 🔒 Security and privacy

The extension does not read or write files, start processes, access credentials, or make network requests.

Task text is stored in Pi's normal session tool results and therefore follows the user's existing session persistence choices.

Terminal escape sequences, control characters, and bidirectional display controls are removed at the rendering boundary without changing the stored tool payload.

## 🚧 Limitations

- The visual widget uses a fixed position above the editor and is available only in TUI mode.
- The extension provides a model tool rather than a slash command or manual task editor.
- The extension reminds the model to update statuses but cannot infer task completion or force a tool call.
- Branch reconstruction uses only valid versioned `update_todo_list` or legacy `todo_widget` tool results on the active branch.
- The widget has no independent scrolling or height-based collapsing, so Pi may clip later rows when terminal height is constrained.

## 🗂️ Package layout

```text
packages/pi-todo/
├── dist/
│   └── index.ts              # Generated Jiti runtime entrypoint
├── scripts/
│   └── build-runtime.mjs     # Deterministic runtime builder and validator
├── src/
│   ├── index.ts              # Thin authoritative extension forwarder
│   └── todo-widget.ts        # Tool, lifecycle, state reconstruction, and rendering
├── test/
│   ├── build-runtime.test.ts       # Build, boundary, and Jiti loader coverage
│   ├── todo-cache-contract.test.ts # Normalized provider-prefix coverage
│   └── todo-widget.test.ts         # Extension behavior coverage
├── LICENSE
├── README.md
├── package.json
└── tsconfig.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, coding agent, todo list, task progress, session widget, TypeScript Pi package.

## 📄 License

MIT.

See [`LICENSE`](./LICENSE).
