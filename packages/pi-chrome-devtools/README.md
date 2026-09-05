# 🌐 pi-chrome-devtools — Inspect and Control Chrome from Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-chrome-devtools)](https://www.npmjs.com/package/@narumitw/pi-chrome-devtools) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Inspect browser tabs, navigate pages, evaluate JavaScript, and capture screenshots from Pi through the Chrome DevTools Protocol.
Use these native Pi tools for web debugging, UI validation, and browser-assisted investigation without an MCP server.
The design is inspired by [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp), but compatibility is not guaranteed.

## ✨ Features

- Lists and selects inspectable pages, navigates URLs, evaluates JavaScript, and captures PNG screenshots.
- Reuses an existing CDP endpoint or launches an isolated Chromium-family browser on first use.
- Recovers from stale page selections and explains browser startup or endpoint failures.
- Loads explicitly approved unpacked extensions only in an extension-owned Chrome for Testing or Chromium process.
- Uses native deferred browser tools when supported and exposes allowed tools eagerly otherwise.
- Provides availability controls, setup guidance, status, and help through `/chrome-devtools`.
- Shows compact expandable results and activity only while browser tools are running.
- Persists reviewed tool availability while keeping browser connection settings machine-owned.
- Offers opt-in experimental WebMCP discovery and invocation through two fixed gateway tools without dynamically registering page-provided definitions.

## 📦 Install

Install persistently:

```bash
pi install npm:@narumitw/pi-chrome-devtools
```

Run once from npm:

```bash
pi -e npm:@narumitw/pi-chrome-devtools
```

Build and run a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-chrome-devtools run build
pi -e ./packages/pi-chrome-devtools
```

The package declares `dist/index.ts`, so build a local checkout before loading its package directory.

Pi extensions run with your user permissions.
Review third-party extension source before installing it.

## 🚀 Quick start

Start Pi and ask the agent to load the browser capability needed for the task.
By default, the extension tries `http://127.0.0.1:9222` and launches an isolated local Chromium-family browser if that endpoint is unavailable.
Run `/chrome-devtools` to review status, settings, help, and available tools.
WebMCP remains disabled until you explicitly enable it.

## 🌐 Browser setup

By default, the extension attaches to `http://127.0.0.1:9222` or launches an isolated local browser on first use.
It never closes an external browser.
Use `/chrome-devtools` → **Browser settings** to change the endpoint, auto-launch policy, or executable.

Read the [browser setup reference](./docs/browser-setup.md) for endpoint requirements, executable discovery, unpacked extensions, manual launch, and deprecated environment overrides.
Manual settings edits apply after `/reload` or session replacement.

> [!WARNING]
> Unpacked extensions execute privileged browser code; load only trusted code.
> They require an extension-owned Chrome for Testing or Chromium process.
> Trusted project settings may replace only the extension-path list, not machine-owned connection settings.

### Experimental WebMCP

> [!WARNING]
> WebMCP is experimental, disabled by default, and subject to Chrome protocol changes.
> Page tools use the visible page's current authentication and require confirmation on every call.

