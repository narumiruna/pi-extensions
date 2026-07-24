# ✨ pi-statusline — A Beautiful, Practical Footer for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-statusline` replaces Pi's footer with an opinionated powerline that looks good without
setup, keeps important context visible at narrow terminal widths, and offers shallow choices for
appearance and information density.

Choose `pi-statusline` for curated defaults. Use `@narumitw/pi-starship` instead when you want a full
Starship-style format and style grammar. Do not enable both packages because both own Pi's footer.

## ✨ Features

- Starts with a balanced layout for model, thinking level, workspace, Git/PR state, context use, and
  session cost.
- Fits each row responsively instead of blindly clipping consequential information from the right.
- Shows model streaming and tools only while work is active; idle and last-completed tools do not
  occupy permanent space.
- Offers Minimal, Balanced, and Detailed information levels without adding another settings field.
- Previews seven curated palettes before applying them.
- Keeps arbitrary segment layouts, multiline rows, custom colors/text, separators, density, and
  extension icons in one labeled Advanced path.
- Preserves existing JSON settings and `/statusline settings|status|help` routes.
- Caches Git state outside footer rendering and wraps extension statuses safely at narrow widths.

## 📦 Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try it once or from a checkout:

```bash
pi -e npm:@narumitw/pi-statusline
pi -e ./extensions/pi-statusline
```

## 🚀 Quick start

Run `/statusline` to open the primary menu:

```text
Appearance (tokyo-night)
Information (balanced)
Advanced
Status
Help
```

- **Appearance** previews a palette with Up/Down. Enter applies it; Escape restores the saved look.
- **Information** previews the exact segments in each curated level. Enter atomically saves and applies
  the level; Escape leaves the file and footer unchanged.
- **Advanced** contains Custom layout, Edit settings JSON, and a Back path.
- **Status** shows the effective source, path, appearance, segments, and diagnostics.
- **Help** summarizes commands and settings.

### Information levels

The levels map directly to the existing `segments` array. Selecting one intentionally replaces a
custom layout while preserving unrelated and unknown JSON fields.

| Level | Segments |
| --- | --- |
| Minimal | `model cwd branch context` |
| Balanced (default) | `model thinking cwd branch tools context cost` |
| Detailed | `provider model thinking cwd branch tools context tokens cost time` |
| Custom | Any other segment array, including explicit line breaks |

The `tools` segment contributes content only during model streaming or active tool execution, so it
uses no space while idle.

### Responsive priority

Each configured row keeps its original order. When the complete row is wider than the terminal,
pi-statusline removes the lowest-priority configured segment and recomputes colors and transitions
until the row fits. The retention order, highest first, is:

```text
context model branch tools cwd thinking cost provider tokens time turn brand
```

This keeps context, model, location, and active work ahead of decorative or supporting data. Explicit
`line_break` entries remain row boundaries. If one remaining segment is itself wider than the row,
only that segment is ANSI-safely truncated.

## ⚙️ Settings

The only settings source is:

```text
<getAgentDir()>/pi-statusline.json
```

There are no project or environment overrides. On first session start the extension atomically
creates an editable default document. It never overwrites malformed or unreadable settings. A valid
legacy `pi-statusline-settings.json` is migrated by preserving its original bytes; the canonical file
wins when both exist.

Existing files are not rewritten on startup. Missing fields use defaults, unknown fields are preserved
by menu saves, invalid recognized fields block saves, and successful edits apply immediately. Settings
reload on session start, including reload and session replacement.

### Default JSON

```json
{
  "palettePreset": "tokyo-night",
  "density": "compact",
  "separator": "none",
  "segments": [
    "model",
    "thinking",
    "cwd",
    "branch",
    "tools",
    "context",
    "cost"
  ],
  "segmentText": {
    "brand": { "prefix": "", "suffix": "" },
    "provider": { "prefix": "🔌 ", "suffix": "" },
    "model": { "prefix": "🤖 ", "suffix": "" },
    "thinking": { "prefix": "🧠 ", "suffix": "" },
    "cwd": { "prefix": "📁 ", "suffix": "" },
    "branch": { "prefix": "🌿 ", "suffix": "" },
    "tools": { "prefix": "", "suffix": "" },
    "context": { "prefix": "🪟 ctx ", "suffix": "" },
    "tokens": { "prefix": "🔢 ", "suffix": "" },
    "cost": { "prefix": "💸 $", "suffix": "" },
    "time": { "prefix": "🕒 ", "suffix": "" },
    "turn": { "prefix": "🔁 #", "suffix": "" }
  },
  "extensionStatusIcons": {
    "accounts": "👤",
    "caffeinate": "💊",
    "chrome-devtools": "🌐",
    "firecrawl": "🔥",
    "github-pr": "🔎",
    "goal": "🎯",
    "google-genai": "✨",
    "lsp": "🧰",
    "plan-mode": "📝",
    "retry": "🔁",
    "subagents": "🧑‍🤝‍🧑",
    "sync": "🔄",
    "usage": "📊"
  }
}
```

## 🎨 Appearance

`palettePreset` accepts `tokyo-night`, `ocean`, `sunset`, `forest`, `candy`, `neon`, `mono`, or
`custom`. Named presets provide cohesive, contrast-checked color ramps. The picker previews the
highlighted preset immediately and saves only on Enter.

Advanced appearance fields remain available through **Advanced → Edit settings JSON**:

