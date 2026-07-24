# ✨ pi-statusline — Configurable Tokyo Night Footer for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-statusline` is a native [Pi coding agent](https://pi.dev) extension that replaces Pi's footer with a configurable Tokyo Night powerline statusline.

## ✨ Features

- Shows provider, model, thinking, directory, Git/PR state, tools, context, tokens, cost, time, and extension statuses.
- Uses one Starship-inspired `░▒▓` / `` Tokyo Night layout.
- Configures segment order, visibility, multiline breaks, surrounding text, palette, density, separators, and extension icons through JSON.
- Shows, hides, and reorders data segments from a grouped, row-aware `/statusline` menu, applying each change immediately.
- Creates an editable default configuration without an inactive custom palette on first session start.
- Previews palette presets as the picker cursor moves, then applies the selection only on Enter.
- Applies validated JSON settings edits from the `/statusline` menu immediately after an atomic save.
- Caches Git state outside footer rendering and guards stale session results.
- Wraps extension statuses safely at narrow terminal widths.

## 📦 Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try it once or from a checkout:

```bash
pi -e npm:@narumitw/pi-statusline
pi -e ./extensions/pi-statusline
```

Do not enable this together with `@narumitw/pi-starship`: both extensions own Pi's footer. Use `pi-starship` instead when you need full Starship-style format/style grammar.

## ⚙️ Configuration

The only configuration source is:

```text
<getAgentDir()>/pi-statusline.json
```

On first session start, the extension atomically creates an editable default document containing every active appearance and status-icon setting. The inactive custom `palette` is added only when needed. It never overwrites an existing malformed or unreadable file. A valid legacy `pi-statusline-settings.json` is migrated by preserving its original bytes; the canonical filename wins when both exist.

There are no project overrides or environment-variable overrides.

### Default JSON

```json
{
  "palettePreset": "tokyo-night",
  "density": "compact",
  "separator": "none",
  "segments": [
    "brand",
    "provider",
    "model",
    "thinking",
    "cwd",
    "branch",
    "tools",
    "context",
    "tokens",
    "cost",
    "time"
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

All fields are optional in an existing document. Missing fields use defaults.

### Appearance

- `palettePreset`: `tokyo-night`, `ocean`, `sunset`, `forest`, `candy`, `neon`, `mono`, or `custom`.
- `palette`: maps each segment to foreground (`fg`) and background (`bg`) colors used by `custom`.
- `density`: `compact` or `cozy`.
- `separator`: `none`, `dot`, `bar`, `powerline`, or `round`.

Named presets use cohesive namesake color ramps while preserving an existing custom `palette` object. Selecting `custom` activates that object. When no palette object exists, choosing `custom` from `/statusline` writes a complete per-segment copy of the active named preset before activating it, so customization starts from the current appearance. The picker labels this editing relationship, and the main menu's `Edit settings JSON (custom colors, layout, icons)` action opens the existing JSON editor. It does not force an editor or present a separate per-color menu.

If both fields exist, `palettePreset` decides which colors render. A palette object without `palettePreset` selects `custom`; with neither field, the default is `tokyo-night`. A manually authored `"palettePreset": "custom"` without a palette uses the built-in Tokyo Night colors. Legacy string palettes such as `"palette": "ocean"` remain accepted as preset selections.

Each custom palette color must be a complete `#RRGGBB` truecolor value. Within an explicit `palette` object, missing segment entries or `fg`/`bg` fields remain unstyled and do not inherit colors from Tokyo Night. The separator applies only between adjacent segments in the same color block, and transitions use ``. Extension statuses remain on separate wrapped lines with their preset-colored separator; `custom` leaves that separator unstyled.

For example, after moving `time` before the header segments, select `custom` and give it the same colors as the Tokyo Night header to keep one continuous block:

```json
{
  "palettePreset": "custom",
  "segments": ["time", "brand", "provider", "model"],
  "palette": {
    "time": {
      "fg": "#090c0c",
      "bg": "#a3aed2"
    }
  }
}
```

