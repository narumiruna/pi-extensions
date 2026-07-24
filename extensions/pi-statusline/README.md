# ✨ pi-statusline — A Beautiful, Practical Footer for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-statusline` gives [Pi](https://pi.dev) an opinionated powerline footer that looks good
without setup and keeps useful context visible as the terminal narrows.

A representative uncolored layout:

```text
░▒▓ 🤖 sonnet-4 🧠 high 📁 pi-extensions 🌿 main ~2 🪟 ctx 42% 💸 $0.184
```

## Why pi-statusline?

- **Zero-config default:** model, thinking, workspace, Git/PR state, context use, and cost.
- **Responsive:** removes lower-priority segments before important information gets clipped.
- **Quiet when idle:** activity appears only while Pi is streaming or running tools.
- **Easy choices:** three information levels and seven previewable color presets.
- **Still flexible:** custom layouts, multiline rows, colors, labels, separators, and status icons stay
  available under **Advanced**.

> Want complete format and style control? Use
> [`@narumitw/pi-starship`](https://www.npmjs.com/package/@narumitw/pi-starship) instead. Do not
> enable both packages: each owns Pi's footer.

## Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try it without installing, or load it from this repository:

```bash
pi -e npm:@narumitw/pi-statusline
pi -e ./extensions/pi-statusline
```

For the best result, use a terminal font that includes Powerline glyphs and emoji.

## Quick start

1. Install the extension and start Pi.
2. Run `/statusline`.
3. Choose an appearance or information level; changes apply immediately.

```text
Appearance (tokyo-night)
Information (balanced)
Advanced
Status
Help
```

| Menu item | What it does |
| --- | --- |
| **Appearance** | Preview palettes with Up/Down; Enter applies and Escape cancels |
| **Information** | Preview and apply a curated set of segments |
| **Advanced** | Open Custom layout or Edit settings JSON |
| **Status** | Show the effective source, path, appearance, layout, and diagnostics |
| **Help** | Show command and schema guidance |

### Information levels

Selecting a level replaces only the `segments` array. Unknown and unrelated JSON fields are
preserved.

| Level | Included segments |
| --- | --- |
| **Minimal** | `model cwd branch context` |
| **Balanced** (default) | `model thinking cwd branch tools context cost` |
| **Detailed** | `provider model thinking cwd branch tools context tokens cost time` |
| **Custom** | Any other segment order, including explicit line breaks |

The `tools` segment takes no space while idle.

## Commands

| Command | Purpose |
| --- | --- |
| `/statusline` | Open Appearance, Information, Advanced, Status, and Help |
| `/statusline settings` | Open the JSON editor in TUI mode |
| `/statusline status` | Show the effective settings and diagnostics |
| `/statusline help` | Show command and schema guidance |

The direct `settings`, `status`, and `help` routes remain for compatibility. RPC receives observable
notifications instead of TUI-only controls. Unknown subcommands and trailing arguments are rejected.

## Runtime behavior

### Responsive fitting

Each row keeps its configured segment order. If it is too wide, pi-statusline removes the
lowest-priority segment, recomputes the powerline transitions, and repeats until the row fits.
Retention priority is highest to lowest:

```text
context model branch tools cwd thinking cost provider tokens time turn brand
```

Explicit `line_break` entries remain row boundaries. A single segment that is still too wide is
ANSI-safely truncated.

### Activity, Git, and PR state

- During active work, `tools` shows `💭 thinking` or `⚙ <tool>` with parallel counts.
- Activity disappears after the agent settles and resets across session replacement or shutdown.
- Clean repositories show no Git counters.
- Dirty counters are `⇡` ahead, `⇣` behind, `+` staged, `~` modified/deleted, `?` untracked, and `!`
  conflicts.
- A linked GitHub PR appears with the branch when possible, avoiding a duplicate extension status.
- Context color changes to warning at 70% and error at 90%.
- Git state is cached outside footer rendering and stale session results are ignored.

## Settings

The extension uses one user-level file:

```text
<getAgentDir()>/pi-statusline.json
```

There are no project or environment overrides. On first session start, pi-statusline atomically
creates a complete editable default. It never overwrites malformed or unreadable settings. Settings
reload on startup, `/reload`, and session replacement.

A valid legacy `pi-statusline-settings.json` is migrated without rewriting its contents. If both files
exist, `pi-statusline.json` wins.

### Settings reference

| Field | Accepted values | Purpose |
| --- | --- | --- |
| `palettePreset` | `tokyo-night`, `ocean`, `sunset`, `forest`, `candy`, `neon`, `mono`, `custom` | Select the active color preset |
| `palette` | Per-segment `fg`/`bg` `#RRGGBB` colors | Define colors used by `custom` |
| `density` | `compact`, `cozy` | Control horizontal padding |
| `separator` | `none`, `dot`, `bar`, `powerline`, `round` | Separate adjacent segments in one color block |
| `segments` | Ordered unique segment names and `line_break` | Control visibility, order, and rows |
| `segmentText` | Per-segment `prefix` and `suffix` | Wrap Pi-owned dynamic values |
| `extensionStatusIcons` | Raw status key or `namespace:*` to icon string | Customize extension status icons |

All fields are optional in an existing document. Missing fields use defaults. Unknown fields produce a
warning but are preserved by menu saves. Invalid recognized values block saving, leaving the previous
file and live footer unchanged.

A compact customization example:

```json
{
  "palettePreset": "ocean",
  "density": "compact",
  "separator": "dot",
  "segments": ["model", "thinking", "cwd", "branch", "context", "cost"],
  "segmentText": {
    "context": { "prefix": "ctx ", "suffix": "" }
  },
  "extensionStatusIcons": {
    "goal": "◎",
    "foo:*": "🧪"
  }
}
```

Use **Advanced → Edit settings JSON** or `/statusline settings` to edit, validate, atomically save, and
apply the file.

## Appearance

Named palettes provide contrast-checked color ramps. Appearance previews update while the picker
moves, but save only when Enter is pressed; Escape restores the saved palette.

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

`segmentText` values must be single-line text without terminal control characters. Use `line_break`
for another row rather than inserting a newline into a prefix or suffix.

## Advanced layout

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
| Escape | Leave Move mode first, then close the screen |

Every successful change saves and applies immediately; closing the screen does not roll it back.

Available data segments:

```text
brand provider model thinking cwd branch tools context tokens cost time turn
```

Data segments must be unique. `line_break` may repeat when data segments separate occurrences, but
consecutive breaks are invalid. It has no `segmentText` entry. The menu cleans up leading, trailing,
and newly consecutive breaks after visibility changes. Manually authored leading/trailing breaks
represent empty rows.

```json
{
  "segments": ["model", "line_break", "cwd", "branch", "context"]
}
```

An empty `segments` array hides the main powerline while extension statuses can still render. The
extension intentionally has no variable or format language; use `pi-starship` when you need one.

## Extension statuses and icons

Other extension statuses appear below the main powerline, wrap to terminal width, and are limited to
five items. Icons resolve in this order:

1. Exact configured raw key, such as `goal` or `foo:server`.
2. Longest configured colon wildcard, such as `foo:*` or `foo:server:*`.
3. Unambiguous installed-package alias, such as `@vendor/pi-foo`, `pi-foo`, or `foo`.
4. Leading emoji supplied by the status text.
5. Built-in icon.
6. Generic `🔌` fallback.

Set an icon to `""` to hide only the icon. Wildcards match colon namespaces, not slash-delimited keys;
configure slash keys exactly. Compatibility fallbacks retain `codex-usage`, `pisync`, and
`unknown-error-retry`; an explicit canonical key wins.

For interoperable extensions, prefer one aggregated key or a stable coexistence slot:

```text
<extension-id>
<extension-id>:<stable-slot>
```

Put transient activity in the value and always clear the same complete key.

## Troubleshooting

- **Powerline symbols look wrong:** use a font with Powerline glyphs; emoji support is also recommended.
- **The footer reports settings warnings:** run `/statusline status`, then `/statusline settings` to fix
  invalid recognized fields.
- **The footer appears to be replaced:** disable `pi-starship` or another extension that also calls
  Pi's `setFooter()`.
- **A custom segment disappears on a narrow terminal:** check the responsive priority above or add an
  explicit `line_break`.

## Package layout

- `src/index.ts` — thin Pi entrypoint.
- `src/statusline.ts` — lifecycle, cached runtime state, and footer installation.
- `src/render.ts` and `src/powerline.ts` — semantic segments and responsive powerline rendering.
- `src/information-profiles.ts` — curated information levels.
- `src/commands.ts` and `src/settings.ts` — menu, validation, persistence, and migration.
- `src/extension-status.ts` and `src/git-status.ts` — extension and Git status formatting.
- `src/presets/` — built-in color presets.

## Keywords

Pi extension, Pi coding agent, statusline, Tokyo Night, powerline, responsive terminal footer,
context usage, model status.

## License

MIT. See [`LICENSE`](./LICENSE).
