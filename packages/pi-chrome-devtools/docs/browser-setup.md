# Pi Chrome DevTools browser setup reference

[Back to README](../README.md)

- [Browser connection](#-browser-setup)
- [Unpacked extensions](#unpacked-extensions)
- [Experimental WebMCP](#experimental-webmcp)
- [Deprecated overrides and manual endpoints](#deprecated-environment-overrides-and-manual-endpoints)

## 🌐 Browser setup

Without unpacked extensions, the extension first tries `browser.endpoint`, defaulting to `http://127.0.0.1:9222`.
If that endpoint is unavailable and `browser.autoLaunch` is `true`, it lazily launches an extension-owned browser with an isolated temporary profile and retries the CDP request.
The extension reuses existing endpoints and never terminates them.

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
Saving an explicit endpoint pins managed launches to that port.
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

### Experimental WebMCP

> [!WARNING]
> WebMCP support is experimental, disabled by default, and subject to Chrome protocol changes.
> Page-provided tools operate the visible page with its current authentication, entitlement, and UI state.
> Every call requires observable confirmation, including tools that claim to be read-only.

Enable WebMCP only in the canonical user settings file:

```json
{
  "webmcp": {
    "enabled": true
  }
}
```

A project `pi-chrome-devtools.json` cannot enable WebMCP or weaken confirmation policy.
The settings menu labels WebMCP as experimental, persists the user-owned boolean atomically, and aborts active WebMCP work before disablement or browser replacement.
The two gateway tools remain unavailable while WebMCP is disabled, even if an older `tools` array contains their names.
After enabling the gate, choose whether each gateway is available through `/chrome-devtools tools` or the main menu.

WebMCP requires a Chrome build whose `/json/protocol` exposes the experimental `WebMCP` domain.
Origin-trial sites must meet Chrome's Origin Trial, origin isolation, Permissions Policy, authentication, and browser feature requirements.
For local pages outside an Origin Trial, open `chrome://flags/#enable-webmcp-testing`, enable **WebMCP for testing**, and relaunch a compatible Chrome build.
The extension does not automatically add testing flags to a managed browser.

`chrome_devtools_webmcp_list_tools` opens an operation-scoped page CDP session, lists frame-aware page tools, and returns bounded metadata with a deterministic schema-and-annotation digest.
`chrome_devtools_webmcp_call_tool` re-discovers the exact page, document loader, frame, origin, tool, schema, annotations, and session generation before invocation and again after confirmation.
The call gateway rejects print and JSON modes because they cannot provide observable confirmation.
TUI and RPC modes use Pi's standard confirmation dialog.
Cancellation is forwarded to Chrome through `WebMCP.cancelInvocation` after Chrome returns an invocation ID.

Page URLs, origins, names, descriptions, schemas, errors, and outputs are untrusted.
Displayed text strips terminal controls and bidirectional overrides, accepted JSON has explicit byte, depth, and collection limits, and model-visible output is capped at 50 KB or 2,000 lines.
CDP text messages are capped at 8 MB before JSON parsing.
Page-controlled `pattern` and `patternProperties` schemas and schemas exceeding 128 combinator or dependent-schema branches are rejected because they cannot be evaluated safely on Pi's main thread.
Annotations are descriptive hints only and never authorize a call.
WebMCP is not backend MCP, generic browser automation, or a way to bypass browser policy.

If listing reports that the WebMCP domain is unavailable, update Chrome and verify `/json/protocol` contains `WebMCP`.
If a page lists no tools, verify that the site participates in the Origin Trial or that **WebMCP for testing** is enabled for local development.
If a call reports a stale identity, list tools again after navigation, reload, frame changes, tool registration changes, settings changes, or browser replacement.
Attached everyday browser profiles receive a stronger confirmation warning than isolated managed profiles.

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
