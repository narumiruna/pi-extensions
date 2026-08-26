# ✨ pi-statusline — Add a Ready-to-Use Powerline Footer to Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Add an opinionated Powerline-style footer that works without setup and keeps the most useful Pi, workspace, Git, usage, and time context visible as the terminal narrows.

A representative uncolored layout:

```text
░▒▓ 🤖 sonnet-4 🧠 high 📁 pi-extensions 🌿 main ~2 🪟 ctx 42.0%/200k 🕒 16:42
```

## ✨ Features

- Works immediately with a balanced default for model, thinking, workspace, Git, context, activity, and time.
- Removes lower-priority segments before important information is clipped.
- Shows activity only while Pi is streaming or running tools.
- Adds optional token, prompt-cache, provider usage, and cost details.
- Offers three information levels, seven previewable palettes, and advanced custom layouts.
- Loads a generated split runtime to reduce Pi package startup work.

> **Need more customization?**
> See
> [`pi-starship`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-starship) ([npm](https://www.npmjs.com/package/@narumitw/pi-starship)).
> It uses a
> [Starship-inspired](https://starship.rs/) TOML format and style syntax for deeper control over layout, modules, and colors.
> Choose `pi-statusline` for practical defaults and quick setup.
>
> Do not enable both extensions at the same time because both own Pi's footer.

## 📦 Install

```bash
pi install npm:@narumitw/pi-statusline
```

Try the published package without installing it permanently:

```bash
pi -e npm:@narumitw/pi-statusline
```

Build the generated runtime and try the local package from this repository:

```bash
npm --workspace @narumitw/pi-statusline run build
pi -e ./packages/pi-statusline
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

For the best result, use a terminal font that includes Powerline glyphs and emoji.

## 🚀 Quick start

Install the extension and start Pi to use the balanced default immediately.
Run `/statusline` to preview and apply an appearance or information level.

## 🎛️ Menu and information levels

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

Selecting a level replaces only the `segments` array.
Unknown and unrelated JSON fields are preserved.

| Level | Included segments |
| --- | --- |
| **Minimal** | `model cwd branch context` |
| **Balanced** (default) | `model thinking cwd branch tools context time` |
| **Detailed** | `provider model thinking cwd branch tools context tokens cache cost time` |
| **Custom** | Any other segment order, including explicit line breaks |

The `tools` segment takes no space while idle.
`cache` takes no space when Pi has reported no cache reads or writes.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/statusline` | Open Appearance, Information, Advanced, Status, and Help |
| `/statusline settings` | Open the JSON editor in TUI mode |
| `/statusline status` | Show the effective settings and diagnostics |
| `/statusline help` | Show command and schema guidance |

The direct `settings`, `status`, and `help` routes remain for compatibility.
The root standard menu is TUI-only; Escape returns from Advanced or closes Main.
RPC receives observable notifications instead of TUI-only controls.
Unknown subcommands and trailing arguments are rejected.
The standard palette picker owns navigation and cleanup while pi-statusline still owns footer previews, settings, and rollback.
The width-aware layout editor and JSON editor remain specialized UI.

## 📐 Runtime behavior

### Responsive fitting

Each row keeps its configured segment order.
If it is too wide, pi-statusline removes the lowest-priority segment, recomputes the powerline transitions, and repeats until the row fits.
Retention priority is highest to lowest:

```text
context model branch tools cwd thinking cost provider cache tokens time turn brand
```

Explicit `line_break` entries remain row boundaries.
If the last remaining segment is itself wider than the row, that row renders empty rather than emitting an over-width line.

### Directory, activity, Git, and PR state

- `cwd` uses Starship's directory presentation defaults: contract the home directory to `~`, contract to the Git repository root when available, then retain at most the last three path components.
  This changes display only; the configured segment list and Pi working directory are untouched.
- Repository-root discovery is cached with Git status outside footer rendering; a failed root query falls back to home/path-component contraction without hiding the segment.
- During active work, `tools` shows `💭 thinking` or `⚙ <tool>` with parallel counts.
- Activity disappears after the agent settles and resets across session replacement or shutdown.
- Clean repositories show no Git counters.
- Dirty counters are `⇡` ahead, `⇣` behind, `+` staged, `~` modified/deleted, `?` untracked, and `!`
  conflicts.
- A linked GitHub PR appears with the branch when possible, avoiding a duplicate extension status.
- Context color changes to warning at 70% and error at 90%.
- Git state is cached outside footer rendering and stale session results are ignored.

### Usage and context

- `context` renders one-decimal current usage and the model window, such as `2.4%/272k`.
  After compaction it can temporarily render `?/272k` until the next valid assistant response.
- `tokens`, `cache`, and `cost` total every usage-bearing session entry, matching Pi's native footer.
  This includes assistant messages, nested-LLM tool results, compactions, and branch summaries, including abandoned branches retained in the session.
- Cache tokens are `R<read>`, `W<write>`, and `CH<rate>`.
  `R` and `W` are cumulative; `CH` uses only the latest assistant prompt: `cacheRead / (input + cacheRead + cacheWrite) * 100`.
- Subscription-backed OAuth models and `kimi-coding` append `(sub)` to cost.
  The dollar value is usage cost, not proof of an amount billed under a subscription.
- Pi's public extension API does not expose the current auto-compaction toggle, so this footer cannot reliably show the native `(auto)` marker.

## ⚙️ Settings

The extension uses one user-level file:

```text
<getAgentDir()>/pi-statusline.json
```

There are no project or environment overrides.
When the file is absent, pi-statusline uses its built-in defaults without creating the file or parent directory.
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
Unknown fields produce a warning but are preserved by menu saves.
Invalid recognized values block saving, leaving the previous file and live footer unchanged.

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
An empty `truncationSymbol` truncates without a marker. pi-statusline treats model IDs as opaque strings and does not parse paths, repositories, GGUF suffixes, or quantization names.
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
Every successful change saves and applies immediately; closing the screen does not roll it back.

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
The extension intentionally has no variable or format language; use `pi-starship` when you need one.

## 🔌 Extension statuses and icons

Other extension statuses appear below the main powerline, wrap to terminal width, and are limited to five items.
Icons resolve in this order:

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

Put transient activity in the value and always clear the same complete key.

## 🛠️ Troubleshooting

- **Powerline symbols look wrong:** use a font with Powerline glyphs; emoji support is also recommended.
- **The footer reports settings warnings:** run `/statusline status`, then `/statusline settings` to fix invalid recognized fields.
- **The footer appears to be replaced:** disable `pi-starship` or another extension that also calls Pi's `setFooter()`.
- **A custom segment disappears on a narrow terminal:** check the responsive priority above or add an explicit `line_break`.

## 🗂️ Package layout

```text
packages/pi-statusline/
├── dist/                  # generated split TypeScript runtime loaded by Jiti
├── scripts/
│   └── build-runtime.mjs  # deterministic runtime bundler and eager-boundary validator
├── src/
│   ├── index.ts          # thin entrypoint forwarding to the source runtime
│   ├── statusline.ts     # authoritative lifecycle implementation
│   ├── command-contract.ts
│   ├── render.ts
│   ├── directory.ts
│   ├── usage.ts
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

`src/` is the authoritative implementation, and `src/index.ts` remains its thin source forwarder.
The package build emits the sole declared Pi entrypoint at `dist/index.ts` without forwarding back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, statusline, Tokyo Night, powerline, responsive terminal footer, context usage, prompt cache, cache hit rate, model status.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
