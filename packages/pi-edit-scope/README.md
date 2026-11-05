# 🗂️ pi-edit-scope — Limit File Edits

[![npm](https://img.shields.io/npm/v/@narumitw/pi-edit-scope)](https://www.npmjs.com/package/@narumitw/pi-edit-scope) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Limit Pi's native `write` and `edit` calls to files selected by the user. Other files remain readable. The restriction stays active until the user explicitly ends it.

## ✨ Features

- Select exact file targets, including hidden files and files outside cwd.
- Reserve a new file without creating content during selection.
- Review the complete allowed-file set and see its summary above the prompt.
- Restore branch-owned restrictions across reload, resume, fork, tree navigation, and compaction.

## 📦 Install

This source-loaded package is not published to npm. Use a local checkout; the npm badge identifies the package name, not an available registry installation.

**This is an in-process guard, not an OS sandbox.** Extensions run with Pi's operating-system permissions. Load only trusted code, and read the [protection boundary](#-security-and-privacy) before use.

From the repository root, install dependencies, build the workspace libraries, and try the package:

```sh
npm install
npm run build
pi -e ./packages/pi-edit-scope
```

Pi loads `./src/index.ts` directly, so this extension needs no package build. The root build supplies the built [Pi TUI Kit](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-tui-kit) dependency.

To register the same checkout for later sessions, run from the repository root:

```sh
pi install ./packages/pi-edit-scope
```

## 🚀 Quick start

1. Run `/edit-scope` to open **Edit Scope**, then choose **Select files…**.
2. Type to search. **Tab** toggles a file and moves down; **Shift+Tab** toggles and moves up. Marking stops at the first or last match. **↑/↓** only move. **Enter** applies the checked files; an empty selection stays open. **Escape** cancels without changing an applied restriction.
3. Edit the selected files. Run `/edit-scope off` before work that needs unrestricted tools, such as a test command or formatter.

Typing always searches, including spaces and directory fragments. Use **Add file…** (default **Ctrl+O**) to enter an existing external or excluded path in a separate field. **Enter** adds it to the checked draft, not the active restriction; the search and earlier checks remain. **Escape** returns from that field to the list.

Project files use readable cwd-relative labels. **Ctrl+P** or **Full paths** switches the view without changing the query or checks. External files keep full paths and an outside-cwd marker; unusual names retain escaped, quoted identities. This view choice resets when the picker closes.

These are default keys. The footer follows configured selection and editing keys. Add file uses **Alt+O** if Ctrl+O is reserved; conflicting hints are omitted. Action buttons support fullscreen clicks and stay outside the file list. Very short screens prioritize the focused file, search field, and primary key hints.

The widget shows the selected-file count, a short path summary, and the exit command. **Status** lists every target, including reserved paths, and explains deferred creation.

## 💬 Commands

| Route | Result |
| --- | --- |
| `/edit-scope` (compatibility alias: `/scope`) | Open the current-state manager to select or replace files, reserve one new file, change the picker preference, or read Status and Help. |
| `/edit-scope off` (compatibility alias: `/scope off`) | Explicitly end the restriction and return to the prompt. |

Both command names have the same behavior. All routes require TUI mode, an idle agent, and no pending messages. Unknown or trailing arguments are rejected. RPC, print, and JSON commands fail before custom UI opens; restored tool enforcement works in all modes. Pi reports command errors through RPC `extension_error` events or CLI stderr. A handled command error does not imply a nonzero process exit code.

Interactive screens use full-width bottom overlays in regular and fullscreen TUI modes. This is an intentional difference from editor-area dialogs: Pi does not expose their allocated height, and overlays prevent widgets and custom footers from clipping selection. They can cover those components while open but do not remove or change them. See [UI compatibility](./docs/verification.md#ui-compatibility-and-cancellation).

Successful activation, replacement, or exit returns to the prompt. Closing the manager, cancelling a selection, pressing Escape or Ctrl+C, interrupting work, or ending an agent run does **not** end an applied restriction. An empty selection leaves it unchanged. Reapplying the same lexical paths and canonical targets is a no-op.

**New file…** replaces the entire allowed-file set with one reviewed target; selection only reserves it. The first normal `write` creates the file and required parent directories. Opening or cancelling this flow creates no target content. See the [file-selection reference](./docs/verification.md#file-selection) for accepted path forms, discovery rules, validation, and draft behavior.

## ⚙️ Settings

Use `/edit-scope` → **Settings**, or edit the user file and reload:

```text
<getAgentDir()>/pi-scope.json
```

```json
{
  "showHiddenFiles": false
}
```

**Show hidden files** is the only preference. It accepts a boolean and defaults to `false`. It changes discovery, not the active restriction. UI changes apply and save immediately; Back does not undo them. Settings reload on session start and tree navigation. There are no project overrides, extension-specific environment variables, policy switches, or saved file groups.

The retained `pi-scope.json` basename is a compatibility exception to the package-name convention. There is no filename migration, and `pi-edit-scope.json` is not read.

Missing-file reads create nothing. Repair malformed or invalid JSON before saving; it is not replaced with defaults. Failed saves keep the previous effective value and file and never end the restriction. Settings-file symlinks are unsupported. See [settings persistence](./docs/verification.md#settings-persistence) for unknown-field preservation, atomic writes, and in-process ordering limits.

## 🔒 Security and privacy

The supported protection boundary is stock Pi CLI tool implementations with trusted extensions. Public source metadata cannot attest to arbitrary SDK `baseToolsOverride` implementations or custom `prepareLoadout` behavior. Those embeddings are unsupported.

While restricted:

| Stock tool | Behavior |
| --- | --- |
| `read`, `ls`, `find`, `grep` | Remain available for unselected files. |
| `write`, `edit` | Require an exact selected canonical target. |
| `bash`, `powershell` | Blocked; arbitrary shell commands cannot be proved read-only. |
| `codemode`, `tool_search`, custom or delegation tools | Blocked, including tools with `readOnlyHint`. |

Only recognized, unmodified native tools are accepted. Replacements do not become trusted because their names match. At least one stock direct writer must be active. `codemode.mode=only` with active codemode is unsupported: activation is refused, or the restriction enters a blocked state on restore or at the next request after a loadout change. The extension does not activate tools or change core settings to work around that configuration. See the [runtime boundary](./docs/verification.md#runtime-boundary) for nested-call and codemode limits.

Selected paths and canonical redirects enter the model notice. Selecting a file does not load its contents or change Pi's context selection.

The guard does not contain user-issued `!` commands or RPC shell commands, existing background processes, trusted extension code, later argument-mutating handlers, other programs, or filesystem changes between validation and the native operation. Pi's own session, settings, cache, and artifact writes are not target-file editing calls. The guard does not grant permissions or override another guard.

## 🚧 Limitations

Targets must be regular files without multiple hard links. A changed symlink cannot expand the approved set. Uninitialized, invalid, uncertain, or unsupported restored state blocks edits; use `/edit-scope` to repair the set or `/edit-scope off` to end it. See [target validation and recovery](./docs/verification.md#target-validation-and-recovery) for missing reservations and alias repair.

Discovery does not read `.gitignore`. Scan errors or [fixed work and payload limits](./docs/verification.md#fixed-limits) fail the operation rather than return a partial inventory. Use a narrower cwd when a scan exceeds its limits.

Native file tools retain their own mutation queue and cancellation behavior. Filesystem calls already in progress must settle before their owning flow can finish cleanup. Deterministic tests do not prove physical key delivery, IME placement, or terminal usability; remaining checks are in the [terminal handoff](./docs/verification.md#physical-terminal-handoff).

## 🗂️ Package layout

- `src/index.ts` is the thin Pi entrypoint; `src/edit-scope.ts` owns lifecycle, commands, enforcement, and publication.
- Other `src/` modules own target resolution, state, model contracts, discovery, settings, and UI behavior.
- `docs/verification.md` contains the detailed behavior reference, developer compatibility rules, historical evidence, and migration handoff.
- `test/` contains repository-only tests and runtime smoke support. Root `npm test` includes these tests; there is no package-local Vitest configuration.

The package includes `src/`, `docs/`, `README.md`, and `LICENSE`, plus npm's package metadata. Tests and repository configuration are not shipped.

## 🔎 Keywords

Pi extension, Pi coding agent, edit scope, selected files, file allowlist, editing guard.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
