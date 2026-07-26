# 🗂️ pi-file-context

[![npm](https://img.shields.io/npm/v/@narumitw/pi-file-context)](https://www.npmjs.com/package/@narumitw/pi-file-context)
[![Pi Extension](https://img.shields.io/badge/Pi-extension-blue)](https://github.com/earendil-works/pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> [!WARNING]
> This extension is experimental. Its interaction model and package API may change between releases.

Browse project files inside Pi, preview text, select a line range, and attach the exact snapshot to the next prompt.

## ✨ Features

- Adds a **Quote selected lines…** action to Pi's built-in `@` autocomplete without replacing the editor or immediately taking over the screen.
- Provides `/file-context` as a discoverable direct route to the explorer.
- Fuzzy-searches project files with typo tolerance and relevance ranking, preserves normal whole-file `@path` references, and previews bounded text files with line numbers.
- Shows textual staged, unstaged, untracked, ignored, and conflict status plus branch, HEAD, and dirty state when Git is available.
- Selects a contiguous line range or changed hunk without using the system clipboard and shows a deterministic token estimate before attachment.
- Discloses current-line blame and bounded file history, opens a validated commit/branch/tag version, and attaches explicit Git diff hunks.
- Accumulates selected ranges in one compact pending-quote widget and injects every snapshot into the next ordinary interactive prompt.
- Skips common dependency, VCS, build, and coverage directories and does not follow symlinks during discovery.

## 📦 Install

Install persistently from npm:

```bash
pi install npm:@narumitw/pi-file-context
```

Try from npm without installing permanently:

```bash
pi -e npm:@narumitw/pi-file-context
```

Try the local working tree from this repository checkout:

```bash
pi -e ./experimental/pi-file-context
```

## 🚀 Quick start

1. Type `@` at the start of a word in Pi's editor. Pi keeps the character in your draft and shows its normal inline autocomplete with **Quote selected lines…** added.
2. Choose **Quote selected lines…** to open the explorer. To enter a literal `@`, dismiss autocomplete with `Escape` and continue normally. Pi's built-in file suggestions still insert normal whole-file `@path` references.
3. In the explorer, type to fuzzy-search files in relevance order and use `Up`/`Down` to navigate. Press `Tab` to insert a normal whole-file `@path` reference, or `Enter` to preview a file for quoting.
4. In the preview, move to the first line and press `Space` to anchor the selection.
5. Extend the range with `Up`/`Down`, then press `Enter` to attach it. Without an anchor, `Enter` attaches the cursor line.
6. In a Git worktree, use `[`/`]` to select changed hunks, `b` for current-line blame, `h` for file history, `r` to open a commit/branch/tag, or `d` to inspect and attach explicit diff context.
7. Repeat from `@` to attach more ranges from the same or different files.
8. Write the question and submit normally. All pending quotes are attached in selection order and then cleared together.

`Escape` returns from a preview to the file list; from the file list it cancels without changing the draft. `Ctrl+C` cancels from either view.

The agent receives an explicit block similar to:

```xml
<user_file_quote path="src/runtime.ts" lines="12-18" git_head="a1b2c3d4..." git_branch="main" git_status="modified (unstaged)" git_blob="e5f6..." content_sha256="9abc..." source="worktree" git_base="HEAD">
selected content
</user_file_quote>
```

Non-Git quotes retain the original `path` and `lines` attributes exactly. Git-backed quotes add ordered optional provenance: the repository HEAD at selection time, branch, file status, selected revision or baseline, tracked blob when available, source kind (`worktree`, `revision`, or `git_diff`), and SHA-256 of the exact attached text. HEAD alone does not identify uncommitted content; `content_sha256` identifies the actual snapshot.

Token counts are deterministic byte-based estimates (`ceil(UTF-8 bytes / 4)`), not provider billing guarantees. Diff context is never attached automatically.

## 💬 Commands

| Command | Mode | Description |
| --- | --- | --- |
| `/file-context` | TUI only | Open the file explorer. Arguments are rejected. |
| `/file-quote` | TUI only | Compatibility alias for `/file-context`. |

`/file-context` is the canonical command. Existing `/file-quote` usage remains supported as a compatibility alias. RPC receives an observable warning. JSON and print modes do not enter custom UI.

## 🔒 Security and limits

- Extensions run with the user's full permissions; install only trusted code.
- File paths and symlink targets are checked against the real project root before reading.
- Preview files are limited to 1 MB and NUL-containing files are treated as binary.
- Discovery is limited to 5,000 files and skips symlinks.
- Terminal control characters are escaped before file names, Git refs, authors, summaries, or file contents are rendered.
- Git is invoked read-only without a shell, pager, external diff, or text conversion; commands time out after 5 seconds and output is bounded to 1.1 MB.
- Revision names are resolved to a commit before file loading. Historical files remain subject to the 1 MB and binary guards.
- Blame shows the author name but not author email. Commit summaries and diffs can still contain sensitive project text; inspect selections before attachment.
- Each quote stores the text visible at selection time. It does not silently reread changed content when the prompt is submitted.
- A quote is limited to 500 lines and 50 KB. At most eight pending quotes and 100 KB of aggregate quote text are accepted.

## 🧪 Experimental limitations

- Keyboard line selection only; mouse drag selection is not implemented.
- Up to eight pending quotes; there is not yet an interactive remove/reorder action.
- Pending quotes do not survive `/reload`, session replacement, or shutdown.
- Custom editors receive the action only when they support Pi's autocomplete-provider interface; `/file-context` remains available otherwise.
- File discovery uses a small built-in ignore list rather than `.gitignore` semantics.
- Git integration degrades to the original filesystem-only workflow outside a repository or when Git metadata cannot be read.
- File history is limited to the 20 most recent commits. Untracked files have status and provenance but no HEAD diff hunk until Git tracks them.

## 🗂️ Package layout

```text
src/index.ts                 Thin Pi entrypoint
src/file-context.ts            Lifecycle, filesystem boundaries, quote injection
src/file-context-explorer.ts   File list, Git detail views, and line-range TUI
src/git-context.ts             Bounded read-only Git status, diff, blame, history, revisions

test/file-context.test.ts      Filesystem, prompt, lifecycle, and TUI tests
```

## 🔎 Keywords

Pi extension, file explorer, source quote, line selection, coding agent, terminal UI.

## 📄 License

[MIT](LICENSE)