Enable `webmcp.enabled` only in user settings, then choose which gateway tools are available through `/chrome-devtools tools`.
Project settings cannot enable WebMCP or weaken confirmation.
See [WebMCP setup and troubleshooting](./docs/browser-setup.md#experimental-webmcp) for compatible Chrome builds, browser flags, schema limits, and stale-page recovery.

## 🛠️ Tools

- `chrome_devtools_load` — find and load browser capabilities relevant to a task.
- `chrome_devtools_list_pages` — list inspectable Chrome tabs/pages.
- `chrome_devtools_select_page` — select the active page for later tool calls.
- `chrome_devtools_navigate` — navigate a page to a URL; if no page exists, create one first.
- `chrome_devtools_evaluate` — evaluate JavaScript in the selected page.
- `chrome_devtools_screenshot` — capture a PNG screenshot and save it as a PNG file.
- `chrome_devtools_webmcp_list_tools` — list bounded frame-aware WebMCP descriptors from the selected page when experimental WebMCP is enabled.
- `chrome_devtools_webmcp_call_tool` — invoke one listed page tool after exact identity revalidation and user confirmation.

### Tool exposure

The extension registers eight tools: one loader, five stable DevTools capabilities, and two fixed experimental WebMCP gateways.
With native deferred-tool support, only `chrome_devtools_load` starts active.
The loader accepts a task-oriented `query`, matches it against the five stable capabilities plus enabled WebMCP gateways, and adds matching available tools without removing any active Pi tool.
Loaded capability tools remain active for the rest of the session unless the user makes them unavailable through `/chrome-devtools`.

Pi uses native deferred tool references on compatible Anthropic models, native additional-tools or tool-search loading on compatible OpenAI and Codex Responses models, and native Kimi loading on compatible OpenAI Chat Completions models.
Kimi-compatible models declare `compat.deferredToolsMode: "kimi"` in Pi's model metadata.
`azure-openai-responses` remains eager because Pi's Azure adapter does not implement native deferred tool-search serialization.

When the selected model/provider lacks native deferred support, the extension activates every capability allowed by settings before the next model request instead of using Pi's cache-invalidating lazy-loading fallback.
After a session enters eager exposure, it stays eager across later model switches to avoid removing tool definitions within that session.
The capability tools omit active-only prompt snippets so native deferred loading does not rebuild the system-prompt prefix.

The saved `tools` array controls which capabilities the extension may expose.
The `webmcp.enabled` gate takes precedence, so persisted WebMCP names cannot bypass a disabled gate.
Page-provided tool definitions appear only in list results and never alter Pi's provider-visible tool definitions.
An empty array leaves the loader active but makes every browser capability unavailable.

### Screenshot files

`chrome_devtools_screenshot` always saves the captured PNG to disk.
If `savePath` is omitted, the extension writes a unique temp file such as:

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

Relative `savePath` values resolve from Pi's current working directory.
A single leading `@` is stripped to match Pi file-mention paths.
Absolute paths are accepted only when they stay inside the current working directory or the OS temp directory.
Paths containing `..` segments, NUL bytes, symlinked parent directories, directories as targets, final symbolic-link targets, or other non-regular file targets are rejected.
Existing regular files at the target path are replaced.
The tool result includes the resolved path, byte count, and an inline image block when the active model/provider can consume images.
If the model cannot inspect the inline image, ask it to read the saved path, for example `read({ path: "artifacts/homepage.png" })`.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/chrome-devtools` | Manage browser-tool availability and browser settings. |
| `/chrome-devtools help` | Show command usage. |
| `/chrome-devtools quickstart` | Show the CDP endpoint, launch candidates, and setup hints. |
| `/chrome-devtools status` | Inspect tools, settings sources, and the last browser launch without probing or starting Chrome. |
| `/chrome-devtools settings` | Change browser settings; successful edits save immediately. |
| `/chrome-devtools tools` (aliases: `toggle`, `select`) | Stage tool availability, review the result, and apply it. |
| `/chrome-devtools enable` (alias: `on`) | Immediately make all currently gated capabilities available and save the selection. |
| `/chrome-devtools disable` (alias: `off`) | Immediately make all capabilities unavailable and save the empty selection. |

All routes support TUI and RPC and reject unknown or trailing arguments.
Only `enable` and `disable` also support print and JSON modes.
Disabling capabilities leaves the slash command and `chrome_devtools_load` available; see [Tool exposure](#tool-exposure).

Menu tool changes require **Apply tool changes**; cancellation discards the unconfirmed draft.
Failed apply leaves previous tool availability and settings intact and retains the draft for retry.
Browser settings instead save immediately, and closing the flow does not undo them.
See [Browser setup](./docs/browser-setup.md) for prerequisites and environment-override precedence, and [Experimental WebMCP](#experimental-webmcp) before enabling its gateways.

## ⚙️ Settings

The available capability names are saved to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools.json
```

Use **Browser settings** for connection preferences or **Choose available browser tools…** for tool availability.
For example, this partial document attaches to a user-started browser without launching another:

```json
{
  "browser": {
    "endpoint": "http://127.0.0.1:9222",
    "autoLaunch": false
  }
}
```

The same file owns `browser.endpoint`, `browser.autoLaunch`, `browser.executablePath`, `browser.extensionPaths`, and user-only `webmcp.enabled`.
Browser connection fields and `webmcp.enabled` are machine-owned user settings; trusted project files may replace only `browser.extensionPaths`.
Confirmed menu changes apply before the next browser connection and close only an extension-owned managed browser.
Manual JSON edits and unpacked-extension changes apply after `/reload` or session replacement.

When the file is missing or invalid, the extension preserves Pi's current Chrome DevTools availability policy instead of replacing it.
A valid saved catalog is restored on Pi startup and `/reload`, with capability definitions exposed natively deferred or eagerly according to model/provider support.
A missing file is created by the first confirmed browser or tool setting.
Within one Pi process, all browser and tool saves run in invocation order, reread the latest valid document, publish by temporary-file rename, and preserve unknown fields.
Malformed JSON or invalid recognized fields make menu mutation unavailable and block direct saves without replacement; a failed save restores the prior displayed and effective state.

Compatibility: older versions used `pi-chrome-devtools-settings.json`.
A legacy-only file remains readable with a warning and is never modified automatically; rename it to `pi-chrome-devtools.json`.
The first subsequent settings save writes the canonical file.
If both files exist, `pi-chrome-devtools.json` wins and the legacy file is ignored.
The legacy filename is deprecated and will be removed in a future major release.

## 🔒 Security and privacy

A CDP connection can inspect and change browser content, execute JavaScript, and access the selected browser profile's authenticated pages.
Connect only to trusted endpoints and profiles.

The extension never closes an external browser.
It closes only managed browser processes that it started and removes their temporary profiles on a best-effort basis.

Unpacked extensions run privileged browser code and are loaded only into an isolated managed browser after explicit configuration.
WebMCP page tools use the visible page's authentication and require confirmation before every call.
Screenshot output is restricted to the current working directory or OS temporary directory as described above.

## 🧠 Use cases

- Debug front-end applications with an AI coding agent.
- Verify DOM state after code changes.
- Capture screenshots for visual inspection.
- Drive local browser workflows without a separate MCP server.
- Combine with Pi coding tools for end-to-end web app fixes.

## 🗂️ Package layout

```text
packages/pi-chrome-devtools/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── chrome-devtools.ts             # Browser tools and command orchestration
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── docs/                              # Published reference documentation
├── reference/webmcp/                  # Repository-only compatibility prototype
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, Chrome DevTools Protocol, CDP, WebMCP, browser automation, web debugging, JavaScript evaluation, screenshot automation, AI coding agent tools.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
