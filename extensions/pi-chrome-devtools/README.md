# 🌐 pi-chrome-devtools — Chrome DevTools Tools for Pi Agents

[![npm](https://img.shields.io/npm/v/@narumitw/pi-chrome-devtools)](https://www.npmjs.com/package/@narumitw/pi-chrome-devtools) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-chrome-devtools` is a native [Pi coding agent](https://pi.dev) extension that exposes Chrome DevTools Protocol (CDP) automation as Pi tools.

Use it to let the Pi agent inspect browser tabs, navigate pages, evaluate JavaScript, and capture screenshots while debugging web apps or validating UI behavior.

This package is inspired by [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp), but it is implemented as native Pi tools instead of an MCP server.

## ✨ Features

- Lists inspectable Chrome tabs and pages.
- Selects an active Chrome page for later tool calls.
- Navigates Chrome to a target URL, creating an inspectable page when none exists.
- Recovers from stale active page selections by falling back to an available page.
- Evaluates JavaScript in the selected page.
- Captures PNG screenshots, including optional full-page screenshots, and saves them to disk.
- Renders compact tool results that expand/collapse with Pi's default output toggle (`Ctrl+O`).
- Reuses an existing Chrome DevTools Protocol endpoint when one is already available.
- Lazily auto-launches a Chromium-family browser for missing local endpoints, with Chrome,
  Chromium, Brave, and Edge fallbacks.
- Uses a dynamic managed DevTools port by default to avoid port conflicts, while preserving
  explicit endpoint overrides.
- Retries briefly while Chrome is starting and reports actionable endpoint errors.
- Shows statusline activity only while Chrome DevTools tools are running.
- Provides a `/chrome-devtools` menu with quick-start help and tool controls.
- Provides a Plan-mode-style selector for choosing individual Chrome DevTools tools.
- Persists the selected Chrome DevTools tools across Pi restarts.

## 📦 Install

```bash
pi install npm:@narumitw/pi-chrome-devtools
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-chrome-devtools
```

Try this package locally from the repository root:

```bash
pi -e ./extensions/pi-chrome-devtools
```

## 🚀 Browser startup

The extension first tries the configured endpoint, defaulting to `127.0.0.1:9222`. If that
local endpoint is unavailable, it lazily launches an extension-owned Chromium-family browser with
an isolated temp profile and then retries the CDP request. Existing endpoints are reused and are
not terminated by the extension.

When `PI_CHROME_DEVTOOLS_PORT` is not set, auto-launch uses Chrome's dynamic DevTools port mode
(`--remote-debugging-port=0`) and reads `DevToolsActivePort` from the temp profile. This avoids
forcing every Pi session onto port `9222`. If you set `PI_CHROME_DEVTOOLS_PORT` to a valid port
(`1`-`65535`), the extension uses that explicit port for both attach and auto-launch. Empty or
invalid port values are ignored and fall back to the default attach-first behavior.

When `PI_CHROME_DEVTOOLS_BROWSER` is set, that executable is the only auto-launch candidate; a
missing or unusable forced browser reports an error instead of falling back. Without that override,
browser discovery checks platform-specific Chrome, Chromium, Brave, and Microsoft Edge candidates.
Disable auto-launch to keep the older manual flow:

```bash
PI_CHROME_DEVTOOLS_AUTO_LAUNCH=0 pi -e ./extensions/pi-chrome-devtools
```

Force a browser executable or endpoint if needed:

```bash
PI_CHROME_DEVTOOLS_BROWSER=/usr/bin/brave-browser pi -e ./extensions/pi-chrome-devtools
PI_CHROME_DEVTOOLS_HOST=127.0.0.1 PI_CHROME_DEVTOOLS_PORT=9223 pi -e ./extensions/pi-chrome-devtools
```

Manual launch still works and is required for remote endpoints, opt-out mode, or unsupported WSL
browser/profile path setups:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/pi-chrome-devtools
```

On macOS:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pi-chrome-devtools
```

On session shutdown, the extension terminates only browser processes it started itself and
best-effort removes their temp profiles. It never closes user-started browsers or remote
endpoints.

## 🛠️ Pi tools

- `chrome_devtools_list_pages` — list inspectable Chrome tabs/pages.
- `chrome_devtools_select_page` — select the active page for later tool calls.
- `chrome_devtools_navigate` — navigate a page to a URL; if no page exists, create one first.
- `chrome_devtools_evaluate` — evaluate JavaScript in the selected page.
- `chrome_devtools_screenshot` — capture a PNG screenshot and save it as a PNG file.

### Screenshot files

`chrome_devtools_screenshot` always saves the captured PNG to disk. If `savePath` is omitted,
the extension writes a unique temp file such as:

```text
/tmp/pi-chrome-devtools-screenshot-<uuid>.png
```

Pass `savePath` to choose the output path:

```js
chrome_devtools_screenshot({
  fullPage: true,
  savePath: "artifacts/homepage.png",
});
```

Relative `savePath` values resolve from Pi's current working directory. A single leading `@`
is stripped to match Pi file-mention paths. Absolute paths are accepted only when they stay
inside the current working directory or the OS temp directory. Paths containing `..` segments,
NUL bytes, symlinked parent directories, directories as targets, final symbolic-link targets, or
other non-regular file targets are rejected. Existing regular files at the target path are
replaced. The tool result includes the resolved path, byte count, and an inline image block when
the active model/provider can consume images. If the model cannot inspect the inline image, ask it
to read the saved path, for example `read({ path: "artifacts/homepage.png" })`.

## 💬 Command

```text
/chrome-devtools
```

Opens a menu with quick-start help, command usage, tool status, controls for enabling or
disabling all Chrome DevTools tools, and a selector for choosing individual tools.

Direct subcommands are also available:

```text
/chrome-devtools help
/chrome-devtools quickstart
/chrome-devtools status
/chrome-devtools tools
/chrome-devtools toggle
/chrome-devtools enable
/chrome-devtools disable
```

- `help` shows command usage.
- `quickstart` shows the configured CDP endpoint, endpoint source, auto-launch mode, browser
  candidates, last launch attempt, and launch hints.
- `status` shows runtime tool state, persisted selection, settings file path, endpoint source,
  launch mode, last launch attempt, and active non-Chrome tool count.
- `tools` opens a Plan-mode-style selector for choosing individual `chrome_devtools_*` tools.
- `toggle` is an alias for `tools`.
- `enable` enables all `chrome_devtools_*` tools for future turns.
- `disable` disables all `chrome_devtools_*` tools for future turns. The slash command remains
  available.

The selected tool names are saved to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools.json
```

When the file is missing or invalid, the extension preserves Pi's current active-tool policy
instead of enabling tools by itself. A valid saved selection is restored on Pi startup and
`/reload`.

Compatibility: older versions used `pi-chrome-devtools-settings.json`. During the migration
window, a legacy-only file is automatically migrated to `pi-chrome-devtools.json` with a warning.
If both files exist, `pi-chrome-devtools.json` wins and the legacy file is ignored. The legacy
filename is deprecated and planned for removal after at least one minor release cycle, preferably
4–8 weeks, or at the next major release.

## 🧠 Use cases

- Debug front-end applications with an AI coding agent.
- Verify DOM state after code changes.
- Capture screenshots for visual inspection.
- Drive local browser workflows without a separate MCP server.
- Combine with Pi coding tools for end-to-end web app fixes.

## 🗂️ Package layout

```txt
extensions/pi-chrome-devtools/
├── src/
│   ├── chrome-devtools.ts  # Pi entrypoint and command orchestration
│   └── *.ts                # Package-local browser, CDP, tool, and storage modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

Only `chrome-devtools.ts` is a Pi entrypoint; the other source modules are internal. The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/chrome-devtools.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, Chrome DevTools Protocol, CDP, browser automation, web debugging, JavaScript evaluation, screenshot automation, AI coding agent tools.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
