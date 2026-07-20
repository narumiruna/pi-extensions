# ✨ pi-statusline — Configurable Tokyo Night Footer for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-statusline` is a native [Pi coding agent](https://pi.dev) extension that replaces Pi's footer with a configurable Tokyo Night powerline statusline.

## Features

- Shows provider, model, thinking, directory, Git/PR state, tools, context, tokens, cost, time, and extension statuses.
- Uses one Starship-inspired `░▒▓` / `` Tokyo Night layout.
- Configures segment order, visibility, multiline breaks, surrounding text, palette, density, separators, and extension icons through JSON.
- Creates a complete editable default configuration on first session start.
- Applies validated `/statusline settings` edits immediately after an atomic save.
- Caches Git state outside footer rendering and guards stale session results.
- Wraps extension statuses safely at narrow terminal widths.

## Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try it once or from a checkout:

```bash
pi -e npm:@narumitw/pi-statusline
pi -e ./extensions/pi-statusline
```

Do not enable this together with `@narumitw/pi-starship`: both extensions own Pi's footer. Use `pi-starship` instead when you need full Starship-style format/style grammar.

## Configuration

The only configuration source is:

```text
<getAgentDir()>/pi-statusline.json
```

On first session start, the extension atomically creates the complete default document. It never overwrites an existing malformed or unreadable file. A valid legacy `pi-statusline-settings.json` is migrated by preserving its original bytes; the canonical filename wins when both exist.

There are no project overrides or environment-variable overrides.

### Default JSON

```json
{
  "palette": "tokyo-night",
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
    "chrome-devtools": "🌐",
    "codex-usage": "📊",
    "caffeinate": "💊",
    "firecrawl": "🔥",
    "github-pr": "🔎",
    "goal": "🎯",
    "lsp": "🧰",
    "plan-mode": "📝",
    "pisync": "🔄",
    "subagents": "🧑‍🤝‍🧑",
    "unknown-error-retry": "🔁"
  }
}
```

All fields are optional in an existing document. Missing fields use defaults.

### Appearance

- `palette`: `tokyo-night`, `ocean`, `sunset`, `forest`, `candy`, `neon`, or `mono`.
- `density`: `compact` or `cozy`.
- `separator`: `none`, `dot`, `bar`, `powerline`, or `round`.

The separator applies only between adjacent segments in the same color block. Color-block transitions always use ``. Extension statuses remain on separate wrapped lines with their own palette-colored separator.

### Segments

`segments` is an ordered list containing:

```text
brand provider model thinking cwd branch tools context tokens cost time turn line_break
```

The array controls visibility and actual rendering order. Data segments must remain unique. The special `line_break` segment starts another footer row and may repeat when another segment separates each occurrence; consecutive `line_break` entries are invalid. Each row receives its own powerline start and end. `line_break` has no `segmentText` entry.

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

Prefix and suffix values must be single-line text without terminal control characters; use the `line_break` segment for additional rows.

This structured model intentionally does not provide variables or a format language. Dynamic Git, PR, activity, usage, token, and cost formatting remains owned by the extension.

### Extension status icons

`extensionStatusIcons` preserves these rules:

- An exact status key wins, such as `goal` or `foo:server`.
- Installed package aliases such as `@vendor/pi-foo`, `npm:@vendor/pi-foo@1.2.3`, `pi-foo`, or `foo` can configure namespaced statuses.
- An empty string hides the icon but keeps the status text.
- A missing key uses the built-in icon or `🔌` for an unknown key.
- Ambiguous package aliases require an exact status key.

Statuses from other extensions appear below the main powerline. The linked GitHub PR status is hidden from that line when the branch segment already renders it.

## Commands

| Command | Purpose |
| --- | --- |
| `/statusline settings` | Edit raw JSON in TUI, validate, atomically save, and apply immediately |
| `/statusline status` | Show settings path/source, effective appearance, segments, and diagnostics |
| `/statusline help` | Show command and schema guidance |

Invalid or cancelled edits leave both the previous file and effective runtime configuration unchanged. The editor is TUI-only; status and help are safe in TUI, print, JSON, and RPC modes.

## Git and activity details

Git status tokens are hidden for clean repositories. When present, they mean `⇡` ahead, `⇣` behind, `+` staged, `~` modified/deleted, `?` untracked, and `!` conflicts.

The tools segment distinguishes active tools, streaming/thinking, the last completed tool, and idle state. Parallel calls are summarized without running subprocesses during footer rendering.

## Package layout

```text
extensions/pi-statusline/
├── src/
│   ├── ansi.ts
│   ├── commands.ts
│   ├── extension-status.ts
│   ├── git-status.ts
│   ├── render.ts
│   ├── settings.ts
│   ├── statusline.ts
│   ├── tokyo-night.ts
│   └── types.ts
├── test/
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `src/statusline.ts` is a Pi entrypoint. Other modules are package-internal.

## Keywords

Pi extension, Pi coding agent, configurable statusline, Tokyo Night, terminal footer, token usage, context window, model status, TypeScript Pi package.

## License

MIT. See [`LICENSE`](./LICENSE).