Adjacent custom segments with the same configured foreground and background render as one block. Segments with no configured colors also join into one unstyled block. Invalid presets or colors prevent the menu's JSON settings action from saving. Unknown segment names or palette fields are reported as warnings and ignored.

### Segments

`segments` is an ordered list containing:

```text
brand provider model thinking cwd branch tools context tokens cost time turn line_break
```

The array controls visibility and actual rendering order. Data segments must remain unique. The special `line_break` segment starts another footer row and may repeat when another segment separates each occurrence; consecutive `line_break` entries are invalid. Each row receives its own powerline start and end. `line_break` has no `segmentText` entry.

Use `/statusline` → `Segments` to show, hide, or reorder data segments without editing JSON. The bounded screen groups visible segments in their effective render order and hidden segments separately, labels every visible segment with the footer row derived from `line_break`, and keeps the selected segment in view. Use Up and Down to navigate, Page Up and Page Down for larger jumps, and Enter or Space to show or hide. Press `M` to enter Move mode, where ordinary Up and Down move the selected visible segment; Enter, Space, or Escape leaves Move mode. `Alt+Up` and `Alt+Down` remain quick-move accelerators, and Escape closes the normal screen. Hidden segments and first/last boundaries explain in place why a move is unavailable.

Every successful toggle or move is atomically saved and applied immediately; leaving Move mode or closing the screen does not undo earlier changes. Remaining segments keep their relative order, newly shown segments are appended to the final row, and leading, trailing, or newly consecutive `line_break` entries are removed after a toggle. Reordering swaps data segments around existing `line_break` positions, so displayed row boundaries stay in place while a segment can move between rows. Continue using the JSON editor when you need to place line breaks at exact positions.

An empty array hides the main powerline while still allowing extension statuses to render. `turn` is available but omitted by default.

Example multiline layout:

```json
{
  "segments": ["model", "line_break", "cwd", "line_break", "branch"]
}
```

This is valid because the `line_break` entries are separated. `["model", "line_break", "line_break", "cwd"]` is invalid.

### Segment text

Each visible segment renders as:

```text
prefix + Pi-owned dynamic value + suffix
```

Override either string independently:

```json
{
  "segmentText": {
    "provider": { "prefix": "Provider: " },
    "context": { "prefix": "[", "suffix": "]" },
    "cost": { "prefix": "Cost $", "suffix": " USD" }
  }
}
```

Prefix and suffix values must be single-line text without terminal control characters; use the `line_break` segment for additional rows. The built-in prefixes are `🔌 ` for provider, `🤖 ` for model, `🧠 ` for thinking, `📁 ` for cwd, `🌿 ` for branch, `🪟 ctx ` for context, `🔢 ` for tokens, `💸 $` for cost, `🕒 ` for time, and `🔁 #` for turn; brand and tools have no built-in prefix, and all built-in suffixes are empty.

This structured model intentionally does not provide variables or a format language. Dynamic Git, PR, activity, usage, token, and cost formatting remains owned by the extension.

### Extension status icons

`extensionStatusIcons` accepts any raw key emitted through Pi's `ctx.ui.setStatus()`; it is not
restricted to extensions in this repository. Icons resolve in this order:

1. An exact configured raw key, such as `goal` or `foo:server`.
2. The longest explicit colon namespace wildcard, such as `foo:*` or `foo:server:*`.
3. An unambiguous installed package alias such as `@vendor/pi-foo`,
   `npm:@vendor/pi-foo@1.2.3`, `pi-foo`, or `foo`.
4. A leading emoji supplied by the status text.
5. A built-in icon.
6. The generic `🔌` fallback.

An empty icon at any configured match hides the icon while retaining status text. `foo:*` matches
`foo:server` and `foo:server:worker`, but not `foo`, `foobar`, or `foo/server`; use an exact key for a
slash-delimited third-party status. Installed-package aliases retain delimiter-bound colon and slash
matching for compatibility, but ambiguous package aliases are ignored.

```json
{
  "extensionStatusIcons": {
    "third_party/key": "🧩",
    "foo:*": "🧪",
    "foo:server": "🖥️",
    "@vendor/pi-other": "📦",
    "quiet-extension": ""
  }
}
```

