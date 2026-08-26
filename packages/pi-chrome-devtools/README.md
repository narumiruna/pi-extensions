# 🌐 pi-chrome-devtools — Inspect and Control Chrome from Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-chrome-devtools)](https://www.npmjs.com/package/@narumitw/pi-chrome-devtools) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Let Pi inspect browser tabs, navigate pages, evaluate JavaScript, and capture screenshots through native Chrome DevTools Protocol tools.

Use it for web debugging, UI validation, and browser-assisted investigation without running an MCP server.

The design is inspired by [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp), not guaranteed to be compatible with it.

## ✨ Features

- Lists and selects inspectable pages, navigates URLs, evaluates JavaScript, and captures PNG screenshots.
- Reuses an existing CDP endpoint or lazily launches an isolated Chromium-family browser.
- Recovers from stale page selections and reports actionable browser startup or endpoint errors.
- Loads explicitly approved unpacked extensions only in an extension-owned Chrome for Testing or Chromium process.
- Uses native deferred browser tools when supported and eager exposure otherwise, with availability, setup, status, and help through `/chrome-devtools`.
- Shows compact expandable results and activity only while browser tools are running.
- Persists reviewed tool availability while keeping browser connection settings machine-owned.

## 📦 Install

```bash
pi install npm:@narumitw/pi-chrome-devtools
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-chrome-devtools
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-chrome-devtools run build
pi -e ./packages/pi-chrome-devtools
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

## 🚀 Quick start

Start Pi and ask the agent to load the Chrome DevTools capability needed for the task.
The extension first tries `http://127.0.0.1:9222` and otherwise launches an isolated local Chromium-family browser by default.
Run `/chrome-devtools` to review browser status, settings, help, and available tools.

## 🌐 Browser setup

Without unpacked extensions, the extension first tries `browser.endpoint`, defaulting to `http://127.0.0.1:9222`.
If that endpoint is unavailable and `browser.autoLaunch` is `true`, it lazily launches an extension-owned browser with an isolated temporary profile and retries the CDP request.
Existing endpoints are reused and never terminated by the extension.

Configure the canonical user file at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools.json`:

```json
{
  "browser": {
    "endpoint": "http://127.0.0.1:9222",
    "autoLaunch": true,
    "executablePath": "/absolute/path/to/chromium"
  }
}
```

`browser.endpoint` must be an HTTP origin with an explicit port and no credentials, path, query, or fragment.
Omitting it keeps attach-first behavior on `127.0.0.1:9222` and lets a managed launch use Chrome's dynamic DevTools port mode (`--remote-debugging-port=0`).
Explicitly saving an endpoint pins managed launches to that port.
`browser.autoLaunch` defaults to `true`.
`browser.executablePath` is optional and must be an absolute path; when absent, normal browser discovery applies.

The configured endpoint must expose the standard CDP HTTP discovery routes such as `/json/version` and `/json/list`.
Chrome's newer built-in permission flow can listen on port `9222` while returning `404` from those routes; setting the same HTTP origin does not by itself make that flow compatible.

### Unpacked extensions

> [!WARNING]
> An unpacked extension executes privileged browser code.
> Load only code you trust.
> Project settings are honored only when Pi reports the project as trusted.

Add trusted unpacked-extension paths to the same canonical user file:

```json
{
  "browser": {
    "executablePath": "/absolute/path/to/chrome-for-testing",
    "extensionPaths": [
      "/absolute/path/to/unpacked-extension-one",
      "/absolute/path/to/unpacked-extension-two"
    ]
  }
}
```

Every user-file path must be absolute.
Each extension path must resolve to a directory containing a valid `manifest.json` and cannot contain a comma because Chrome uses commas to separate multiple startup paths.
For extension-configured sessions, `executablePath` must identify Chrome for Testing or Chromium.
Branded Google Chrome is rejected because tested releases can silently ignore unpacked-extension startup flags.

A trusted project can replace the user extension list in `<workspace>/.pi/pi-chrome-devtools.json`.
Relative paths resolve from the workspace (`ctx.cwd`):

```json
{
  "browser": {
    "extensionPaths": ["./extension"]
  }
}
```

Project `extensionPaths` replace, rather than append to, the user array.
A project file cannot override `browser.endpoint`, `browser.autoLaunch`, or `browser.executablePath`; browser connection settings remain machine-owned user configuration.
Effective precedence is defaults, user settings, trusted project extension paths, then deprecated environment overrides.
No new environment variable is required.

When `extensionPaths` is non-empty, the extension skips attach-first behavior and starts an isolated, extension-owned managed browser with `--disable-extensions-except` and `--load-extension`.
It fails before spawning when the endpoint is remote, auto-launch is disabled, an explicit port is occupied, the executable is missing, or the browser product is unsupported.
It never adds extensions to, modifies, restarts, or closes an external browser.

Settings are loaded on session start.
After editing JSON, use `/reload` or replace the session; the old managed browser is closed before the new configuration is applied.
Missing files preserve the existing no-extension behavior.
Invalid JSON, invalid browser values, and missing manifests are left unchanged and ignored with an actionable warning.

### Deprecated environment overrides and manual endpoints

The existing `PI_CHROME_DEVTOOLS_HOST`, `PI_CHROME_DEVTOOLS_PORT`, `PI_CHROME_DEVTOOLS_AUTO_LAUNCH`, and `PI_CHROME_DEVTOOLS_BROWSER` variables remain temporary compatibility overrides.
They still take precedence over JSON, but every session that sees one emits a deprecation warning.
Move their values to `browser.endpoint`, `browser.autoLaunch`, and `browser.executablePath`; the variables will be removed in a future version.

Without unpacked extensions, browser discovery still checks platform-specific Chrome, Chromium, Brave, and Microsoft Edge candidates.
Manual launch remains available when no unpacked extensions are configured:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/pi-chrome-devtools
```