- `density`: `compact` or `cozy`.
- `separator`: `none`, `dot`, `bar`, `powerline`, or `round` between adjacent segments in one color
  block.
- `palette`: per-segment `{ "fg": "#RRGGBB", "bg": "#RRGGBB" }` values used by `custom`.
- `segmentText`: per-segment single-line `prefix` and `suffix` strings around Pi-owned dynamic values.

Selecting `custom` without a palette copies the active named preset into a complete editable
per-segment palette. Named presets ignore but preserve an existing custom palette. A palette object
without `palettePreset` selects `custom`; a manually authored `"palettePreset": "custom"` without a
palette uses the built-in Tokyo Night colors. Legacy string palettes such as `"palette": "ocean"`
remain accepted. Missing custom entries or color fields stay unstyled rather than inheriting Tokyo
Night. Invalid colors or terminal control characters block saves; unknown fields are warned about and
preserved.

Powerline rows use the `░▒▓` lead and `` block transition. Adjacent custom segments with identical
colors join one block; unstyled custom segments join another unstyled block. Extension statuses remain
on separately wrapped lines.

## 🧩 Advanced layout

**Advanced → Custom layout** retains the existing layout editor for users who need more than the three
curated levels:

- Up/Down navigates; Page Up/Page Down moves by a viewport.
- Enter or Space shows or hides a segment and saves immediately.
- `M` enters Move mode; Up/Down reorders; Enter, Space, or Escape leaves Move mode.
- `Alt+Up` and `Alt+Down` are quick-move accelerators.
- `B` adds or removes a line break after the selected visible segment.
- Escape closes the normal screen. Saved changes are not rolled back on close.

Available data segments are:

```text
brand provider model thinking cwd branch tools context tokens cost time turn
```

Data segments must be unique. `line_break` may repeat when data segments separate occurrences, but
consecutive breaks are invalid and it has no `segmentText` entry. The menu removes leading, trailing,
or newly consecutive breaks after visibility changes; manually authored leading/trailing breaks
represent empty rows. Each non-empty row receives its own powerline lead/end, and responsive fitting
runs independently per row. An empty array hides the main powerline while still allowing extension
statuses to render.

Manual example:

```json
{
  "segments": ["model", "line_break", "cwd", "branch", "context"]
}
```

Each segment renders `prefix + dynamic value + suffix`. There is deliberately no variable or format
language; Git, PR, activity, usage, token, and cost formatting remain owned by the extension.

## 🔌 Extension statuses and icons

Statuses from other extensions appear below the main powerline and wrap to terminal width. A linked
GitHub PR status is omitted there when the branch segment already renders its actionable PR context.
At most five status items are shown.

`extensionStatusIcons` accepts arbitrary raw keys emitted through Pi's `ctx.ui.setStatus()` and resolves
icons in this order:

1. Exact configured raw key, such as `goal` or `foo:server`.
2. Longest explicit colon wildcard, such as `foo:*` or `foo:server:*`.
3. Unambiguous installed-package alias such as `@vendor/pi-foo`, `npm:@vendor/pi-foo@1.2.3`,
   `pi-foo`, or `foo`.
4. Leading emoji supplied by status text.
5. Built-in icon.
6. Generic `🔌` fallback.

An empty configured icon hides only the icon. Wildcards match colon namespaces, not slash-delimited
keys; configure those exactly. Compatibility fallbacks retain `codex-usage`, `pisync`, and
`unknown-error-retry`, with explicit canonical keys winning. Duplicate installed extension sources are
reported as a warning status.

For interoperable extensions, prefer a stable lowercase key:

```text
<extension-id>
<extension-id>:<stable-slot>
```

Use a stable slot only for independently coexisting statuses, such as `lsp:typescript`; put transient
activity in the value and always clear the same complete key.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/statusline` | Open Appearance, Information, Advanced, Status, and Help |
| `/statusline settings` | Open the JSON editor in TUI mode |
| `/statusline status` | Show effective source, path, appearance, segments, and diagnostics |
| `/statusline help` | Show command and schema guidance |

The argument-free command requires TUI mode. Established direct routes remain for compatibility. RPC
receives observable notifications instead of TUI-only controls; unknown subcommands and trailing
arguments are rejected.

## 🌿 Git and activity details

Git tokens are hidden for clean repositories. When present, they mean `⇡` ahead, `⇣` behind, `+`
staged, `~` modified/deleted, `?` untracked, and `!` conflicts. Git state refreshes outside footer
rendering on branch/activity events and a bounded interval, with stale session results ignored.

During active work, the tools segment shows `💭 thinking` or `⚙ <tool>` with parallel counts. It
vanishes after the agent settles and resets on session shutdown/replacement. Context color moves from
success to warning at 70% and error at 90%.

## 🗂️ Package layout

```text
extensions/pi-statusline/
├── src/
│   ├── index.ts
│   ├── statusline.ts
│   ├── render.ts
│   ├── powerline.ts
│   ├── information-profiles.ts
│   ├── commands.ts
│   ├── settings.ts
│   ├── extension-status.ts
│   ├── git-status.ts
│   ├── ansi.ts
│   ├── types.ts
│   └── presets/
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`src/index.ts` is the thin Pi entrypoint; all other modules are package-internal.

## 🔎 Keywords

Pi extension, Pi coding agent, statusline, Tokyo Night, powerline, responsive terminal footer,
context usage, model status.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
