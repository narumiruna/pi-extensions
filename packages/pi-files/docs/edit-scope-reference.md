# Edit scope reference

Pi Files retains the checked-file picker and native-tool guard from Edit Scope. Start with the [README](../README.md) for installation and the shared manager. Allowed edit targets and queued context are independent: permission changes do not load file contents or clear context.

## Manager and command behavior

Open scope management through `/files`, or use the dedicated `/edit-scope` manager (`/scope` is an identical compatibility alias). Select or replace targets, reserve one new file, change discovery preferences, or read the complete Status list and Help. `/files off`, `/edit-scope off`, and `/scope off` explicitly end the same restriction without consuming queued context.

Scope commands and permission changes require TUI mode, an idle agent, and no pending messages. Unknown or trailing arguments are rejected. RPC, print, and JSON commands fail before custom UI; restored tool enforcement works in all modes. Pi reports command errors through RPC `extension_error` events or CLI stderr. A handled command error does not imply a nonzero process exit code.

Successful activation, replacement, or exit returns to the prompt. Closing a manager, cancelling selection, Escape, Ctrl+C, interrupting work, or ending an agent run does **not** end an applied restriction. An empty selection leaves it unchanged. Reapplying the same lexical paths and canonical targets is a no-op.

The combined widget shows context and restriction separately, including active or blocked scope and its exit command. Scope Status lists every target, including reserved paths, and explains deferred creation.

## File selection

Discovery starts at cwd, not the Git root. It scans breadth-first, completes each directory level before the next, and keeps only one directory handle open at a time. The completed inventory is sorted by absolute path. It skips symlink entries, nonregular files, and these exact directory names at every depth:

```text
.git  .hg  .svn  node_modules  .venv  venv  __pycache__
build  coverage  dist  target  .next
```

Discovery does not read `.gitignore`. Scan errors and work limits fail the scan instead of showing a partial inventory. Use a narrower cwd when the scan exceeds its limits. Current targets appear first and remain available even when hidden, excluded, outside cwd, or not yet created. Filtering and checks change only the draft until explicit apply.

The list contains files only. The fzf-inspired interaction uses Pi's native fuzzy search, including whitespace and directory fragments; typing never adds a path. Default keys are Tab to toggle and move down, Shift+Tab to toggle and move up, arrows to move only, and Enter to apply checks. Marking stops at the first or last match; arrow navigation still wraps. Repeated marking at a boundary toggles the same file, and marking with no match does nothing. An empty checked set stays open with an explanation; it neither selects the highlight nor ends a restriction. Space is search text under default bindings.

Project labels are cwd-relative. Ordinary names are unquoted; ambiguous whitespace and escaped identities stay quoted. External paths remain absolute with an `(outside)` marker. **Full paths**, using Pi's `app.session.togglePath` binding (default Ctrl+P), changes only the view and resets when the picker closes. Query, cursor, raw absolute IDs, checks, and canonical validation remain unchanged. A clipped selected label gets an exact Path preview; canonical redirects retain their own detail.

### Add an existing target

Use **Add file…** to enter an external, hidden, or excluded file in a separate field. The default key is Ctrl+O, with Alt+O as the fallback if native selection, editing, or host input reserves Ctrl+O. If both conflict, no key is advertised; the fullscreen button remains available.

Accepted forms include absolute, home, file URL, and cwd-relative paths, including bare relative filenames:

```text
~/src/another_project/AGENTS.md
~/.plan/PLAN_A.md
/absolute/path/PLAN_B.md
~/.config/atuin/config.toml
```

The configured Input submit key (default Enter) starts lookup; typing does not. Search text is never reinterpreted as a path. A successful add checks the resolved path, clears only the path field, and returns to the list with search and earlier checks intact. It focuses the added file if it matches the query; otherwise the matching highlight stays and an Added status appears. Repeat, then apply with the configured selection-confirm key (default Enter) or **Start restriction** / **Apply changes**. There is no function-key completion accelerator or completion row.

Missing paths, directories, hard links, and invalid input retain the field and draft with an error. Back (default Escape) returns to search without changing checks. During lookup, Back aborts only that lookup and prevents new work until it drains. Cancelling the file list abandons the draft, not the applied restriction. No selection action creates content or parent directories.

Manually added files must still exist at selection completion and final commit. Normalized duplicates are idempotent. Canonical aliases are deduplicated, without removing the existing-file requirement. Previously approved missing reservations remain valid. Existing-file and canonical checks run again before apply.

### Reserve a new target