On session shutdown, the extension terminates only browser processes it started and best-effort removes their temporary profiles.
It never closes user-started browsers or remote endpoints.

## 🛠️ Tools

- `chrome_devtools_load` — find and load browser capabilities relevant to a task.
- `chrome_devtools_list_pages` — list inspectable Chrome tabs/pages.
- `chrome_devtools_select_page` — select the active page for later tool calls.
- `chrome_devtools_navigate` — navigate a page to a URL; if no page exists, create one first.
- `chrome_devtools_evaluate` — evaluate JavaScript in the selected page.
- `chrome_devtools_screenshot` — capture a PNG screenshot and save it as a PNG file.

### Tool exposure

All six tools are registered.

On a model/provider with native deferred-tool support, only `chrome_devtools_load` starts active for this extension.

The loader accepts a task-oriented `query`, matches it against the five capability tools, and adds matching available tools without removing any active Pi tool.

Loaded capability tools remain active for the rest of the session unless the user makes them unavailable through `/chrome-devtools`.

Pi uses native deferred tool references on compatible Anthropic models, native additional-tools or tool-search loading on compatible OpenAI and Codex Responses models, and native Kimi loading on compatible OpenAI Chat Completions models.

Kimi-compatible models declare `compat.deferredToolsMode: "kimi"` in Pi's model metadata.

`azure-openai-responses` remains eager because Pi's Azure adapter does not implement native deferred tool-search serialization.

When the selected model/provider lacks native deferred support, the extension activates every capability allowed by settings before the next model request instead of using Pi's cache-invalidating lazy-loading fallback.

After a session enters eager exposure, it stays eager across later model switches to avoid removing tool definitions within that session.

The capability tools omit active-only prompt snippets so native deferred loading does not rebuild the system-prompt prefix.

The saved `tools` array controls which capabilities the extension may expose.

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

```text
/chrome-devtools
```

Opens a menu that shows the tool catalog size, whether that catalog is saved, the configured endpoint, the observed managed-browser state, and any settings or launch warning before you choose an action.
The five actions stay on one level:

