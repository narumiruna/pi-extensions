# ✅ pi-todo — Keep Multi-Step Work Visible

[![npm](https://img.shields.io/npm/v/@narumitw/pi-todo)](https://www.npmjs.com/package/@narumitw/pi-todo)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Todo gives the model a focused list for tracking multi-step work above Pi's editor.
The list follows the active session branch, adapts to terminal space, and disappears when no tracked work remains or the session ends.

## ✨ Features

- Registers one `update_todo_list` tool for meaningful multi-step work.
- Keeps todo steps concise and action-oriented, with at most one todo in progress.
- Represents externally blocked work with a required reason instead of treating it as complete.
- Adapts the themed TUI widget to terminal height while keeping active and blocked work visible.
- Shows a transient completion summary when every tracked todo becomes complete.
- Restores the latest valid list when Pi starts a session or navigates between branches.
- Restores the exact current list to model context only when compaction removes its latest visible successful tool update.
- Supports optional display preferences from a read-only user settings file.
- Sanitizes terminal and bidirectional controls before rendering model-provided text.
- Works without settings writes, network access, or external services.

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
The model can use `update_todo_list` to create a concise list, mark one todo `in_progress`, record externally blocked work with a reason, and revise the plan as work changes.
Each update replaces the complete `todos` array, and an empty array clears it.
Tool guidance tells the model to update changed statuses promptly and reconcile the list before progress reports or the final response.

## 🛠️ Tools

### `update_todo_list`

Replaces the complete todo list for the active session.
The tool accepts this shape:

```json
{
  "todos": [
    {
      "step": "Run the focused tests",
      "status": "in_progress"
    },
    {
      "step": "Deploy the release candidate",
      "status": "blocked",
      "reason": "Waiting for approval"
    }
  ]
}
```

Accepted statuses are `pending`, `in_progress`, `completed`, and `blocked`.
A `blocked` todo must include a non-whitespace `reason`, and other statuses must omit `reason`.
The `todos` array may contain up to 50 entries, each `step` may contain up to 300 characters, each blocked `reason` may contain up to 200 characters, and at most one todo may be `in_progress`.

### Session and compaction behavior

Each successful tool result stores a versioned snapshot on the active session branch.
Session startup and branch navigation reconstruct the latest valid list from those results.
New results store version 3 `{ todos: [{ step, status, reason? }] }` details.
Reconstruction migrates valid version 2 `{ todos: [{ step, status }] }` details and version 1 `{ items: [{ text, status }] }` details stored under `update_todo_list` or the former `todo_widget` name.
New calls use only the version 3 schema.

During ordinary turns, the persisted assistant tool call and successful result keep the complete current list visible to the model without rewriting prompt history.
If leading compaction or branch summaries remove that matching pair, the extension inserts one hidden, non-persistent state message immediately after the summaries.
The restored message stays fixed for that leading-summary epoch, even after a later valid update or clear.
Branch-local boundary metadata preserves the established prefix across reload and branch navigation without persisting the hidden message as model context.
A later tool call and result supersede the restored state at the conversation tail without rewriting the earlier provider prefix.
An ordinary context without a leading summary receives no fallback.
A new summary epoch restores only the list that is current when restoration becomes necessary.

In TUI mode, updates appear immediately above the editor.
Adaptive mode uses up to one third of the terminal height, bounded between four and twelve rows.
When the full list does not fit, the widget prioritizes the in-progress todo, blocked todos, and upcoming pending todos, then summarizes completed and hidden rows.
Long task text wraps to the terminal width, with continuation lines aligned beneath the text and bounded when compact rendering runs out of rows.
When a non-empty list becomes fully complete, the widget shows a three-second completion summary and then hides without clearing the persisted todo state.
A later update, clear, tree navigation, reload, or session replacement cancels any stale completion summary.
In RPC, print, and JSON modes, the tool still returns structured details but does not create a visual widget.

## ⚙️ Settings

Settings are optional and user-scoped at `<Pi agent directory>/pi-todo.json`, normally `~/.pi/agent/pi-todo.json`.

```json
{
  "widget": {
    "enabled": true,
    "displayMode": "adaptive",
    "showCompleted": true,
    "maxVisibleItems": null,
    "showProgress": true
  }
}
```

`displayMode` accepts `adaptive`, `expanded`, or `collapsed`.
`maxVisibleItems` accepts `null` for no item-count cap or an integer from 1 through 50.
The other widget settings are booleans with the defaults shown above.
Missing settings use defaults without creating a file or directory.
Settings load at session start, including `/reload`, and do not change during an active session until the next load.
Invalid, oversized, non-regular, symlinked, malformed, or non-UTF-8 settings use defaults without overwriting the file.
Pi reports invalid settings through a warning in TUI and RPC modes, while print and JSON modes continue with defaults without writing ad hoc output.
This extension intentionally provides manual JSON settings without a slash command or SettingsList UI.

## 🔒 Security and privacy

The extension reads only the optional user settings file and never writes settings or other files.
It does not start processes, access credentials, or make network requests.
Pi stores todo steps and blocked reasons in normal session tool results, so they follow the user's session persistence choices.
Terminal escape sequences, control characters, and bidirectional display controls are removed at the rendering boundary without changing the stored tool payload.

## 🚧 Limitations

- The visual widget and completion summary appear above the editor only in TUI mode.
- The extension provides a model tool rather than a slash command, SettingsList, or manual task editor.
- The extension reminds the model to update statuses but cannot infer task completion or force a tool call.
- Branch reconstruction uses only successful, valid, versioned `update_todo_list` or legacy `todo_widget` tool results on the active branch.
- Adaptive sizing uses terminal height rather than the exact remaining editor viewport, so it applies a conservative row budget.
- The widget has no independent scrolling.

## 🗂️ Package layout

```text
packages/pi-todo/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── todo-widget.ts                 # Todo tool, branch state, and widget lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, coding agent, todo list, task progress, session widget, TypeScript Pi package.

## 📄 License

[MIT](./LICENSE)
