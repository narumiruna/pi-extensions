# Configuration and Format Reference

Use this authoritative public reference for configuration location and persistence, presets, complete-document examples, format grammar, styles, palettes, and state-selected styles.

## ⚙️ Settings

The only configuration source is:

```text
<getAgentDir()>/pi-starship.toml
```

When this file is absent, the extension uses its palette-free default without creating the file or its parent directory.
The built-in root is the explicit sequence `$brand$model$thinking$directory` `$git_branch$git_status$activity$context$time`; it does not start the opt-in GitHub PR query.
The first successful settings save creates the file atomically.
Existing malformed documents are never overwritten.

The extension does **not** read project overrides, `pi-statusline.json`, `PI_STATUSLINE_PRESET`, or `~/.config/starship.toml`, and does not migrate statusline settings.

Open the interactive menu in TUI mode:

```text
/starship
```

Choose **Customize footer** to edit the TOML.
Closing the editor validates the draft and opens a scrollable preview with **Apply changes…**, **Continue editing**, and **Discard draft**.
Saving requires separate confirmation, then atomically updates the file and active footer.
Manual TOML edits load at the next `session_start`, including `/reload` and session replacement.
Cancellation, disposal, invalid drafts, write failures, and runtime application failures preserve the previous file and footer.

The shallow main menu also exposes **Presets**, **Explain footer**, **Modules**, **Configuration**, **Help**, and **Restore built-in…**.
Explain footer uses the current immutable runtime snapshot to list each currently showing non-empty module once with its rendered value and description; it starts no new collection work.
Modules opens a bounded searchable inspector for every registered module.
Its textual states distinguish **Showing**, **Empty**, **Disabled**, **Not in format**, and **Unavailable** only when the current footer cannot provide an inspection snapshot.
Module detail shows the current preview when available, description, root reference and reachability, format variables, style fields, display rules, and the known reason for absent output.
Both views are read-only and do not create or update the settings document.

Configuration contains **Overview**, **Effective configuration**, **Settings document**, and **Reload from disk** on one nested level.
Overview combines state, source, path, health, and bounded diagnostics.
Effective configuration shows deterministic catalog-ordered public TOML from the normalized state currently in use; comments, unknown fields, parser ASTs, and private runtime selectors are excluded.
Settings document shows the exact loaded UTF-8 text through a terminal-safe, cell-aware read-only review without changing the raw payload.
A missing file is **Built-in defaults**, an exact bundled document uses its preset name, and read or parse errors are **Built-in fallback**.
Reload from disk reads only after the explicit action, validates and previews the current external state from the existing runtime snapshot, and asks for separate confirmation before changing the active session.
A deleted document is a valid previewable transition to built-in defaults and creates no file.
An unchanged document is a no-op, while read or parse failure, cancellation, disposal, external changes after preview, session replacement, shutdown, or runtime apply failure preserves the prior effective footer and every file byte.
Reload re-reads immediately after confirmation and rejects a different external snapshot; it does not claim cross-process locking or continuing synchronization with later edits.
Restore is disabled when no settings document exists or the exact built-in document is already saved.
For a custom or invalid document, Restore previews the result and warns that the complete document, including custom settings, unknown fields, and comments, will be replaced without a post-success backup before asking for confirmation.

### 🎛️ Presets

Choose **Presets** from `/starship` to browse complete Pi-native starting points.
The catalog adapts all styles listed by `starship preset --list` in Starship 1.26.0, plus a Pi-specific Minimal option.
Colors, separators, typography, and layout follow the named Starship preset; modules are deliberately selected for Pi's model, thinking, workspace, Git, activity, context, and time snapshots.

| Preset | Adapted visual treatment | Font requirement |
| --- | --- | --- |
| **Minimal** | Compact Pi essentials | Standard Unicode |
| **Bracketed Segments** | Balanced Pi and Git information in brackets | Standard Unicode |
| **Catppuccin Powerline** | Connected Catppuccin Mocha blocks; other Catppuccin palettes remain in the document for customization | Nerd Font |
| **Gruvbox Rainbow** | Warm Gruvbox connected segments | Nerd Font |
| **Jetpack** | Airy geometric activity/context and workspace columns joined by fill | Standard Unicode |
| **Nerd Font Symbols** | Balanced default layout with icon-rich symbols | Nerd Font |
| **No Empty Icons** | Conditional text labels that cannot appear without their values | Standard Unicode |
| **No Nerd Font** | Portable Unicode symbols without private-use glyphs | Standard Unicode |
| **No Runtime Versions** | Presence indicators without model or thinking details | Standard Unicode |
| **Pastel Powerline** | Connected magenta, coral, orange, blue, teal, and navy blocks | Nerd Font |
| **Plain Text Symbols** | Plain words replace pictograms | Standard Unicode |
| **Pure Preset** | Clean two-line workspace and session context | Standard Unicode |
| **Tokyo Night** | Connected cool blue Tokyo Night blocks | Nerd Font |

