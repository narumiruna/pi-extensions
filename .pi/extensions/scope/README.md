# 🗂️ Scope

Temporarily limit Pi's `write` and `edit` tool calls to files selected by the user. Other files remain readable. The restriction stays active until the user ends it.

**This is an in-process guard, not an OS sandbox.** Extensions run with Pi's operating-system permissions. Load only trusted code, and read the [protection boundary](#protection-boundary) before use.

## Load

This is a repository-local extension, not an npm package. Pi discovers `index.ts` after the project is trusted. That source location does not limit selection to this repository or cwd. It uses the public Pi and Kit APIs supplied by this repository.

For an isolated load, run these commands from the repository root:

```sh
npm install
npm run build
pi --no-extensions -e ./.pi/extensions/scope/index.ts
```

Use the repository's resolved dependencies. No root Pi manifest entry, workspace, or separate installation is required.

## Quick start

1. Run `/scope`, then choose **Select files…**.
2. Type to filter. Confirm a file row to toggle it, then confirm **Start restriction**.
3. Edit the selected files. Run `/scope off` before work that needs unrestricted tools, such as a test command or formatter.

The widget shows the selected-file count, a short path summary, and the exit command. Status lists every target, including reserved paths, and explains deferred creation.

## Commands

| Route | Result |
| --- | --- |
| `/scope` | Open the current-state manager to select or replace files, reserve one new file, change the picker preference, or read Status and Help. |
| `/scope off` | Explicitly end the restriction and return to the prompt. |

Both routes require TUI mode, an idle agent, and no pending messages. Unknown or trailing arguments are rejected. RPC, print, and JSON commands fail before custom UI opens; restored tool enforcement works in all modes. Pi reports command errors through RPC `extension_error` events or CLI stderr. A handled command error does not imply a nonzero process exit code.

Successful activation, replacement, or exit returns to the prompt. Closing the manager, cancelling a selection, pressing Escape or Ctrl+C, interrupting work, or ending an agent run does **not** end an applied restriction. An empty selection leaves it unchanged. Reapplying the same lexical paths and canonical targets is a no-op.

## File selection

Discovery starts at `ctx.cwd`, not the Git root. It skips symlink entries and these exact directory names at every depth:

```text
.git  .hg  .svn  node_modules  .venv  venv  __pycache__
build  coverage  dist  target  .next
```

It does not read `.gitignore`. Scan errors and work limits fail the scan instead of showing a partial inventory. Current targets appear first and remain available even when hidden, excluded, outside cwd, or not yet created. Filtering and checkboxes change only the picker draft until completion.

To add an existing file outside the inventory, enter a path in the same field, then confirm **Add file**:

```text
~/src/another_project/AGENTS.md
~/.plan/PLAN_A.md
/absolute/path/PLAN_B.md
~/.config/atuin/config.toml
```

