# File context reference

Pi Files retains the File Context explorer and immutable snapshot workflow. Start with the [README](../README.md) for installation and the shared manager. Browsing, quoting, whole-file references, review, and removal never grant edit permission.

## Browser workflow

1. Run `/files` and open context browsing, or use `/files browse`, `/file-context browse`, or the configured shortcut. `/file-context` keeps the dedicated context manager and its **Add context snippet** action. Every browser route starts the same cancellable project scan.
2. Use Up/Down to select an immediate child folder or file, then Enter to open it. When the search field is empty, Escape, Left, or Backspace returns to the parent folder. Type to fuzzy-search file names across discovered folders in relevance order. Tab on a file inserts a normal whole-file `@path` reference; Enter opens its quote preview.
3. Ctrl+F switches between file-name and content search. Content search is literal and case-insensitive by default. Alt+C toggles case sensitivity; Alt+F toggles ordered fuzzy matching. The current states stay visible above results.
4. Content results are highlighted path-and-line cards. Up/Down selects a card, Tab inserts a whole-file reference, and Enter previews the file at the matching line. Escape from preview restores the query, selected result, and scroll position.
5. In preview, Space anchors a selection; Up/Down extends the range. Enter queues the snapshot and closes. The `a` action queues it and returns to the originating folder or results so browsing can continue. The adaptive footer shows selection, capacity, navigation, Git actions, external editing, and `?` help.
6. Use Pi's `app.editor.external` action (default Ctrl+G) to edit the current worktree file. See [External editing](#external-editing) before use.
7. Press `?` in preview to review actions. In a Git worktree, `[`/`]` selects changed hunks, `b` shows current-line blame, `h` opens file history, `r` opens a commit/branch/tag, and `d` reviews and adds explicit diff context. Historical previews are read-only.
8. Open context review through `/files` or `/file-context` → **Review selected context**. Enter opens the exact snapshot before offering **Remove from next prompt**. `/file-context remove` is the compatibility review route; it does not delete files. Submit the question normally to attach queued snippets once, in order, then clear the queue.

The explorer and the scope checked-file picker are separate components. In the explorer, Tab inserts a whole-file reference; it does not check an allowed edit target. No action both queues context and authorizes editing.

## Cancellation and queue lifetime

Escape returns from a preview to its originating folder or results. With an empty file-search field, Escape from a nested folder returns to its parent. A menu-opened browser returns to its menu at the root; a direct browser route cancels there. Ctrl+C closes the flow. Either cancel key stops project scanning; cancellation does not open a stale explorer.

Review cancellation does not remove snapshots. Each queued snippet retains the text visible when selected; submission does not silently reread changed files. The next ordinary prompt consumes all queued snippets together. Extension-triggered custom turns do not consume them.

The queue is session-owned and in memory. It does not survive `/reload`, session replacement, or shutdown. Same-session tree navigation does not apply a blanket queue reset. Scope restoration has a separate branch-owned lifetime. Starting, replacing, or ending scope does not clear context; selecting or attaching context does not change scope.

## Quote format and Git provenance

The agent receives explicit blocks such as:

```xml
<user_file_quote path="src/runtime.ts" lines="12-18" git_head="a1b2c3d4..." git_branch="main" git_status="modified (unstaged)" git_blob="e5f6..." content_sha256="9abc..." source="worktree" git_base="HEAD">
selected content
</user_file_quote>
```

Non-Git quotes retain their original `path` and `lines` attributes. Git quotes add ordered optional provenance: HEAD at selection time, branch, file status, revision or baseline, tracked blob when available, source (`worktree`, `revision`, or `git_diff`), and SHA-256 of the exact attached text. HEAD alone does not identify uncommitted content; `content_sha256` identifies the snapshot. The session message identity remains `file-context-quotes`.

Token counts use `ceil(UTF-8 bytes / 4)`. They are deterministic estimates, not provider billing predictions. Diff context is never attached automatically. Git failures fall back to filesystem-only browsing where possible. File history shows up to 20 recent commits. Untracked files have status and provenance but no HEAD diff hunk until tracked.

## External editing

External editing is a user-controlled operation **outside the native-tool scope guard**. The editor runs with user permissions and may modify other files or access external services. An active scope neither authorizes nor contains it.

The action requires project trust and a canonical, project-contained regular worktree file. It rejects a final symlink. Pi's file mutation queue covers the complete editor lifetime. Pi Files pauses its TUI, waits for editor exit, restores the terminal, then reloads bounded text and Git state. A reload failure stays visible in preview. Cancellation and disposal cancel owned work; filesystem operations already in progress must settle before cleanup completes.

