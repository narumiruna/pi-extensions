# 🚀 pi-starship — Native Starship-style Statusline for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-starship)](https://www.npmjs.com/package/@narumitw/pi-starship) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A native Pi footer configured with Starship-style TOML. It parses and renders formats itself—no `starship` executable or shell prompt required.

> **Different package:** the unscoped npm package `pi-starship` delegates to the Starship binary. This package is `@narumitw/pi-starship` and renders Pi-specific modules natively.

## ✨ Features

- Automatically creates a readable Tokyo Night configuration on first session start.
- Starship-style root/module formats, conditional groups, `$all`, styles, and palettes.
- Pi modules for model, thinking, activity, context, tokens, cost, turn, and extension statuses.
- Cached Git branch, commit, operation state, line metrics, detailed status, and linked-worktree identity; no subprocess runs during footer rendering.
- Multiline output wraps to the terminal width instead of truncating.
- Goal-oriented `/starship` menu with configuration health, preview, confirmation, and recovery.

## 📦 Install

```bash
pi install npm:@narumitw/pi-starship
```

Try it from a checkout:

```bash
pi -e ./extensions/pi-starship
```

Do not enable this together with `@narumitw/pi-statusline`: both own Pi's footer. `pi-starship` warns when it detects the conflict.

## ⚙️ Configuration

The only configuration source is:

```text
<getAgentDir()>/pi-starship.toml
```

On the first session start, the extension atomically creates this file from its readable Tokyo Night default. It never overwrites an existing document, including a malformed one. If initialization fails, the built-in configuration remains active and the failure is reported as a warning.

The extension does **not** read project overrides, `pi-statusline.json`, `PI_STATUSLINE_PRESET`, or `~/.config/starship.toml`, and does not migrate statusline settings.

Open the interactive menu in TUI mode:

```text
/starship
```

Choose **Customize footer** to edit the TOML. Closing the editor validates the draft and opens a width-aware preview; saving happens only after a separate confirmation. Confirmed changes are atomically saved and applied immediately. Editor cancellation, preview cancellation, invalid drafts, write failures, and runtime application failures preserve the previous file and effective footer.

The **Advanced** menu is one level deep and contains configuration details plus **Restore built-in**. Restore shows the concrete built-in preview and requires explicit overwrite confirmation.

### 📝 Example

```toml
format = "$brand$provider$model$thinking\n$directory$git_branch$git_status\n$activity$context$tokens$cost$time$turn\n$extension_status"
palette = "tokyo-night"

[palettes.tokyo-night]
header = "#7aa2f7"
header_fg = "#1a1b26"
custom = "208"

[model]
format = "[ $symbol$model ]($style)"
symbol = "◆ "
style = "bold fg:header_fg bg:header"
disabled = false

[activity]
format = "([ $text ]($style))"
style = "fg:custom"

[git_branch]
format = "[ $symbol$branch$pr ]($style)"

[extension_status]
format = "([$statuses ]($style))"
icons = { "github-pr" = "PR", "foo:*" = "🧪", "@narumitw/pi-goal" = "◎", fallback = "•" }
```

All module tables support `format`, `symbol`, `style`, and `disabled`.
`[extension_status].icons` accepts arbitrary exact Pi status keys, explicit colon namespace
wildcards such as `foo:*`, and installed package IDs; `fallback` controls unmatched statuses. Icon
matching uses exact key, longest `:*` wildcard, unambiguous package alias, leading status emoji,
built-in icon, then `fallback`/`🔌`. An empty icon suppresses only the icon. `foo:*` matches
`foo:server` but not `foo`, `foobar`, or `foo/server`.

Pi does not expose which package owns a status, so package aliases are best-effort conveniences and
exact raw keys are the reliable third-party contract. Extension authors may adopt
`<extension-id>` or `<extension-id>:<stable-slot>` for interoperability, but pi-starship cannot
require that convention. Canonical built-ins use `sync` and `retry`; compatibility mappings keep
`pisync` and `unknown-error-retry` settings and older producer versions working.

## 🧩 Format grammar

- Variables: `$name` and `${name}`. Unknown variables render empty and produce a warning when loaded from TOML.
- Escapes: `\\$`, `\\[`, `\\]`, `\\(`, `\\)`, and `\\\\` render functional characters literally.
- Styled groups: `[format string](style string)`.
- Conditional groups: `(format string)` render only when a nested variable has a non-empty value.
- Nested groups are supported.
- `$all` expands enabled modules in the default order and omits modules already referenced explicitly.

Module formats can use `$style` in a style expression. Module output keeps its own style when embedded in an outer styled group.

## 🎨 Styles and palettes

Style expressions support:

- Named colors and ANSI numbers `0`–`255`.
- Hex RGB (`#7aa2f7`).
- `fg:<color>` and `bg:<color>`; an unprefixed color is foreground.
- `bold`, `dimmed`, `italic`, `underline`, `blink`, `inverted`, `hidden`, and `strikethrough`.
- `none`, `fg:none`, and `bg:none`.
- `prev_fg` and `prev_bg` to inherit the previous rendered chunk's colors.
- Color names from the active `[palettes.<name>]` table. The active palette overlays the built-in Tokyo Night colors so the default module styles remain available.