Path input containing `/` (or `\` on Windows) puts **Add file** first instead of treating confirmation as Apply. Absolute, home, file-URL, and cwd-relative forms are accepted; use `./` for a relative filename. The lookup runs only when that action is confirmed, not while typing.

A successful add checks and focuses the resolved path, shows outside-cwd and canonical details, and clears the field for the next path. Earlier checks remain selected. Repeat for more files, then confirm **Start restriction** or **Apply changes**. Clear the field to return to ordinary search without adding it. Missing paths, directories, hard links, and invalid input retain the draft and show an error. These actions create no file or parent directory; existing-file and canonical checks run again before apply.

**New file…** replaces the entire scope with one target after a target review. Relative paths use cwd. Existing targets are rejected without discarding the input draft. Selection only reserves the path: the first normal `write` creates the file and required parent directories. Opening or cancelling this flow creates no target content.

Target resolution follows native `write` and `edit` behavior for dot segments, leading `@`, `~`, file URLs, and Unicode whitespace. Exact unusual filenames use file URLs; model notices supply these URLs. Displayed paths are escaped without changing the raw target. The new-file review marks redirected canonical targets and outside-cwd paths explicitly.

## Tool policy

While restricted:

| Stock tool | Behavior |
| --- | --- |
| `read`, `ls`, `find`, `grep` | Remain available for unselected files. |
| `write`, `edit` | Require an exact selected canonical target. |
| `bash`, `powershell` | Blocked; arbitrary shell commands cannot be proved read-only. |
| `codemode`, `tool_search`, custom or delegation tools | Blocked, including tools with `readOnlyHint`. |

Only recognized, unmodified native tools are accepted. Replacements do not become trusted because their names match. At least one stock direct writer must be active. `codemode.mode=only` with active codemode is unsupported: Scope refuses activation or enters a blocked state on restore or at the next request after a loadout change. It does not activate tools or change core settings to work around that configuration.

Native nested tool calls use the same guard, but this does not make an opaque parent tool safe. Codemode also has model, image, and temporary-artifact paths outside nested tool calls, so it is not accepted as a generic router.

## State and recovery

Versioned snapshots belong to the active session branch, not to settings. Reload, resume, fork, and tree navigation restore that branch's last snapshot. A new session without a snapshot starts inactive. Compaction does not release the restriction.

Each mutation rechecks the selected reservation and the candidate target. Missing paths use the nearest existing parent plus the missing suffix. A changed symlink cannot expand the approved set. Nonregular mutation targets and files with multiple hard links are rejected, even if a hard-link alias is selected.

Uninitialized, invalid, uncertain, or unsupported restored state blocks edits. Use `/scope` to repair the set or `/scope off` to end it. A broken selected alias can be removed from the draft and replaced with its real path; that changes the saved reservation even when the canonical target is unchanged. A failed settings save never ends the restriction.

Activation, replacement, and exit append a fixed model notice without starting a turn. If the notice is missing or compacted away, the full-system context hook restores it once at a persisted boundary. Later requests retain that boundary, including deferred publication and historical notices after exit. Native prompt and tool-delta messages keep their original positions. Scope does not replace built-in tools, change tool order, or rewrite the leading prompt.

## Settings

The only preference is **Show hidden files**, default `false`, at:

```text
<getAgentDir()>/pi-scope.json
```

```json
{
  "showHiddenFiles": false
}
```

Edit it through `/scope` → **Settings**, or edit the JSON and reload. Only boolean values are accepted. UI changes take effect and save immediately; Back does not undo them. Settings reload on session start and tree navigation. There are no project overrides, extension-specific environment variables, policy switches, or saved file groups.

Missing-file reads create nothing. Saves preserve unknown fields, read the latest valid document, and publish with a same-directory temporary file plus rename. Failures keep the previous effective value and file. Repair malformed JSON before saving; it is not replaced with defaults. A settings-file symlink is unsupported.

Reads, saves, and teardown are ordered in-process for the same absolute lexical settings path. This is not a cross-process lock and does not coordinate different aliases of a parent directory.

## Protection boundary

The supported boundary is stock Pi CLI tool implementations with trusted extensions. Public source metadata cannot attest to arbitrary SDK `baseToolsOverride` implementations or custom `prepareLoadout` behavior. Those embeddings are unsupported.

Selected paths and canonical redirects enter the model notice. Selecting a file does not load its contents or change Pi's context selection.

Scope does not contain user-issued `!` commands or RPC shell commands, existing background processes, trusted extension code, later argument-mutating handlers, other programs, or filesystem changes between validation and the native operation. Pi's own session, settings, cache, and artifact writes are not target-file editing calls. Scope does not grant permissions or override another guard.

The native file tools retain their own mutation queue and cancellation behavior. Filesystem calls already in progress must settle before their owning flow can finish cleanup.

## Internal limits

These are fixed safety limits, not settings:

| Item | Limit |
| --- | --- |
| Discovered files | 5,000 |
| Visited directory entries | 20,000, including hidden or excluded names encountered |
| Directory depth | 64 below cwd; cwd is depth zero |
| Selected entries | 100 before canonical deduplication |
| Distinct manually added paths | 100 per picker, including entries later unchecked |
| Serialized scope snapshot | 24,000 bytes |
| Model notice | 48,000 bytes |

## Verification

Run checks sequentially from the repository root; root checks rebuild Kit before consumer tests:

```sh
npm run check
npm test
npm exec -- tsc -p .pi/extensions/scope/tsconfig.json
npm exec -- vitest run --config .pi/extensions/scope/vitest.config.ts
node .pi/extensions/scope/test/runtime-smoke.mjs
```

Local tests are not wired into the root test runner. See [verification and terminal handoff](verification.md) for the audited boundaries, compatibility decisions, and the remaining physical-terminal checks.

## Source layout

`index.ts` forwards to `scope-extension.ts`, which owns lifecycle, commands, enforcement, and publication. The path, state, contract, discovery, and settings modules own their respective policies. `menu.ts`, `picker.ts`, `input.ts`, and `display.ts` own UI behavior. Tests and runtime smoke support stay under `test/`.