Moving through the preset picker temporarily renders the selected preset in the footer without writing settings or starting collectors.
Press Enter to confirm replacement, or press `e` to edit the selected complete TOML document before preview and confirmation.
Escape returns to the main menu, while Ctrl+C closes the workflow; both restore the active footer.

Presets are complete documents, not overlays.
After confirmation, applying one replaces all of `pi-starship.toml`, including custom settings, unknown fields, and comments; no backup is kept.
Cancellation, disposal, validation failure, write failure, and runtime-apply failure preserve the previous document and footer.
An exact match is **Currently applied** and cannot be selected again; editing any byte makes it custom.
Use **Restore built-in…** for deterministic recovery.

The bundled presets use only pi-starship's local Pi and Git snapshot modules.
They do not enable the GitHub PR query, cloud/deployment readers, or optional command-backed workspace collectors.
They are Pi-native adaptations of the color and format treatments emitted by Starship 1.26.0; they do not copy Starship's module selections because Pi exposes different runtime information.
There is no `/starship preset` textual route and no remote preset download.

### 📝 Example

```toml
format = """
$brand\
$model\
$thinking\
$directory\
$git_branch\
$git_status\
$activity\
$context\
$time"""

[model]
format = "[ $symbol$model ]($style)"
symbol = "◆ "
style = "bold blue"
truncation_length = 36
truncation_symbol = "…"
truncation_direction = "middle"

[directory]
style = "cyan bold"

[git_branch]
style = "bold purple"

[context]
format = "[$symbol $percentage/$window ]($style)"

[[context.display]]
threshold = 0
style = "bold green"
hidden = true

[[context.display]]
threshold = 30
style = "bold green"
hidden = false

[[context.display]]
threshold = 60
style = "bold yellow"
hidden = false

[[context.display]]
threshold = 80
style = "bold red"
hidden = false

[git_metrics]
added_style = "bold green"
deleted_style = "bold red"
disabled = false

[username]
style_user = "yellow bold"
style_root = "red bold"

[extension_status]
format = "([$statuses ]($style))"
icons = { "foo:*" = "🧪", "third_party/key" = "◎", fallback = "•" }
```

Every module table supports `format`, `symbol`, and `disabled`.
Most modules also support one `style`.
The exceptions are `git_metrics` (`added_style` and `deleted_style`), `username` (`style_user` and `style_root`), and the threshold-selected `context` and `cost` `display` arrays described below.
`thinking` retains its `style` fallback and also accepts the per-level overrides documented below.
Module-specific options are catalog-owned and type-checked; unknown options warn and stay inactive.
Version formats replace `$raw`.
Detection arrays replace defaults when non-empty and inspect only one listing of the current directory.
A leading `!` is supported by language detection arrays and rejects a matching project.
`[extension_status].icons` accepts arbitrary exact Pi status keys and explicit colon namespace wildcards such as `foo:*`; `fallback` controls unmatched statuses.
Icon matching uses the exact key, the longest `:*` wildcard, a leading status emoji, then `fallback`/`🔌`.
An empty configured icon suppresses only the icon.
`foo:*` matches `foo:server` but not `foo`, `foobar`, or `foo/server`.

Pi does not expose status ownership, so exact raw keys are the reliable third-party contract.
pi-starship does not inspect installed packages, infer aliases, assign known-extension icons, or bridge compatibility keys.
Extension authors may use `<extension-id>` or `<extension-id>:<stable-slot>` for interoperability, but pi-starship does not require it.

**Icon migration:** configurations that relied on package-ID aliases, built-in known-extension icons, or compatibility mappings must use an exact raw status key, an explicit namespace wildcard, a leading emoji in the status value, or `fallback`.

## 🧩 Format grammar

- Variables: `$name` and `${name}`.
  Unknown variables render empty and produce a warning when loaded from TOML.
- Escapes: `\\$`, `\\[`, `\\]`, `\\(`, `\\)`, and `\\\\` render functional characters literally.
- Styled groups: `[format string](style string)`.
- Conditional groups: `(format string)` render only when a nested variable has a non-empty value.
- Nested groups are supported.
- `$all` expands enabled modules in the default order and omits modules already referenced explicitly.

