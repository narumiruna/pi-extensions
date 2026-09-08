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
- Offers BTW-only exit, thinking-cycle, and bring-to-main keybindings.

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

| Command | Purpose |
| --- | --- |
| `/btw` | Choose context, start or resume a side thread, or change settings. |
| `/btw <question>` | Start a new side thread immediately with the supplied question. |

Both routes require TUI mode and a model with usable credentials; see [Settings](#-settings).
Side questions and selected conversation context are sent to that model's provider.
Bringing context back fills the main editor without submitting; replacing an existing draft requires confirmation.
Ctrl+C cancels the response and discards the current draft and queued questions, but completed exchanges remain resumable in memory.
Read the [workflow guide](./docs/workflows.md) for context selection, copying, search, steering, and draft recovery; `/new`, `/resume`, `/reload`, and restart discard retained threads.

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

### Keybindings

Open `/btw` → **Settings**, select a shortcut row, then choose **Edit key combination…** or **Restore default**.
Type a key name such as `ctrl+q` or `f6`; this is not a key-recording prompt.
Changes save immediately and apply when opening or resuming BTW, without `/reload`. Escape cancels an unfinished edit, not earlier saves.
The literal `/btw settings` remains a side question, not a settings subcommand.

| JSON field under `keybindings` | Default | Action |
| --- | --- | --- |
| `exit` | `ctrl+c` | Cancel and leave the dedicated side-thread workspace, including its nested dialogs. |
| `cycleThinkingLevel` | Inherit Pi's `app.thinking.cycle` | Cycle supported levels while composing or generating. |
| `bringToMain` | `ctrl+r` | Open the bring-to-main chooser after a completed answer. |

For example, merge these overrides into `pi-btw.json`:

```json
{
  "keybindings": {
    "exit": "ctrl+q",
    "cycleThinkingLevel": "f6",
    "bringToMain": "f7"
  }
}
```

Each override accepts one Pi key name with optional `ctrl`, `shift`, `alt`, and `super` modifiers; modifier order and letter case do not matter.
Letters, digits, Pi special keys and symbols are recognized, except the literal `+`, which Pi's matcher cannot parse as a base key.
Function keys `f1`–`f12` and Escape accept no modifiers; Clear accepts only no modifier, Shift, or Ctrl.
Actual availability depends on the terminal; `super` and some modified combinations require extended keyboard reporting.

New overrides cannot take ordinary typing keys or conflict with BTW actions, Pi editing, selection, search, scrolling, or enabled manual-copy bindings.
Pi's explicitly configured printable thinking shortcuts remain inherited for compatibility.
If a saved override becomes conflicting, BTW warns and uses an available default; if none is usable, that shortcut is unavailable and its activation hint is omitted.
An explicitly unbound Pi thinking action stays unbound. Remove an override field to restore its default; neither saving nor resetting modifies Pi's global keybindings.
**Ctrl+C always remains available as hard cancel**, even after configuring another exit key. Shortcut handling does not interpret bracketed-paste payloads as commands.

### Persistence

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

```text
packages/pi-btw/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── btw.ts                         # Side-thread lifecycle and command
├── dist/                              # Generated Jiti runtime
├── docs/                              # Side-thread workflows and controls
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, side question command, agent chat workflow, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