**New file…** / **Use only a new file…** replaces the complete allowed-file set with one reviewed target. Relative input uses cwd. Existing targets are rejected without discarding the input draft. Review marks both canonical redirects and outside-cwd lexical or canonical paths. Selection only reserves the target: the first normal stock `write` creates the file and required parents. Opening or cancelling this flow creates no target content.

Target resolution follows native `write` and `edit` behavior for dot segments, leading `@`, `~`, file URLs, and Unicode whitespace. Exact unusual filenames use file URLs, which model notices supply. Escaped display labels do not change raw targets. Read-only macOS filename fallbacks do not apply to mutation targets.

## Target validation and recovery

Version-1 snapshots belong to the active session branch, not settings. Reload, resume, fork, and tree navigation restore that branch's last snapshot. A new session without a snapshot starts inactive. Compaction does not release the restriction.

Each mutation freshly rechecks both the selected reservation and candidate. A missing path resolves through its nearest existing parent plus the missing suffix. A changed symlink cannot expand the approved set. Nonregular targets and files with multiple hard links are rejected even if a hard-link alias was selected. A dangling symlink is not a missing target that `write` may create. Metadata or access errors also do not mean a path is missing.

Uninitialized, invalid, uncertain, or unsupported restored state blocks edits. Repair the allowed set through `/files` or the dedicated scope manager, or explicitly end it with `/files off`. A broken selected alias can be removed and replaced with its real path; this changes the saved reservation even when the canonical target is unchanged. Do not delete settings or session entries to force unrestricted recovery. These checks do not provide race-free containment against other processes.

## Fixed limits

These are safety limits, not settings:

| Item | Limit |
| --- | --- |
| Discovered files | 5,000 |
| Visited directory entries | 20,000, including hidden or excluded names encountered |
| Directory depth | 64 below cwd; cwd is depth zero |
| Selected entries | 100 before canonical deduplication |
| Distinct manually added paths | 100 per picker, including later-unchecked entries |
| Serialized scope snapshot | 24,000 bytes |
| Model notice | 48,000 bytes |

Unlike the bounded context browser, scope never treats a truncated inventory as complete authorization input.

## Settings and persistence

The user store is `<getAgentDir()>/pi-scope.json`, normally `~/.pi/agent/pi-scope.json`:

```json
{
  "showHiddenFiles": false
}
```

`showHiddenFiles` accepts a boolean and defaults to `false`. Effective settings use defaults followed by recognized user fields. It changes scope discovery, not context discovery or the active restriction. Open `/files` → **Settings** or the dedicated `/edit-scope` → **Settings** route. UI changes apply and save immediately without reload; Back or Escape does not undo a save. This preference remains editable while context is queued in the common settings screen. Manual file changes require reload. Settings reload on session start and tree navigation.

There are no project overrides, extension-specific environment variables, policy switches, or saved file groups. The retained `pi-scope.json` basename is a deliberate compatibility exception. There is no filename migration; neither `pi-edit-scope.json` nor `pi-files.json` is read.

Missing-file reads create nothing. The top level must be a JSON object. Malformed JSON or an invalid owned field produces an error and leaves the prior effective value intact; repair the file before saving. Invalid content is not replaced with defaults. Settings-file symlinks and nonregular files are unsupported.

Saves read the latest valid document, preserve unknown fields, and publish a same-directory temporary file by rename. First creation uses private permissions; replacement retains the existing file's permissions. Effective state changes only after publication succeeds. A failed save preserves the previous effective value and file and never ends the restriction.

Reads, saves, and teardown are ordered within a Pi process for the same absolute lexical path, including first creation and replacement. A failed operation does not prevent later reads or saves. Teardown drains preceding preference operations. This is not a cross-process lock and does not coordinate aliases of a parent directory. Native target mutations retain Pi's own queue.

## Protection boundary

The supported boundary is stock Pi CLI tool implementations with trusted extensions. Public source metadata cannot attest to arbitrary SDK `baseToolsOverride` or custom `prepareLoadout` implementations; those embeddings are unsupported. The guard is in-process, not an OS sandbox, and does not grant permissions or override another guard.

While restricted:

| Stock tool | Behavior |
| --- | --- |
| `read`, `ls`, `find`, `grep` | Available for unselected files |
| `write`, `edit` | Require an exact, freshly validated selected canonical target |
| `bash`, `powershell` | Blocked; arbitrary shell commands cannot be proved read-only |
| `codemode`, `tool_search`, custom or delegation tools | Blocked, including tools with `readOnlyHint` |

