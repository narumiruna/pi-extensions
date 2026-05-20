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
- Captures PNG screenshots, including optional full-page screenshots.
- Uses a local Chrome DevTools Protocol endpoint.
- Retries briefly while Chrome is starting and reports actionable endpoint errors.
- Shows statusline activity only while Chrome DevTools tools are running.

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

## 🚀 Start Chrome with CDP enabled

The extension connects to `127.0.0.1:9222` by default.

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/pi-chrome-devtools
```

On macOS:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pi-chrome-devtools
```

Override the endpoint if needed:

```bash
PI_CHROME_DEVTOOLS_HOST=127.0.0.1 PI_CHROME_DEVTOOLS_PORT=9223 pi -e ./extensions/pi-chrome-devtools
```

## 🛠️ Pi tools

- `chrome_devtools_list_pages` — list inspectable Chrome tabs/pages.
- `chrome_devtools_select_page` — select the active page for later tool calls.
- `chrome_devtools_navigate` — navigate a page to a URL; if no page exists, create one first.
- `chrome_devtools_evaluate` — evaluate JavaScript in the selected page.
- `chrome_devtools_screenshot` — capture a PNG screenshot.

## 💬 Command

```text
/chrome-devtools
```

Shows the configured CDP endpoint and a quick-start hint.

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
│   └── chrome-devtools.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

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
