# 🗂️ pi-file-context — Browse and Attach Exact File Context

[![npm](https://img.shields.io/npm/v/@narumitw/pi-file-context)](https://www.npmjs.com/package/@narumitw/pi-file-context)
[![Pi Extension](https://img.shields.io/badge/Pi-extension-blue)](https://github.com/earendil-works/pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Browse project files in Pi, select exact lines or Git changes, and review each snapshot before attaching it to the next prompt.

## ✨ Features

- Opens from `/file-context` or a configurable shortcut that defaults to `Ctrl+Shift+X`.
- Browses project folders, searches file names or contents globally, and previews bounded text with line numbers.
- Adds whole-file references, exact line ranges, changed hunks, revisions, or Git diffs without using the clipboard.
- Opens the current worktree file in Pi's configured external editor from the preview and reloads it after editing.
- Shows Git state, blame, bounded file history, provenance, and a deterministic token estimate before attachment.
- Reviews and removes queued snapshots before the next prompt.
- Preserves selection order, supports repeated browsing, skips common generated directories, and never follows symlinks during discovery.

## 📦 Install

Install persistently from npm:

```bash
pi install npm:@narumitw/pi-file-context
```

Run once from npm:

```bash
pi -e npm:@narumitw/pi-file-context
```

Build and run the local working tree:

```bash
npm --workspace @narumitw/pi-file-context run build
pi -e ./packages/pi-file-context
```

The package declares `dist/index.ts`, so build a local checkout before loading its package directory.

Pi extensions run with your user permissions.
Review third-party extension source before installing it.

## 🚀 Quick start

1. Press `Ctrl+Shift+X` or run `/file-context browse`.
2. Find a file, select exact lines or Git changes, and press `Enter` to queue the snapshot.
3. Run `/file-context` to review the queue, then write and submit the request normally.

## 🧭 Browser workflow

1. Run `/file-context` and choose **Add context snippet**.
   Press `Ctrl+Shift+X` or run `/file-context browse` to open the browser directly.
   Every route shows the same cancellable project scan before browsing.
2. Use `Up`/`Down` to select an immediate child folder or file, and press `Enter` to open it.
   `Escape`, `Left`, or `Backspace` returns to the parent folder when the search field is empty.
   Type to fuzzy-search file names across every discovered folder in relevance order.
   Press `Tab` on a file to insert a normal whole-file `@path` reference, or `Enter` to preview it for quoting.
3. Press `Ctrl+F` to switch between file-name and content search.
   Content search is literal and case-insensitive by default; `Alt+C` toggles case sensitivity and `Alt+F` toggles ordered fuzzy matching.
   The current states remain visible above the results.
4. In content results, use `Up`/`Down` to choose a highlighted path-and-line card.
   Press `Tab` for a whole-file reference or `Enter` to preview the file at that line.
   `Escape` from the preview restores the query, result selection, and scroll position.
5. In the preview, press `Space` to anchor the selection and extend the range with `Up`/`Down`.
   The adaptive footer shows line selection, capacity, navigation, Git actions, external editing, and the `?` help action.
   Press `Enter` to add and close, or press `a` to add and return to the originating file or content results so you can keep browsing.
6. Use Pi's `app.editor.external` action, `Ctrl+G` by default, to open the current worktree file in the configured external editor.
   File Context pauses its TUI, waits for the editor to exit, reloads bounded text and Git state, and keeps a reload failure visible in the preview.
   A customized binding is matched and displayed directly, takes priority over File Context's additive letter shortcuts, and does not leave the old `Ctrl+G` active.
7. Press `?` in the preview to review all actions.
   In a Git worktree, `[`/`]` selects changed hunks, `b` shows current-line blame, `h` opens file history, `r` opens a commit/branch/tag, and `d` reviews and adds explicit diff context.
   Historical revision previews are read-only and never overwrite the current worktree through the external-editor action.
8. Open `/file-context` and choose **Review selected context** to inspect each exact snapshot.
   `Enter` opens the snapshot first and then offers **Remove from next prompt**.
   `Escape` goes back without changing selected context, while `Ctrl+C` closes File Context.
   Write the question and submit normally; selected snippets are attached in order and cleared together.

`Escape` returns from a preview to its originating folder, file-search results, or content results.
With an empty file-search field, `Escape` from a nested folder returns to its parent.
When the browser was opened from the menu, `Escape` from the root folder returns to the menu.
Direct browser routes cancel at the root instead.
`Ctrl+C` closes menus and browsers.
During project scanning, either cancel key stops the scan; menu-owned scans return to the menu and direct scans close without opening a stale explorer.

The agent receives an explicit block similar to:

```xml
<user_file_quote path="src/runtime.ts" lines="12-18" git_head="a1b2c3d4..." git_branch="main" git_status="modified (unstaged)" git_blob="e5f6..." content_sha256="9abc..." source="worktree" git_base="HEAD">
selected content
</user_file_quote>
```

Non-Git quotes retain the original `path` and `lines` attributes exactly.
Git-backed quotes add ordered optional provenance: the repository HEAD at selection time, branch, file status, selected revision or baseline, tracked blob when available, source kind (`worktree`, `revision`, or `git_diff`), and SHA-256 of the exact attached text.
HEAD alone does not identify uncommitted content; `content_sha256` identifies the actual snapshot.

Token counts use the deterministic estimate `ceil(UTF-8 bytes / 4)` and do not predict provider billing.
Diff context is never attached automatically.

## ⚙️ Settings

File Context reads optional user settings from `~/.pi/agent/pi-file-context.json`, or the equivalent file under Pi's configured agent directory.
Using the defaults does not create the file.

Open `/file-context`, choose **Settings**, then choose **Open shortcut** to change or disable it.
The Settings action is unavailable while context snippets are selected because applying the shortcut reloads Pi and would otherwise discard those in-memory selections.
A successful menu save reloads Pi automatically so the new shortcut becomes active.

```json
{
  "openShortcut": "ctrl+shift+x"
}
```

Set `openShortcut` to a valid Pi key identifier.
Set it to `null` to disable the shortcut and use `/file-context browse`.
External editing uses Pi's own `app.editor.external` keybinding and `externalEditor` setting rather than a File Context setting.
Customize those through Pi's `keybindings.json` and `settings.json`; File Context reads the effective values and does not register a competing external-editor shortcut.
Use an editor wait option such as `code --wait` when the editor command would otherwise return before editing finishes.
Run `/reload` after editing the JSON file manually.

Missing settings use `Ctrl+Shift+X` without creating the file.
`Ctrl+Shift+X` requires a terminal that reports shifted control keys through the Kitty keyboard protocol or modifyOtherKeys; use `F8` if the terminal cannot distinguish it from `Ctrl+X`.
Invalid JSON or values leave the source file unchanged, use the safe default on load, show a warning, and make the Settings screen read-only until the file is fixed and Pi is reloaded.
Failed saves preserve the previous effective shortcut.
If an automatic reload fails after a successful save, run `/reload` to apply the saved value.
Interactive saves preserve unknown fields, run in request order within the Pi process, and publish atomically with private file permissions.

Choose a shortcut that does not conflict with Pi or another extension; `Ctrl+F` is already File Context's internal search-mode toggle.
Pi reserves `Ctrl+X` for `app.message.copy` by default, so remap that built-in action before assigning `Ctrl+X` to File Context.
Explicit `F8` and `Ctrl+Alt+F` values remain supported, but the default is now `Ctrl+Shift+X`.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/file-context` | Select and review file context for the next prompt, or change settings. |
| `/file-context browse` | Scan and open the file explorer directly. |
| `/file-context remove` | Review selected context through the compatibility route; it does not delete files. |

All routes require TUI mode and reject unknown or trailing arguments.
RPC reports the TUI requirement; print and JSON modes reject the command before opening UI.
See [Security and privacy](#-security-and-privacy) before sending selected file content.

## 🔒 Security and privacy

- Extensions run with the user's full permissions; install only trusted code.
- File paths and symlink targets are checked against the real project root before reading.
- External editing accepts only a canonical project-contained regular worktree file, rejects a final symlink, and serializes the full editing period with Pi's file mutation queue.
- The configured external editor runs with the user's full permissions and may modify other files or access external services according to that program's behavior.
- Preview files are limited to 1 MB and NUL-containing files are treated as binary.
- Discovery is limited to 5,000 files, skips symlinks, and prioritizes shallow files before deeper files.
- File-name and content-search queries are limited to 256 characters.
  Content search returns at most 100 cards and reports truncation and unreadable, oversized, or binary files as skipped.
- Content search uses the same 5,000-file, 1 MB-per-file, real-project-path, and no-symlink boundaries as preview loading.
  Superseded searches and file opens are cancelled.
- Terminal control characters are escaped before file names, Git refs, authors, summaries, search context, or file contents are rendered.
- Git is invoked read-only without a shell, pager, external diff, or text conversion; commands time out after 5 seconds and output is bounded to 1.1 MB.
- Revision names are resolved to a commit before file loading.
  Historical files remain subject to the 1 MB and binary guards.
- Blame shows the author name but not author email.
  Commit summaries and diffs can still contain sensitive project text; inspect selections before attachment.
- Each snippet stores the text visible at selection time.
  It does not silently reread changed content when the prompt is submitted.
- A snippet is limited to 500 lines and 50 KB.
  At most eight selected snippets and 100 KB of aggregate context text are accepted.

## 🚧 Limitations

- Keyboard line selection only; mouse drag selection is not implemented.
- External editing is available only from a current worktree File Preview, not from historical revisions, Git diffs, history lists, revision input, file lists, or search results.
- On Windows, File Context rejects editor target paths containing command-shell metacharacters instead of passing an unsafe path through Pi's shell-compatible editor launch.
- Up to eight selected snippets; exact review and repeated removal are supported, but there are not yet bulk clear, undo, or reorder actions.
- Selected context does not survive `/reload`, session replacement, or shutdown.
- The configurable shortcut is registered without replacing another extension's custom editor; `/file-context` remains available if the shortcut is disabled or conflicts.
- File discovery uses a small built-in ignore list rather than `.gitignore` semantics.
- Content search scans discovered files natively and sequentially; large projects or queries with no matches may take longer than indexed or external search tools.
- Fuzzy content search matches query characters in order on one line; it is not semantic search and does not cross line boundaries.
- Git integration degrades to the original filesystem-only workflow outside a repository or when Git metadata cannot be read.
- File history is limited to the 20 most recent commits.
  Untracked files have status and provenance but no HEAD diff hunk until Git tracks them.

## 🗂️ Package layout

```text
packages/pi-file-context/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── file-context.ts                # Context selection and prompt attachment
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, file explorer, source quote, line selection, coding agent, terminal UI.

## 📄 License

[MIT](LICENSE)