Only recognized, unmodified native tools are accepted. A replacement is not trusted because its name matches. At least one stock direct writer must be active. Active native `codemode.mode=only` is unsupported: activation is refused, or scope becomes blocked on restore or the next request after a loadout change. Pi Files does not activate tools or change core settings to work around the configuration.

Native nested tool calls use the same guard, but this does not make an opaque parent safe. Codemode also has model, image, and temporary-artifact paths outside nested tool calls; it is not accepted as a generic router.

Selected paths and canonical redirects enter the model notice; selection does not load their contents. The guard does not contain user-issued `!` commands, RPC shell commands, existing background processes, trusted extension code, later argument-mutating handlers, other programs, or filesystem changes between validation and the native operation. Pi's own session, settings, cache, and artifact writes are not target-file editing calls. The user-controlled [external editor](file-context-reference.md#external-editing) remains outside the guard.

## Session and model-contract compatibility

The persisted identities remain `scope-state`, `scope-contract`, and `scope-context-anchor`, with snapshot version 1 and original session entry IDs. `src/scope/state.ts` owns snapshots; `src/scope/contracts.ts` owns notices and anchors. Historical notice bytes retain the `Scope` name and `/scope` instructions. Rebranding those bytes would invalidate saved prefix digests. See [migration](migration.md) before changing resources or restoring a predecessor.

Scope adds no tools and changes no active tool definitions, snippets, guidelines, or leading system prompt. Explicit activation, changed reservation, or exit appends a fixed model notice without starting a turn. Reapplying an identical reservation is a no-op. Ordinary requests preserve the existing serialized model-visible prefix.

When a required notice is absent or compacted away, recovery appends one deterministic tail contract and persists a non-model prefix anchor. Ordinary requests reuse that boundary; deferred publication retains its first-seen boundary rather than moving past newer output. Historical contracts remain ordered after replacement or exit. Original entry IDs, state IDs, and old anchors without a recovery sequence remain valid. A repeated logical contract can have a distinct recovery sequence without erasing earlier history. Uncertain state or anchor publication must not open the guard.

## UI compatibility and cancellation

Scope's interactive screens retain full-width bottom overlays in regular and fullscreen TUI modes. This deliberately differs from editor-area dialogs: Pi does not expose allocated dock height, and an editor child can be clipped by widgets or footers. Overlays can cover those components temporarily but do not remove them. Only the owned overlay closes; unrelated overlays keep their ownership and position. The common settings screen follows Pi's `SettingsList` pattern.

The dedicated selector keeps in-place validation, a live count, exact path previews, separate Add input, and the checked draft after failure. Action buttons stay outside the file list and support fullscreen clicks. Very short screens prioritize the focused file, search field, and reachable primary hints. Read-only reviews have no activatable cursor. Configured selection and editing actions take priority over additive shortcuts. Hints advertise only usable keys; invalid strings are not repaired. Earlier consuming input listeners, transcript search, debug actions, and another focused overlay keep native priority.

Ctrl+C remains hard cancel outside paste. Input retains native editing, undo-before-submit, Backspace, cursor, and submission behavior. Whole or fragmented bracketed paste cannot toggle, apply, add, change views, or cancel. A paste retains its original input owner across panel changes; pending validation discards pasted input. Pointer actions are blocked during paste.

File clicks retain the originally pressed raw file ID if scrolling or canonical detail changes layout. Query, panel, and resize changes cancel unfinished gestures. Display masking preserves input and mouse geometry without changing the submitted raw path. Paths and drafts are untrusted terminal input and are escaped at display boundaries.

Scanning, lookup, and validation disable new work. Cancellation, disposal, session replacement, and shutdown abort owned tasks and drain in-progress operations. Final apply rechecks idle state, revision, ownership, canonical targets, and usable loadout. Cancelling a flow never releases an applied restriction. Filesystem calls already in progress must settle before cleanup completes; no detached I/O is implied.

## Verification limits

The moved suites exercise native path behavior, the Pi loader and tool pipeline, cancellation, settings failures, input/paste, and model-prefix compatibility. Test presence or predecessor results are not new merge evidence. Current results and remaining checks belong in [verification](verification.md).

Deterministic tests do not prove physical key delivery, IME placement, terminal usability, live-provider behavior, or untested operating systems. The physical-terminal and interactive `/reload` handoff remains separate from offline loader checks. Do not issue built-in `/reload` as an RPC prompt command: it can become model input rather than safely reload the runner.
