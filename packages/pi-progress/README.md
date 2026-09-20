# 📈 pi-progress — Keep Multi-Step Work Visible

[![npm](https://img.shields.io/npm/v/@narumitw/pi-progress)](https://www.npmjs.com/package/@narumitw/pi-progress)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Progress gives the model a focused, branch-aware progress list above Pi's editor.
It restores valid progress after reloads, branch navigation, and compaction without rewriting ordinary conversation history.

> [!WARNING]
> Remove `@narumitw/pi-todo` before installing this package.
> Loading both packages exposes two independent tools and widgets with competing progress guidance.

## ✨ Features

- Registers only `update_progress` with the canonical `steps[].text` payload.
- Keeps at most one step in progress and requires a reason for blocked work.
- Adapts the themed TUI widget to terminal height while prioritizing active and blocked steps.
- Shows a transient completion summary when every tracked step becomes complete.
- Restores the latest valid state from current and historical session results on the active branch.
- Preserves an established pre-migration compaction boundary until its summary epoch ends.
- Reads optional display settings without writing or migrating settings files.
- Sanitizes terminal and bidirectional controls before rendering model-provided text.
- Works without network access, subprocesses, credentials, or external services.

## 📦 Install

For a new persistent user installation:

```bash
pi install npm:@narumitw/pi-progress
```

Try the package without installing it permanently:

```bash
pi -e npm:@narumitw/pi-progress
```

Build and load an unbuilt repository checkout:

```bash
npm --workspace @narumitw/pi-progress run build
pi --no-extensions -e ./packages/pi-progress
```

The package declares the generated `dist/index.ts` entrypoint, so local package-directory loading requires a build first.
Pi extensions run with the user's permissions; install only trusted code.

### Migrate from pi-todo

First confirm the replacement is available:

```bash
npm view @narumitw/pi-progress version
```

If the command returns `404`, keep `pi-todo` installed.
Otherwise, exit Pi and migrate the same persistent scope in order.
For a user installation:

```bash
pi remove npm:@narumitw/pi-todo
pi install npm:@narumitw/pi-progress
```

For a project installation originally created with `pi install -l`, run from that project:

```bash
pi remove npm:@narumitw/pi-todo -l
pi install npm:@narumitw/pi-progress -l
```

Migrate each scope separately when both are configured.
For temporary npm loading, replace the source without running `pi remove`:

```bash
pi -e npm:@narumitw/pi-progress
```

For local checkout loading, update the checkout, build `packages/pi-progress`, and replace the old `-e` path.
Restart Pi after migration and do not load both package names.
To roll back, remove `pi-progress` from the same persistent scope or restore the old temporary/local source, then reinstall or load `pi-todo`.
Neither migration direction rewrites session or settings files.

## 🚀 Quick start

Ask Pi to perform work with multiple meaningful steps.
The model uses `update_progress` to replace the complete progress state, updates statuses as work changes, and sends an empty `steps` array to clear it.

## 🛠️ Tools

### `update_progress`

The sole registered model tool accepts this exact payload:

```json
{
  "steps": [
    {
      "text": "Inspect the current implementation",
      "status": "completed"
    },
    {
      "text": "Verify behavior with focused tests",
      "status": "in_progress"
    },
    {
      "text": "Publish the package",
      "status": "blocked",
      "reason": "Waiting for approval"
    }
  ]
}
```

Statuses are `pending`, `in_progress`, `completed`, and `blocked`.
A blocked step requires a non-whitespace `reason`; every other status must omit `reason`.
The array supports at most 50 steps, text supports at most 300 characters, reasons support at most 200 characters, and at most one step may be `in_progress`.
Unknown fields are rejected.

Successful results store version 4 `{ steps: [{ text, status, reason? }] }` details.
New calls, results, context messages, widget output, and settings use Progress terminology only.

### Session and compaction behavior

Startup and tree navigation rebuild state from successful, valid results on the active branch.
The compatibility decoder accepts only these historical contracts:

- `update_todo_list` version 3 `{ todos: [{ step, status, reason? }] }`;
- `update_todo_list` or `todo_widget` version 2 `{ todos: [{ step, status }] }`; and
- `update_todo_list` or `todo_widget` version 1 `{ items: [{ text, status }] }`.

Historical names are read-only session inputs and are not registered as tool aliases.
Wrong name/version combinations, malformed shapes, errored results, exceeded limits, and invalid invariants are ignored.
A later valid empty snapshot clears earlier state.

Ordinary turns rely on the retained matching tool call and result, so the extension does not prepend or rewrite model-visible history.
When leading compaction or branch summaries remove that evidence, the extension inserts one deterministic hidden Progress state message after the summaries.
A Todo boundary already established before upgrade remains byte-stable for that summary epoch, including after updates, clears, reloads, and branch navigation.
A later summary epoch uses only canonical Progress context for the then-current state.

In TUI mode, the widget appears above the editor and starts with a full-width themed separator.
Adaptive mode uses up to one third of terminal height, bounded between four and twelve rows.
It prioritizes the in-progress step, blocked steps, and pending steps before summarizing completed or hidden rows.
Completing every non-empty step shows a three-second summary, then hides the widget without clearing session state.
Updates, clears, tree navigation, replacement, and shutdown cancel stale summaries.
RPC, print, and JSON modes retain structured tool behavior without creating a widget.

## ⚙️ Settings

Canonical user settings are read from `<Pi agent directory>/pi-progress.json`, normally `~/.pi/agent/pi-progress.json`:

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
`maxVisibleItems` accepts `null` or an integer from 1 through 50; the other fields are booleans with the defaults shown above.
Settings reload at every session start, including `/reload`, and remain fixed during that session.

When `pi-progress.json` is absent, the extension reads sibling `pi-todo.json` as a legacy fallback through the same bounded, no-symlink validator.
When both exist, the canonical file wins.
An invalid canonical file uses defaults and does not fall back, so its error remains visible in TUI and RPC modes.
Missing, malformed, invalid, oversized, non-regular, symlinked, or non-UTF-8 files are never created, copied, rewritten, moved, or deleted.
This read-only fallback intentionally differs from the repository's usual copy-and-remove filename migration because the predecessor promised zero settings writes.

## 🔒 Security and privacy

The extension reads only the optional canonical or legacy user settings file and never writes either file.
It does not start processes, access credentials, or make network requests.
Pi stores progress text and blocked reasons in normal session tool results, so they follow the user's session persistence choices.
Terminal escape sequences, control characters, and bidirectional display controls are stripped only at the display boundary; stored tool payloads remain unchanged.

## 🚧 Limitations

- The visual widget and completion summary appear only in TUI mode.
- The extension provides a model tool rather than a slash command, SettingsList, or manual progress editor.
- It reminds the model to update progress but cannot infer completion or force a tool call.
- Compatibility restores only the documented, valid historical result contracts from the active branch.
- Adaptive sizing uses terminal height rather than the exact remaining editor viewport.
- The widget has no independent scrolling.

## 🗂️ Package layout

```text
packages/pi-progress/
├── src/
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── progress-widget.ts             # Tool registration and session/widget lifecycle
│   ├── progress-state.ts              # Validation, history decoding, and context reconciliation
│   ├── progress-renderer.ts           # Bounded sanitized widget rendering
│   └── settings.ts                    # Read-only canonical and legacy settings loader
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Deterministic runtime builder
└── test/                              # Contract, lifecycle, renderer, settings, and loader coverage
```

The generated runtime bundles only package-owned source and does not import back into `src`.

## 🔎 Keywords

Pi extension, coding agent, progress tracking, task progress, session widget, TypeScript Pi package.

## 📄 License

[MIT](./LICENSE)