An invalid root format falls back to the built-in root format. An invalid module format or style falls back only for that module. `/starship status` reports warnings.

## 🧱 Modules

| Module | Format variables | Meaning |
| --- | --- | --- |
| `brand` | `$symbol` | Pi brand marker |
| `provider` | `$symbol`, `$provider` | Current model provider |
| `model` | `$symbol`, `$model` | Current model name |
| `thinking` | `$symbol`, `$level` | Thinking level |
| `directory` | `$symbol`, `$path`, `$full_path` | Current working directory |
| `git_worktree` | `$symbol`, `$name`, `$path` | Linked worktree name and top-level path |
| `git_branch` | `$symbol`, `$branch`, `$remote_name`, `$remote_branch`, `$pr` | Branch, upstream, and actionable PR state |
| `git_commit` | `$symbol`, `$hash`, `$tag` | Seven-character HEAD hash and optional exact tag |
| `git_state` | `$symbol`, `$state`, `$progress_current`, `$progress_total` | Rebase, merge, revert, cherry-pick, bisect, or mail-apply state |
| `git_metrics` | `$symbol`, `$added`, `$deleted` | Added/deleted line totals from the working tree diff |
| `git_status` | `$symbol`, `$all_status`, `$ahead_behind`, `$ahead`, `$behind`, `$diverged`, `$up_to_date`, `$conflicted`, `$stashed`, `$deleted`, `$renamed`, `$modified`, `$typechanged`, `$staged`, `$untracked`, and detailed index/worktree counters | Cached porcelain-v2 counters |
| `activity` | `$symbol`, `$state`, `$tool`, `$count`, `$text` | Active tools, streaming, completion, or idle |
| `context` | `$symbol`, `$percentage`, `$tokens`, `$window` | Context-window use |
| `tokens` | `$symbol`, `$input`, `$output`, `$total` | Token totals |
| `cost` | `$symbol`, `$cost` | Session cost |
| `time` | `$symbol`, `$time` | Current local time |
| `turn` | `$symbol`, `$count` | User turn count |
| `extension_status` | `$symbol`, `$statuses`, `$count` | Pi extension statuses |

`git_worktree` is empty in the primary worktree. In a linked worktree it defaults to the top-level directory name; use `$path` when the full absolute path is needed.

`git_commit`, `git_state`, and `git_metrics` are intentionally not present in the built-in root format. Add their variables to `format` to opt in; also set `[git_metrics].disabled = false`, matching Starship's opt-in metrics default. `$tag` resolves only an exact tag on HEAD and is queried only when the configured `git_commit` format references it.

If `$git_branch.$pr` is present in the module format, its selected PR token is removed from `extension_status` to avoid duplication.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/starship` | Open the current-state menu in TUI mode; retain help behavior outside TUI |
| `/starship settings` | Open the compatible direct edit → preview → confirm flow (TUI only) |
| `/starship status` | Show config source/path and diagnostics |
| `/starship help` | Show command and configuration help |

The main menu keeps frequent goals visible: **Customize footer**, **Check configuration**, and **Help**. It shows whether the footer uses the built-in or custom document and displays the current warning count. **Advanced** contains uncommon details and the confirmed restore action, with an explicit **Back** path.

Status and help remain safe in TUI, RPC, JSON, and print modes. RPC receives notifications but never opens custom terminal UI; print and JSON modes produce no ad hoc output. Footer/timer/Git lifecycle work starts only in TUI mode.

## 📐 Scope

The formatter grammar and style concepts follow Starship, but the module catalog is intentionally Pi-specific. This extension does not claim compatibility with Starship's shell module catalog or execute the Starship binary.

## ➕ Adding a module

Create `src/modules/<name>.ts` with its format variables, defaults, and runtime value resolver, then register it in display order in `src/modules/catalog.ts`. Configuration names, validation variables, defaults, and `$all` ordering are derived from that catalog. Add the module to the built-in root format when it should be visible by default, then document and test its user-facing values.

Keep `extension_status` last in the catalog so earlier modules can consume extension-owned status values without rendering duplicates.

## 🗂️ Package layout

- `src/index.ts` — Pi package entrypoint.
- `src/pi-starship.ts` — extension lifecycle, live preview binding, and footer.
- `src/commands.ts` — goal-oriented menu, preview/confirmation, diagnostics, and compatibility routes.
- `src/config.ts` — TOML loading, draft validation, defaults, atomic persistence, and rollback.
- `src/format/` — native format/style parser and renderer.
- `src/modules/` — module-per-file definitions, ordered registry, and statusline renderer.
- `src/modules/git/` — shared Git runtime plus branch, status, and worktree modules.

## 🔎 Keywords

Pi Coding Agent, Starship statusline, Starship TOML, terminal footer, native statusline, Pi extension

## 📄 License

MIT. See [`LICENSE`](./LICENSE). Starship attribution and its ISC license are included in [`NOTICES.md`](./NOTICES.md).