Built-in icon mappings for current repository statuses are `accounts` → `👤`, `caffeinate` → `💊`,
`chrome-devtools` → `🌐`, `firecrawl` → `🔥`, `github-pr` → `🔎`, `goal` → `🎯`, `google-genai` →
`✨`, `lsp` → `🧰`, `plan-mode` → `📝`, `retry` → `🔁`, `subagents` → `🧑‍🤝‍🧑`, `sync` → `🔄`,
and `usage` → `📊`. Compatibility fallbacks retain `codex-usage`, `pisync`, and
`unknown-error-retry`. Existing `pisync` or `unknown-error-retry` settings continue to configure the
new `sync` or `retry` statuses when the canonical key is absent; files are not rewritten, and an
explicit canonical key wins.

#### For extension authors

Pi accepts any string as a status key. pi-statusline cannot force another extension to follow a key
format, and Pi does not expose which package owns a status. Exact raw-key matching is therefore the
only universally reliable icon contract. Namespace wildcards and package aliases are conveniences,
not authoritative ownership.

For interoperable new extensions, prefer a stable lowercase kebab-case key:

```text
<extension-id>
<extension-id>:<stable-slot>
```

Use the first form for one aggregated status. Use a stable slot only when statuses must coexist, for
example `lsp:typescript`; put transient activity in the value (`setStatus("sync", "pushing")`) rather
than creating keys such as `sync:pushing`. Always clear the same complete key. This is a convention
other authors may adopt, not a requirement for appearing in pi-statusline.

Statuses from other extensions appear below the main powerline. The linked GitHub PR status is hidden
from that line when the branch segment already renders it.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/statusline` | Open the interactive menu for palette presets, displayed segments, settings JSON, status, and help |
| `/statusline settings` | Open the JSON settings editor in TUI mode |
| `/statusline status` | Show the settings source, path, appearance, segments, and diagnostics |
| `/statusline help` | Show command and schema guidance |

Argument-free `/statusline` requires TUI mode. The established `settings`, `status`, and `help` routes remain available for compatibility; RPC receives notifications instead of opening TUI-only controls. Unknown subcommands and trailing arguments are rejected. In the palette picker, Up and Down preview the highlighted preset immediately, Enter saves it, and Escape restores the saved preset. In the Segments screen, each Enter or Space toggle and each Move-mode or `Alt+Up`/`Alt+Down` move saves immediately. Escape leaves Move mode first and closes the normal screen; neither action rolls back saved changes. Applying `custom` also points to the settings JSON palette editor. Invalid or cancelled unsaved changes leave both the previous file and effective runtime configuration unchanged.

## 🌿 Git and activity details

Git status tokens are hidden for clean repositories. When present, they mean `⇡` ahead, `⇣` behind, `+` staged, `~` modified/deleted, `?` untracked, and `!` conflicts.

The tools segment distinguishes active tools, streaming/thinking, the last completed tool, and idle state. Parallel calls are summarized without running subprocesses during footer rendering.

## 🗂️ Package layout

```text
extensions/pi-statusline/
├── src/
│   ├── index.ts
│   ├── ansi.ts
│   ├── commands.ts
│   ├── extension-status.ts
│   ├── git-status.ts
│   ├── powerline.ts
│   ├── presets/
│   │   ├── candy.ts
│   │   ├── create-ramp.ts
│   │   ├── custom.ts
│   │   ├── forest.ts
│   │   ├── index.ts
│   │   ├── mono.ts
│   │   ├── neon.ts
│   │   ├── ocean.ts
│   │   ├── sunset.ts
│   │   ├── tokyo-night.ts
│   │   └── types.ts
│   ├── render.ts
│   ├── settings.ts
│   ├── statusline.ts
│   └── types.ts
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`src/index.ts` is the Pi entrypoint and forwards to `src/statusline.ts`. Other modules are package-internal.

## 🔎 Keywords

Pi extension, Pi coding agent, configurable statusline, Tokyo Night, terminal footer, token usage, context window, model status, TypeScript Pi package.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
