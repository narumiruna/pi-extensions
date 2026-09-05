# 🧠 Pi Recall — Save and Reuse Messages Across Sessions

[![npm](https://img.shields.io/npm/v/@narumitw/pi-recall)](https://www.npmjs.com/package/@narumitw/pi-recall) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Save selected user or assistant messages, find them in another Pi session, and quote them into a new draft.
Saved content stays local until you submit that draft.

## ✨ Features

- Saves any eligible user or assistant text message from the active session branch.
- Recalls by current cwd, current session, or all saved messages.
- Filters by role and fuzzy-searches message text, role, and session name.
- Previews the full message before inserting an XML-marked quote at the editor cursor.
- Inserts recalled text without submitting it and confirms every deletion.
- Stores private, versioned JSONL with cross-process locking and atomic replacement.
- Makes malformed, unsupported, oversized, symlinked, or non-file storage read-only.

## 📦 Install

Install persistently from npm:

```bash
pi install npm:@narumitw/pi-recall
```

Try from npm without installing permanently:

```bash
pi -e npm:@narumitw/pi-recall
```

Try this package from a local checkout:

```bash
npm --workspace @narumitw/pi-recall run build
pi -e ./packages/pi-recall
```

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
Install only from sources you trust because Pi extensions run with Pi's permissions.

## 🚀 Quick start

1. Run `/recall`, choose **Save a message**, and select a user or assistant message.
2. In any later session, run `/recall` and choose **Recall a saved message**.
3. Preview the result, quote it into the draft, add your instruction, and submit normally.

## 🧭 Recall workflow

Use these controls as needed in the saved-message picker:

| Control | Action |
| --- | --- |
| Type | Fuzzy-search saved messages. |
| `Tab` / `Shift+Tab` | Change scope. |
| Configured `/tree` filter-cycle keys | Change message view; defaults to `Ctrl+O` / `Ctrl+Shift+O`. |
| `Enter` | Open the selected message for preview or quoting. |
| `Ctrl+D` | Review and confirm deletion. |

After quoting, add your instruction and submit the draft normally.

A quoted draft uses this form:

```xml
<recalled_message role="assistant" message_timestamp="2026-08-04T12:34:56.000Z">
Original message text
</recalled_message>

The user intentionally recalled and quoted the saved message above.
```

The quote sent to the editor omits cwd, session IDs, entry IDs, session files, and other local paths.

## 💬 Commands

Run `/recall` to save messages and review, quote, or delete saved context in TUI or RPC mode.
It accepts no arguments and rejects print and JSON modes.
Quoting fills the editor without submitting; RPC uses Pi's `set_editor_text` request.
Deletion requires confirmation; see [recall controls](#-tui-fuzzy-search) for deletion and cancellation behavior.

## 🧭 Recall scopes

- **Current cwd** — saved messages whose normalized absolute source cwd matches the current cwd.
  This is the default for each new `/recall` interaction.
- **All** — every valid record in the current Pi agent directory.
- **Current session** — records whose source session ID exactly matches the current session.

Scope applies only when recalling already saved messages.
The save picker intentionally reads only `ctx.sessionManager.getBranch()` from the current session and never scans other session files.
TUI scope switching keeps the selected saved record when it remains visible in the new scope; otherwise it selects the first fuzzy-ranked result or the newest result when the query is empty.

## 👁️ Recall views

The saved-message TUI has three flat display views:

- **All messages** — every saved user and assistant message in the active scope.
- **User only** — only saved user messages in the active scope.
- **Assistant only** — only saved assistant messages in the active scope.

The view uses Pi's injected `app.tree.filter.cycleForward` and `app.tree.filter.cycleBackward` bindings, which default to `Ctrl+O` and `Ctrl+Shift+O`.
Pi Recall reserves `Ctrl+D` for deletion instead of reusing `/tree`'s direct filter bindings.
The picker shows the active view, filtered count, cursor position, and configured cycle keys.
Scope, view, query, and selection survive record opening and deletion attempts within one `/recall` flow.
After successful deletion, selection moves to a neighboring visible record.
RPC asks for scope explicitly and shows the complete scoped list without TUI-only view or search shortcuts.

## 🔍 TUI fuzzy search

The TUI picker has a visible `Search:` input.
It applies scope first, then the active message view, then fuzzy search.
Search matches complete saved message text, the `user` or `assistant` role, and the optional session name.
Matching is case-insensitive and requires every whitespace- or slash-separated token as an ordered subsequence.
It ranks closer matches first but does not perform typo-edit-distance correction.

Scope and view changes retain the selected record when it remains visible; otherwise the picker chooses the first ranked result, or the newest result for an empty query.
Each new `/recall` starts with **Current cwd**, **All messages**, and an empty query.
Queries are limited to 256 UTF-16 code units; an overlong query shows an error and does not run.
Terminal controls are replaced before matching or display, while ordinary spaces remain available for multi-token queries.

`Ctrl+D`—or the configured `app.session.delete` binding—opens a confirmation identifying the selected record and showing a bounded preview.
Cancellation returns to the unchanged picker.
After confirmation, Pi Recall shows non-cancellable deletion progress, applies the existing locked atomic JSONL mutation, and returns to the same scope, view, and query with a neighboring result selected.
A failure keeps the previous list visible and reports how to retry; a record concurrently removed elsewhere is reconciled as already absent.
Plain `Delete` remains available for forward editing in the search input.
The existing `Enter` → **Delete…** route remains available when a complete saved-text review is preferred.

RPC continues to show the complete scoped list through explicit dialogs and does not simulate a hidden fuzzy query or terminal shortcut.
Message timestamps, cwd, session IDs, entry IDs, and local paths are not searchable.

## 🔒 Security and privacy

The canonical user file is:

```text
~/.pi/agent/pi-recall.jsonl
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
Each line is one active versioned `recall_message` record.
Records contain the text, role, saved time, original message time, source cwd, source session ID, source entry ID, and optional session name.
This provenance is shown locally but is excluded from generated quote payloads except for role and original message time.

Pi Recall creates no settings, session custom entries, tools, background work, or automatic model context.
It reads storage only while `/recall` needs it.
Save and delete operations acquire one cross-process lock, reread canonical storage under that lock, and publish a complete JSONL replacement through a unique same-directory `0600` temporary file.
Lock waiting is abort-aware.
The canonical file is required to be a regular non-symlink file and is kept at `0600`.

Malformed JSON, duplicate IDs, unknown record types or versions, invalid records, symlinks, and limit violations make storage read-only.
Fix or move the reported file, then reopen `/recall`.
Pi Recall never overwrites invalid storage.
Unknown fields on otherwise valid version-1 records survive later rewrites.

Deleting a message removes it from canonical `pi-recall.jsonl`.
It is not secure erasure of filesystem blocks, backups, snapshots, temporary copies left by an operating-system failure, or content already quoted into a session.

## 📝 Message semantics and limits

- Eligible sources are `message` entries with role `user` or `assistant` on the active branch.
- User strings and text blocks are kept; multiple text blocks are joined in source order with newlines.
- Thinking, tool calls, tool results, images/base64, custom messages, image-only messages, empty text, and abandoned branches are not saved.
- Markdown, indentation, Unicode, and original line breaks are preserved; oversized messages are excluded rather than truncated.
- A source message can be saved only once for the same source session ID and entry ID.
- At most 200 messages may be saved.
- One message text may contain at most 50,000 UTF-8 bytes.
- Canonical JSONL may contain at most 12 MiB.
- Records are never evicted automatically.

Terminal controls are removed from labels, previews, metadata, and errors before display.
Full review content is passed through Pi TUI Kit's sanitized review renderer.
The raw stored text is not modified merely for display.

## 🚧 Limitations

- No tags, saved-query persistence, message editing, reordering, batch deletion, import/export, automatic expiry, or automatic context injection.
- No cross-session transcript browser: only previously saved records can be recalled across sessions.
- Text only; images and tool payloads are deliberately omitted.
- The custom TUI picker is keyboard-operated; RPC uses sequential dialogs.
- Scope, view, and search preferences are not persisted; every new `/recall` interaction starts at **Current cwd**, **All messages**, and an empty query.

## 🗂️ Package layout

```text
packages/pi-recall/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── recall.ts                      # Saved-message command and lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, saved messages, message recall, cross-session context, quote manager, JSONL, terminal UI.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
