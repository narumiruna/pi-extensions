# Pi Statusline configuration reference

[Back to README](../README.md)

- [Settings fields](#settings-reference)
- [Appearance and palettes](#-appearance)
- [Model truncation](#model-truncation)
- [Advanced layout and controls](#-advanced-layout)
- [Extension statuses and icons](#-extension-statuses-and-icons)

## ⚙️ Settings

The extension uses one user-level file:

```text
<getAgentDir()>/pi-statusline.json
```

There are no project or environment overrides.
When the file is absent, pi-statusline uses built-in defaults without creating the file or its parent directory.
The first successful settings save creates a complete editable document atomically.
Malformed or unreadable settings are never overwritten.
Settings reload on startup, `/reload`, and session replacement.

A valid legacy `pi-statusline-settings.json` remains readable with a warning and is never modified automatically; rename it to `pi-statusline.json`.
If both files exist, `pi-statusline.json` wins.

### Settings reference

| Field | Accepted values | Purpose |
| --- | --- | --- |
| `palettePreset` | `tokyo-night`, `ocean`, `sunset`, `forest`, `candy`, `neon`, `mono`, `custom` | Select the active color preset |
| `palette` | Per-segment `fg`/`bg` `#RRGGBB` colors | Define colors used by `custom` |
| `density` | `compact`, `cozy` | Control horizontal padding |
| `separator` | `none`, `dot`, `bar`, `powerline`, `round` | Separate adjacent segments in one color block |
| `segments` | Ordered unique segment names and `line_break` | Control visibility, order, and rows |
| `segmentText` | Per-segment `prefix` and `suffix`; model truncation fields | Format Pi-owned dynamic values |
| `extensionStatusIcons` | Raw status key or `namespace:*` to icon string | Customize extension status icons |

All fields are optional in an existing document.
Missing fields use defaults.
Menu saves warn about and preserve unknown fields.
Invalid recognized values block saving and leave the file and live footer unchanged.

A compact customization example:

```json
{
  "palettePreset": "ocean",
  "density": "compact",
  "separator": "dot",
  "segments": ["model", "thinking", "cwd", "branch", "context", "cache", "cost"],
  "segmentText": {
    "model": {
      "truncationLength": 40,
      "truncationSymbol": "…",
      "truncationDirection": "middle"
    },
    "context": { "prefix": "ctx ", "suffix": "" }
  },
  "extensionStatusIcons": {
    "goal": "◎",
    "foo:*": "🧪"
  }
}
```

Use **Advanced → Edit settings JSON** or `/statusline settings` to edit, validate, atomically save, and apply the file.

## 🎨 Appearance

Named palettes provide contrast-checked color ramps.
Appearance previews update while the picker moves, but save only when Enter is pressed; Escape restores the saved palette.

When `palettePreset` is `custom`, `palette` maps segment names to foreground/background colors:

```json
{
  "palettePreset": "custom",
  "palette": {
    "model": { "fg": "#090c0c", "bg": "#a3aed2" },
    "context": { "fg": "#c0caf5", "bg": "#1d2230" }
  }
}
```

- Selecting `custom` without a palette copies the active named preset as a starting point.
- A manually authored `"palettePreset": "custom"` without `palette` uses Tokyo Night colors.
- Named presets ignore but preserve an existing custom palette.
- A `palette` object without `palettePreset` selects `custom`.
- Legacy string palettes such as `"palette": "ocean"` remain accepted.
- Missing custom colors remain unstyled instead of inheriting Tokyo Night.
- Adjacent segments with identical colors share one block; transitions use ``.
- Hex palette colors render as ANSI-256 when Pi's effective terminal capabilities disable true color.

`segmentText` values must be single-line text without terminal control characters.
Use `line_break` for another row rather than inserting a newline into a prefix or suffix.

### Model truncation

Long model IDs are truncated out of the box so the balanced footer can retain useful model context:

```json
{
  "segmentText": {
    "model": {
      "truncationLength": 36,
      "truncationSymbol": "…",
      "truncationDirection": "start"
    }
  }
}
```

`truncationLength` counts model grapheme clusters retained before the symbol.
The built-in value is `36`; set it to `0` to display the complete ID.
The direction names the removed portion:

- `start` retains the suffix and is the default, which is useful for long llama.cpp paths and model variants.
- `middle` retains both ends.
- `end` retains the prefix.

Truncation runs after the built-in Claude/GPT shortening rules but before the configured model prefix and suffix.
It changes display only—the provider model ID is untouched.
Terminal control sequences in model IDs are removed at render time, and unsafe configured symbols are rejected.
An empty `truncationSymbol` truncates without a marker.
pi-statusline treats model IDs as opaque strings and does not parse paths, repositories, GGUF suffixes, or quantization names.
At very narrow widths, the existing responsive priorities may still omit the model rather than overflow the terminal.

## 🧩 Advanced layout

Open **Advanced → Custom layout** when the curated levels are not enough.

| Key | Action |
| --- | --- |
| Up/Down | Navigate |
| Page Up/Page Down | Move by one viewport |
| Enter/Space | Show or hide the selected segment |
| `M` | Enter or leave Move mode |
| Up/Down in Move mode | Reorder the selected visible segment |
| `Alt+Up` / `Alt+Down` | Reorder without entering Move mode |
| `B` | Add or remove a line break after the selected segment |
| Configured Back key (Escape by default) | Leave Move mode first, then close the screen |
| Ctrl+C | Close the screen immediately, including from Move mode |

The layout displays the effective Back key and keeps Ctrl+C available when Back is remapped.
Every successful change saves and applies immediately.
Closing the screen does not roll it back.

Available data segments:

```text
brand provider model thinking cwd branch tools context tokens cache cost time turn
```

Data segments must be unique.
`line_break` may repeat when data segments separate occurrences, but consecutive breaks are invalid.
It has no `segmentText` entry.
The menu cleans up leading, trailing, and newly consecutive breaks after visibility changes.
Manually authored leading/trailing breaks represent empty rows.

```json
{
  "segments": ["model", "line_break", "cwd", "branch", "context"]
}
```

An empty `segments` array hides the main powerline while extension statuses can still render.

## 🔌 Extension statuses and icons

Other extension statuses appear below the main powerline, wrap to terminal width, and are limited to five items.
Icons use this order:

1. Exact configured raw key, such as `goal` or `foo:server`.
2. Longest configured colon wildcard, such as `foo:*` or `foo:server:*`.
3. Unambiguous installed-package alias, such as `@vendor/pi-foo`, `pi-foo`, or `foo`.
4. Leading emoji supplied by the status text.
5. Built-in icon.
6. Generic `🔌` fallback.

Set an icon to `""` to hide only the icon.
Wildcards match colon namespaces, not slash-delimited keys.
Configure slash keys exactly.
Compatibility fallbacks retain `codex-usage`, `pisync`, and `unknown-error-retry`; an explicit canonical key wins.

For interoperable extensions, prefer one aggregated key or a stable coexistence slot:

```text
<extension-id>
<extension-id>:<stable-slot>
```

Put transient activity in the value, and clear the exact key that was set.