- **Choose available browser tools…** — stage any combination of the five capabilities, then review the exact available/unavailable result before selecting **Apply tool changes**.
- **Make all browser tools available…** or **Make all browser tools unavailable…** — preview the context-appropriate bulk change before applying it.
- **Browser status** — inspect runtime, endpoint, launch mode, and the last launch attempt without probing the endpoint or starting Chrome.
- **Browser settings** — immediately save the endpoint, auto-launch policy, or browser executable.
  Inspect unpacked-extension paths and effective sources.
A deprecated environment override remains effective until removed even when its underlying JSON value changes.
- **Help** — view command usage and return to the menu.

In the tool screen, **Select all** and **Select none** are unambiguous shortcuts; individual rows use friendly task labels while retaining their raw `chrome_devtools_*` identity in the description.
Toggles remain a command-local draft.
**Review changes** previews the exact effect, **Apply tool changes** saves it, and Cancel, Escape, Ctrl+C, disposal, or session replacement discards an unconfirmed draft without changing runtime tools or settings.
A failed apply restores the previous availability and loaded-tool state, preserves the settings file, retains the draft for retry, and reports how to recover.

Direct subcommands are also available:

```text
/chrome-devtools help
/chrome-devtools quickstart
/chrome-devtools status
/chrome-devtools settings
/chrome-devtools tools
/chrome-devtools toggle
/chrome-devtools enable
/chrome-devtools disable
```

Compatibility aliases remain available: `toggle` and `select` mean `tools`, `on` means `enable`, and `off` means `disable`.

- `help` shows command usage.
- `quickstart` shows the configured CDP endpoint, endpoint source, auto-launch mode, browser candidates, last launch attempt, and launch hints.
- `status` shows available and loaded capability counts, loader state, the persisted catalog, settings file path, endpoint source, launch mode, last launch attempt, and active non-Chrome tool count.
- `settings` opens the same immediate-save browser settings flow used by the menu.
- `tools` opens the same staged, width-safe availability and review flow used by the menu.
- `toggle` and `select` are compatibility aliases for `tools`.
- `enable` makes all five capability tools available and follows the current native-deferred or eager exposure mode; `on` is a compatibility alias.
- `disable` makes all five capability tools unavailable and saves the empty catalog; `off` is a compatibility alias.
  The slash command and `chrome_devtools_load` remain available.

The menu, `settings`, `tools`, `help`, `quickstart`, and `status` require TUI or RPC mode so their result is observable.
TUI uses keyboard navigation and injected Pi keybindings; RPC receives equivalent standard dialogs.
In print and JSON modes, interactive and informational routes reject explicitly instead of silently opening unavailable UI.
The immediate `enable`/`disable` routes remain available for deterministic non-interactive use.

## ⚙️ Settings

The available capability names are saved to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools.json
```

The same file owns `browser.endpoint`, `browser.autoLaunch`, `browser.executablePath`, and `browser.extensionPaths`.
Browser connection fields are machine-owned user settings; trusted project files may replace only `browser.extensionPaths`.
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

## 🧠 Use cases

- Debug front-end applications with an AI coding agent.
- Verify DOM state after code changes.
- Capture screenshots for visual inspection.
- Drive local browser workflows without a separate MCP server.
- Combine with Pi coding tools for end-to-end web app fixes.

## 🗂️ Package layout

```txt
packages/pi-chrome-devtools/
├── dist/                  # Generated TypeScript runtime loaded by Jiti
├── scripts/
│   └── build-runtime.mjs  # Deterministic runtime builder and boundary validator
├── src/
│   ├── index.ts            # Pi package entrypoint
│   ├── chrome-devtools.ts  # Extension registration and command orchestration
│   ├── lazy-tools.ts       # Deferred capability catalog and loader tool
│   └── *.ts                # Package-local browser, CDP, tool, and storage modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `chrome-devtools.ts`; the other source modules are internal.
The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/index.ts"]
  }
}
```

The generated runtime is built from the authoritative `src/index.ts` graph and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, Chrome DevTools Protocol, CDP, browser automation, web debugging, JavaScript evaluation, screenshot automation, AI coding agent tools.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