Only a current worktree File Preview exposes this action. Historical revisions, Git diffs, history lists, revision input, file lists, and search results do not. Historical text is never written over the current worktree by this action.

Pi's effective `app.editor.external` keybinding and `externalEditor` setting are authoritative. Configure them in Pi's `keybindings.json` and `settings.json`, not an extension file. A remapped action takes priority over additive preview letter shortcuts, and the old Ctrl+G is not retained. Use a wait option such as `code --wait` when an editor would otherwise return before editing ends.

On Windows, editor targets containing command-shell metacharacters are rejected rather than passed to Pi's shell-compatible editor launch.

## Settings

The optional user store is `<getAgentDir()>/pi-file-context.json`, normally `~/.pi/agent/pi-file-context.json`:

```json
{
  "openShortcut": "ctrl+shift+x"
}
```

`openShortcut` accepts a valid Pi key identifier or `null` to disable the shortcut. Strings are trimmed and normalized to lowercase. Recognized modifiers are `ctrl`, `shift`, `alt`, and `super`, without duplicates. Supported bases include letters, digits, punctuation, standard navigation/editing keys, and unmodified F1–F12. Examples include `ctrl+shift+x`, `f8`, and `ctrl+alt+f`; modified function-key strings are not accepted by this validator. Use `/files browse` when the shortcut is disabled.

Effective settings use defaults followed by recognized user fields. There are no project overrides or extension-specific environment variables. The retained basename is a deliberate compatibility exception; there is no `pi-files.json` or filename migration.

Open `/files` → **Settings** → **Open shortcut** to save. Registration requires reload, so only this action is blocked while snippets are queued. The common settings screen remains available for the immediate hidden-file preference. The dedicated `/file-context` manager retains its original shortcut-only settings route, which is unavailable while context is queued. A successful shortcut save reloads Pi automatically. If reload fails after saving, the file stays saved; run `/reload` to apply it. Manual JSON changes also require `/reload`.

The default Ctrl+Shift+X requires Kitty keyboard protocol or modifyOtherKeys to distinguish it from Ctrl+X. Use F8 if the terminal cannot do so. Choose a key that does not conflict with Pi or another extension. Ctrl+F is the explorer's search-mode toggle; Pi reserves Ctrl+X for `app.message.copy` by default, so remap that action before assigning Ctrl+X here. The extension does not replace another extension's custom editor.

Missing settings use the default without creating a file or parent directory. Invalid JSON, invalid values, oversized files, and unsupported file types produce a warning, leave the source unchanged, and use the default on load. Repair the file and reload before saving; the affected shortcut settings remain read-only until then. The document must be a UTF-8 JSON object no larger than 64 KiB. Settings-file symlinks are unsupported.

Saves read the latest valid document, preserve unknown fields, and publish a same-directory temporary file by rename with private permissions. Saves run in request order within one Pi process; reads await preceding writes, and shutdown drains them. A failed save leaves the previous effective shortcut and file intact. This is not cross-process coordination. Settings failure never releases scope or discards queued context.

## Security and data limits

Only trusted extensions should be loaded. Paths and canonical targets are checked against the real project root before reading. Discovery skips symlinks and common generated directories, visits shallow files before deeper ones, and stops at 5,000 files. It uses a built-in ignore list, not `.gitignore`. This bounded inventory must not be used as a complete scope authorization inventory.

| Item | Limit or behavior |
| --- | --- |
| Preview and searched file | 1,000,000 bytes; NUL-containing files are treated as binary |
| File-name or content-search query | 256 characters |
| Content-search cards | 100; truncation and unreadable, oversized, or binary skips are reported |
| One snapshot | 500 lines and 50,000 bytes |
| Queued snapshots | Eight, with 100,000 aggregate text bytes |
| Git command | Five-second timeout and 1,100,000-byte output bound |

Content search uses the same discovery, size, canonical-project-path, and no-symlink boundaries as preview loading. Searches and file opens are cancelled when replaced. Search scans discovered files natively and sequentially, so large projects and no-match queries can be slower than indexed or external tools. Fuzzy content search matches characters in order on one line; it is not semantic or multiline search.

Terminal controls are escaped before paths, Git refs, authors, summaries, search context, or content are displayed; raw snapshot payloads are not changed for display. Git runs read-only without a shell, pager, external diff, or text conversion. Refs resolve to a commit before loading; historical files have the same size and binary guards. Blame includes author names, not email. Commit summaries, diffs, and file text can contain sensitive data; inspect them before sending to a model.

Line selection is keyboard-only; mouse drag selection is not implemented. Exact review and repeated removal are supported, but bulk clear, undo, and reorder are not.