Module formats can use `$style` in a style expression.
Module output keeps its own style when embedded in an outer styled group.

## 🎨 Styles and palettes

Style expressions support:

- Named colors and ANSI numbers `0`–`255`.
- Hex RGB (`#7aa2f7`), rendered as ANSI-256 when Pi's effective terminal capabilities disable true color.
- `fg:<color>` and `bg:<color>`; an unprefixed color is foreground.
- `bold`, `dimmed`, `italic`, `underline`, `blink`, `inverted`, `hidden`, and `strikethrough`.
- `none` and `fg:none`, which make the complete expression unstyled regardless of position.
- `bg:none`, which clears only the absolute background; an unknown `bg:<value>` has the same Starship-compatible reset behavior.
- `prev_fg` and `prev_bg`, which use the previous rendered chunk's colors when present and retain any absolute foreground/background in the expression as the no-previous fallback.
- Direct color names from one explicitly selected `[palettes.<name>]` table.

There is no built-in or fallback palette.
A custom palette is active only when its table is explicitly selected, and its values must be direct named, ANSI, or RGB colors—palette entries cannot reference other entries.
Palette names override terminal color names such as `blue`:

```toml
palette = "company"

[palettes.company]
blue = "#86BBD8"
accent = "208"

[model]
style = "bold blue"
```

Style tokens are case-insensitive and ordinary foreground/background colors are last-wins.
`prev_fg`/`prev_bg` override their absolute fallback only when a previous chunk exists.
Empty styled groups still advance previous-color state.
Invalid literal style expressions warn and render unstyled.
An invalid root format falls back to the built-in root format; an invalid module format or catalog-owned style field falls back only at that field's module scope.
`/starship status` reports warnings.

The background-free defaults are: `brand = "bold white"`, `provider`/`model` = `"bold blue"`, `thinking`/`git_branch`/`turn` = `"bold purple"`, `directory`/`git_worktree` = `"cyan bold"`, `github_pr = "bold blue"`, `git_commit = "green bold"`, `git_state`/`activity`/`time` = `"bold yellow"`, `git_status = "red bold"`, `tokens = "bold cyan"`, `cache = "bold green"`, `extension_status = "dimmed white"`, `direnv = "bold bright-yellow"`, and `fill = "bold black"`.
Context, cost, Git metrics, and username use the state/multi-style defaults below.

### Thinking level styles

`thinking` can override its appearance for `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` independently:

```toml
[thinking]
style = "bold purple"
style_low = "bold blue"
style_high = "bold yellow"
style_max = "bold red"
```

The matching `style_<level>` wins when it is non-empty.
Every unset or empty level override uses the existing `style`, including levels added by a future Pi release.
Invalid fallback and level styles warn and fall back independently without changing other levels.

### State-selected styles

`context` and `cost` select the last entry at the highest threshold less than or equal to the current value.
A later entry wins when thresholds are equal.
Each display entry requires a finite `threshold`, a valid `style`, and boolean `hidden`.
Invalid entries warn and are ignored; module defaults are used if none remain.

The default context thresholds are hidden at `0`, `bold green` at `30`, `bold yellow` at `60`, and `bold red` at `80`.
The default cost thresholds are hidden at `0`, `bold yellow` at `1`, and `bold red` at `5`:

```toml
[[cost.display]]
threshold = 0
style = "bold green"
hidden = true

[[cost.display]]
threshold = 1
style = "bold yellow"
hidden = false

[[cost.display]]
threshold = 5
style = "bold red"
hidden = false
```

`git_metrics` exposes `$added_style` and `$deleted_style` in its module format.
`username` still uses `$style` in its format, but selects `style_user` or `style_root` from private execution metadata; the selector is not a format variable.

### Breaking palette migration

The previous implicit `tokyo-night` palette and its `lead`, `header`, `header_fg`, `directory`, `directory_fg`, `git`, `git_fg`, `runtime`, `runtime_fg`, `meter`, `meter_fg`, and `extension` aliases were removed.
Existing files are not rewritten.
Old alias-based module styles warn and fall back to the module's new direct-color default; alias-based literal Powerline groups warn and render unstyled.

Choose one migration:

1. Replace old aliases with direct styles such as `cyan bold`, `bold bright-yellow`, or `fg:#e3e5e5 bg:#769ff0`.
2. Define every needed alias under your own `[palettes.<name>]` table and explicitly select it with `palette = "<name>"`.
3. Use **Restore built-in…** from `/starship` to review and replace the complete document with the new plain nine-module configuration.

There is no hidden compatibility overlay or automatic migration.
