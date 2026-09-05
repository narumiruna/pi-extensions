# 📈 pi-ticker — Show Market Quotes Above Pi's Editor

[![npm](https://img.shields.io/npm/v/@narumitw/pi-ticker)](https://www.npmjs.com/package/@narumitw/pi-ticker) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Pi Ticker shows configurable Yahoo Finance quotes in a width-aware widget above Pi's editor.

## ✨ Features

- Shows price, daily change, and daily percentage change for up to ten symbols.
- Starts empty and performs no quote requests until at least one symbol is added.
- Packs complete ticker entries into rows that fit the current terminal width.
- Provides searchable TUI and RPC menus for adding, removing, and reordering symbols.
- Persists widget visibility and the ordered symbol list in user settings.
- Refreshes every 30 seconds while enabled, keeps successful results, and marks failed symbols' previous quotes stale.
- Cancels polling, in-flight requests, and active menus during reload, session replacement, and shutdown.

## 📦 Install

Install from npm:

```bash
pi install npm:@narumitw/pi-ticker
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-ticker
```

Build and load this package from a local checkout:

```bash
npm --workspace @narumitw/pi-ticker run build
pi --no-extensions -e ./packages/pi-ticker
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.
Pi loads the generated TypeScript entrypoint through Jiti while menu code remains in lazy JavaScript chunks.

Extensions run with Pi's permissions, so install only trusted packages.

## 🚀 Quick start

Open the ticker manager in TUI mode:

```text
/ticker
```

Choose **Add custom ticker…** and enter a Yahoo Finance symbol such as `MSFT`, `SPY`, or `BTC-USD`.
The widget appears after the settings save and the first quote request completes.

## 🧭 Ticker manager

`/ticker` opens **Manage tickers** in TUI and RPC modes.
In TUI mode, one screen provides search, symbol removal, direct add, widget visibility, and refresh actions.
The configured confirm binding or Space activates the focused row.
When a valid search has no match, the add row changes to **Add SYMBOL** for direct addition.
`Shift+Up` and `Shift+Down` reorder the focused ticker when the search field is empty and those keys do not conflict with configured standard bindings.

RPC mode exposes portable dialogs for choosing and moving a ticker.
Each accepted change saves immediately.
If a save fails, the manager restores the previous displayed and effective value.
Removing the final symbol hides the widget and stops polling.
Escape closes transient TUI flows, and `Ctrl+C` remains a hard-close path.

## 💬 Commands

- `/ticker` opens the ticker manager.
- `/ticker <SYMBOL ...>` replaces the complete ordered symbol list and refreshes quotes.
- `/ticker refresh` refreshes quotes immediately when the widget is enabled.
- `/ticker help` shows direct-command usage.
- `/ticker reset` reports that no default symbol list exists and leaves settings unchanged.

Known routes reject trailing arguments.
All command routes support TUI and RPC modes.
Print and JSON modes reject the command before changing settings.

## ⚙️ Settings

The canonical user settings file is:

```text
<getAgentDir()>/pi-ticker.json
```

The normal path is `~/.pi/agent/pi-ticker.json`.
Pi's configured agent directory replaces `~/.pi/agent` when applicable.
Ticker preferences are user-scoped and apply across projects.
The extension does not read project settings or extension-specific environment-variable overrides.

A missing file uses an empty symbol list, keeps the widget enabled, and does not create the file, its parent directory, or a polling task.

The settings file must contain a JSON object with these optional fields:

| Field | Accepted values | Default | Behavior |
| --- | --- | --- | --- |
| `symbols` | Zero to ten Yahoo Finance symbol strings | `[]` | Controls the ordered quotes shown in the widget. |
| `widgetEnabled` | boolean | `true` | Controls widget visibility and quote polling. |

Each symbol may contain up to 15 uppercase letters, digits, `.`, `^`, `=`, or `-`.
Lowercase command and menu input is normalized to uppercase.

Example:

```json
{
  "symbols": ["NVDA", "BTC-USD", "ETH-USD"],
  "widgetEnabled": true
}
```

Unknown JSON fields are preserved during saves.
Malformed or invalid settings use runtime defaults and leave the file unchanged.
Pi shows a warning when UI is available.

Writes are ordered within one Pi process and published through a temporary file plus atomic rename.
Reload and session replacement wait for accepted writes before loading the next settings snapshot.
Separate Pi processes do not share a cross-process lock.
Settings reload on startup and `/reload`.

## 🔒 Security and privacy

The extension requests public quote metadata from Yahoo Finance over HTTPS without an API key.
Requested ticker symbols and the host network address are visible to Yahoo Finance.
The user settings file contains only ticker symbols and widget visibility; it stores no credential or secret.
The extension displays ticker symbols and quote data locally without adding them to model context.

## 🚧 Limitations

- Yahoo Finance is an unofficial dependency and may rate-limit, delay, change, or remove the endpoint.
- Quotes may be delayed and are not suitable for trading decisions.
- Each request times out after 10 seconds, and one symbol failure does not discard successful symbols.
- Each Pi session owns its polling queue, and separate Pi processes do not share one.

## 🗂️ Package layout

```text
packages/pi-ticker/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── ticker.ts                      # Quote polling and widget lifecycle
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, market quotes, stock ticker, Yahoo Finance, editor widget, terminal UI, TypeScript.

## 📄 License

[MIT](./LICENSE)
