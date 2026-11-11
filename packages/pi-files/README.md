# 🗂️ pi-files — File Context and Edit Restrictions

[![npm](https://img.shields.io/npm/v/@narumitw/pi-files)](https://www.npmjs.com/package/@narumitw/pi-files)
[![Pi Extension](https://img.shields.io/badge/Pi-extension-blue)](https://github.com/earendil-works/pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Browse files, attach exact snapshots to the next prompt, and manage allowed edit targets through `/files`. Context selection and edit permission are independent: quoting never authorizes a file, and authorization never loads its contents.

## ✨ Features

- Project explorer with file-name and content search, exact-line previews, Git history, diffs, and provenance.
- Immutable context snapshots with review and removal before submission, plus whole-file references.
- Checked-file selection, explicit external targets, and new-file reservations for native edit restrictions.
- Branch-owned restrictions restored across reload, resume, fork, tree navigation, and compaction.

## 📦 Install

**Extensions run with Pi's full user permissions. Load only trusted code. This is an in-process guard, not an OS sandbox.** Read the [security boundary](#-security-and-privacy) before enabling restrictions.

Pi Files is not yet published to npm. A read-only registry query returned `E404` during implementation; it does not reserve the name or authorize publication. Use a local checkout. From the repository root:

```bash
npm install
npm run build
pi -e ./packages/pi-files
```

The root build supplies Pi TUI Kit and generates `dist/index.ts`. An unbuilt checkout cannot be loaded by package directory. To register the built checkout for later sessions:

```bash
pi install ./packages/pi-files
```

Before switching from File Context or Edit Scope, follow the [migration guide](docs/migration.md). Remove or disable predecessor resources in both user and project install scopes, then reload. **Do not co-load Pi Files with either predecessor.**

## 🚀 Quick start

1. Run `/files browse` or press `Ctrl+Shift+X`.
2. Open a file, press `Space` to anchor an exact line selection, extend it with arrows, then press `Enter` to queue the snapshot.
3. Review queued context through `/files`, then submit the request normally. Snapshots attach once, in selection order.

To restrict edits separately, open scope management from `/files`, check files in its dedicated picker, and explicitly apply. End the restriction with `/files off` before running tools such as tests or formatters.

## 💬 Commands

| Route | Result |
| --- | --- |
| `/files` | Open the common manager for browsing, context review, edit scope, Settings, Status, and Help. |
| `/files browse` | Open the context explorer directly. |
| `/files off` | End the edit restriction without changing queued context. |
| `/file-context [browse\|remove]` | Retain the dedicated context manager, direct browser, and snapshot-review route. `remove` does not delete files. |
| `/edit-scope`, `/scope` | Retain the dedicated scope manager. |
| `/edit-scope off`, `/scope off` | End the same restriction. |

Interactive routes require TUI mode and reject unknown or trailing arguments. Scope routes and permission changes require an idle agent with no pending messages. RPC, print, and JSON reject interactive commands before custom UI; restored enforcement remains active in all modes.

In fullscreen TUI mode, click the **Files** divider or any summary row, including its blank right side, to collapse or expand the widget. Collapse affects only the display; queued context and edit restrictions stay active. The choice survives summary updates and branch navigation, but resets on session replacement or reload. Open `/files` to expand it from the keyboard.

The explorer and checked-file picker remain separate components with different selection keys. There is no combined quote-and-authorize action. Closing a screen, cancelling, or ending a run does not release an applied restriction. See the [context workflow](docs/file-context-reference.md) and [scope workflow and recovery](docs/edit-scope-reference.md) for interaction, mode errors, and limits.

## ⚙️ Settings

Open `/files` → **Settings** for the common Pi `SettingsList` screen. Changes save immediately; Escape does not undo a saved change. Only **Open shortcut** is blocked while context is queued because it reloads Pi. **Show hidden files** applies immediately to scope discovery without reload or permission changes. Dedicated compatibility managers keep their existing settings routes.

The two user-only stores deliberately retain their legacy basenames under `getAgentDir()` (normally `~/.pi/agent`):

| File | Setting and default | Detailed reference |
| --- | --- | --- |
| `pi-file-context.json` | `openShortcut: "ctrl+shift+x"`; `null` disables it | [Shortcut and editor settings](docs/file-context-reference.md#settings) |
| `pi-scope.json` | `showHiddenFiles: false`; boolean | [Scope settings and persistence](docs/edit-scope-reference.md#settings-and-persistence) |

These filenames are compatibility exceptions. There is no `pi-files.json`, automatic filename migration, project override, or extension-specific environment variable. Edit the files manually and run `/reload` to apply changes. Defaults do not create files; invalid files are not overwritten, and failed saves preserve the prior effective value. See the linked references for accepted values, ordering, and failure recovery.

## 🔒 Security and privacy

The supported guard boundary is **unmodified stock Pi CLI tools with trusted extensions**, not arbitrary SDK `baseToolsOverride` or custom `prepareLoadout` implementations.

While restricted, stock readers remain available for other files. Stock `write` and `edit` require an exact, freshly validated canonical target. Shell tools, codemode, delegation, replacement tools, and unsupported custom tools are blocked, including tools with `readOnlyHint`. At least one stock direct writer must be active; active native `codemode.mode=only` is unsupported. The extension does not alter active tools or core settings to make a loadout acceptable.

The guard does not contain user-issued shell commands, RPC shell calls, extension code, other programs, existing background processes, or filesystem races. **The user-controlled external editor is outside this guard**, runs with user permissions, and can modify other files or access services. Historical previews remain read-only. Selected scope paths and canonical redirects enter a model notice; selected quotes send file text to the model. Inspect content and Git diffs before submission.

See [context data boundaries](docs/file-context-reference.md#security-and-data-limits) and [scope protection and recovery](docs/edit-scope-reference.md#protection-boundary) before relying on either workflow.

## 🚧 Limitations

Queued context is ephemeral and does not survive reload, session replacement, or shutdown. Submit or remove it explicitly before migration or reload. Scope persists separately; invalid, uncertain, or unsupported restored scope fails closed until repaired or explicitly ended.

Discovery does not implement `.gitignore`. The bounded context inventory is not a complete scope inventory: scope scan errors and limits fail the operation rather than authorize a partial result. Detailed discovery, path, UI, and platform limits remain in the linked behavior references. Physical-terminal and untested platform behavior is not established by deterministic tests; current evidence belongs in [verification](docs/verification.md).

## 🗂️ Package layout

- `src/index.ts` forwards to the single factory in `src/files.ts`; package-owned context and scope modules retain their separate responsibilities.
- `dist/index.ts` and generated chunks form the published Jiti runtime; `scripts/build-runtime.mjs` uses the repository builder and keeps Pi peers external.
- `docs/` contains both behavior references, migration guidance, and verification evidence.
- `test/` contains repository-only coverage and smoke fixtures.

Published files include `src/`, `dist/`, `docs/`, README, changelog, license, and package metadata. Tests, build scripts, and repository configuration are not shipped. Build before packing or loading the local package directory.

## 🔎 Keywords

Pi extension, file explorer, exact context, Git provenance, edit scope, file allowlist, native editing guard.

## 📄 License

[MIT](LICENSE)
