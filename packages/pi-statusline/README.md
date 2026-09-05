# ✨ pi-statusline — Add a Ready-to-Use Powerline Footer to Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-statusline)](https://www.npmjs.com/package/@narumitw/pi-statusline) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Add a Powerline-style footer that works without setup and keeps important Pi, workspace, Git, usage, and time context visible as the terminal narrows.

A representative uncolored layout:

```text
░▒▓ 🤖 sonnet-4 🧠 high 📁 pi-extensions 🌿 main ~2 🪟 ctx 42.0%/200k 🕒 16:42
```

## ✨ Features

- Works immediately with a balanced default for model, thinking, workspace, Git, context, activity, and time.
- Removes lower-priority segments before important information is clipped.
- Shows when Pi is waiting for an extension UI prompt, streaming, or running tools.
- Adds optional token, prompt-cache, provider usage, and cost details.
- Offers three information levels, seven previewable palettes, and advanced custom layouts.
- Uses ANSI-256 palette colors when Pi's effective terminal capabilities disable true color.
- Loads a generated split runtime to reduce Pi package startup work.

> **Need more customization?**
> See [`pi-starship`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-starship) ([npm](https://www.npmjs.com/package/@narumitw/pi-starship)).
> It uses [Starship-inspired](https://starship.rs/) TOML and style syntax for deeper control over layout, modules, and colors.
> Choose `pi-statusline` for practical defaults and quick setup.

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

The package declares `dist/index.ts`, so build an unbuilt local checkout before Pi loads the package directory.
Install only from sources you trust because Pi extensions run with Pi's permissions.

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
| **Information** | Preview and apply a curated segment set |
| **Advanced** | Open Custom layout or Edit settings JSON |
| **Status** | Show the effective source, path, appearance, layout, and diagnostics |
| **Help** | Show command and schema guidance |

### Information levels

Selecting a level replaces only `segments` and preserves unrelated JSON fields.

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
| `/statusline` | Customize footer appearance, information density, and layout. |
| `/statusline settings` | Edit the settings JSON. |
| `/statusline status` | Show effective settings and diagnostics. |
| `/statusline help` | Show command and schema guidance. |

The menu and editor require TUI; RPC receives notifications instead, including the manual settings path for `settings`.
Status and help support TUI and RPC; print and JSON modes produce no command output.
Unknown subcommands and trailing arguments are rejected.
Palette previews save on Enter and revert on Escape, but layout changes save immediately and are not undone by closing the editor; see the [configuration guide](./docs/configuration.md).

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
- During active work, `tools` shows `⌨ waiting for <kind>`, `💭 thinking`, or `⚙️ <tool>` with parallel counts.
- A sanitized prompt title follows the prompt kind when available.
- Prompt waiting takes precedence without losing the underlying tool or streaming state, which returns when the prompt closes.
- Activity disappears after the agent settles and resets across session replacement or shutdown.
- Clean repositories show no Git counters.
- Dirty counters are `⇡` ahead, `⇣` behind, `+` staged, `~` modified/deleted, `?` untracked, and `!`
  conflicts.
- A linked or plain GitHub PR reference appears with the branch when possible, avoiding a duplicate extension status.
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

Use `/statusline` for appearance and information presets, or **Advanced → Edit settings JSON** (`/statusline settings`) for a custom document.
The only settings file is `<getAgentDir()>/pi-statusline.json`; there are no project or environment overrides.

A minimal customization selects a palette and a few segments:

```json
{
  "palettePreset": "ocean",
  "segments": ["model", "cwd", "branch", "context"]
}
```

A missing file uses the balanced built-in footer without creating the file or its parent directory.
The first successful save creates an editable document atomically.
Menu saves preserve unknown fields; invalid recognized values block saving and keep the live footer unchanged.
Malformed or unreadable files are never overwritten.
Manual edits load at startup, `/reload`, or session replacement.

Appearance previews save only on Enter, while Escape restores the saved palette.
Custom-layout changes save immediately, so closing that screen does not undo them.

Read the [configuration reference](./docs/configuration.md) for all settings, palettes, model truncation, multiline layouts, effective layout controls, extension-status icon precedence, and legacy-file handling.

## 🚧 Limitations

- The footer needs Powerline glyphs and emoji for its intended appearance.
- Pi does not arbitrate footer ownership, so another footer extension can replace pi-statusline.
- Custom layouts support ordered segments and line breaks, not a variable or format language.

## 🛠️ Troubleshooting

- **Powerline symbols look wrong:** use a font with Powerline glyphs and emoji support.
- **The footer reports settings warnings:** run `/statusline status`, then `/statusline settings` to fix invalid recognized fields.
- **The footer appears to be replaced:** disable `pi-starship` or another extension that also calls Pi's `setFooter()`.
- **A custom segment disappears on a narrow terminal:** check the responsive priority above or add an explicit `line_break`.

## 🗂️ Package layout

```text
packages/pi-statusline/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── statusline.ts                  # Responsive footer lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, statusline, Tokyo Night, powerline, responsive terminal footer, context usage, prompt cache, cache hit rate, model status.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
