# 🔥 pi-firecrawl — Scrape and Research the Web from Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-firecrawl)](https://www.npmjs.com/package/@narumitw/pi-firecrawl) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Add [Firecrawl](https://www.firecrawl.dev/) tools to Pi for web search, scraping, crawling, URL discovery, and content extraction.

## ✨ Features

- Scrapes a URL into markdown, HTML, links, screenshots, or structured JSON.
- Starts crawl jobs, checks their status, and retrieves completed crawl data.
- Discovers site URLs and searches the web with optional result-page scraping.
- Offers Codemode, Lazy loading, and Direct tools modes with availability controls through `/firecrawl`.
- Supports custom Firecrawl endpoints and shows status only while a tool is running.
- Bounds model-visible output while preserving oversized responses in private temporary files.
- Reads the API key from the environment and never logs, displays, or stores it.

## 📦 Install

Install persistently:

```bash
pi install npm:@narumitw/pi-firecrawl
```

Run once from npm:

```bash
pi -e npm:@narumitw/pi-firecrawl
```

Build and run a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-firecrawl run build
pi -e ./packages/pi-firecrawl
```

The package declares `dist/index.ts`, so build a local checkout before loading its package directory.

Pi extensions run with your user permissions.
Review third-party extension source before installing it.

## 🚀 Quick start

Set `FIRECRAWL_API_KEY`, enable Pi's codemode with `"defaultTools": ["+codemode"]` in Pi's `settings.json`, and start Pi with the extension.
Ask the agent to search or scrape a page through Firecrawl using codemode.
Run `/firecrawl settings` to choose another tool mode or change capability availability.

## ⚙️ Settings

Set a Firecrawl API key before running Pi:

```bash
export FIRECRAWL_API_KEY=fc-your-key
```

Optional API endpoint override:

```bash
export FIRECRAWL_API_URL=https://api.firecrawl.dev/v1
```

`FIRECRAWL_BASE_URL` is also accepted for compatibility.
The API key remains in the environment and is sent only as a bearer credential to the configured Firecrawl endpoint.

Open `/firecrawl settings` in TUI mode to edit Tool mode and the five capability switches.
Mode changes save immediately and apply at the next session start, including `/reload`; capability switches apply immediately using the running mode.
Closing the screen does not undo saved changes.
In RPC mode, the settings route shows the path and manual-edit instructions; print and JSON modes reject this route.

User settings are saved to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl.json
```

```json
{
  "toolMode": "codemode",
  "tools": ["firecrawl_scrape", "firecrawl_crawl", "firecrawl_crawl_status", "firecrawl_map", "firecrawl_search"],
  "updatedAt": 1
}
```

`toolMode` accepts `codemode` (default), `lazy`, or `direct`; see [Tool exposure](#tool-exposure).
Existing valid files without `toolMode` also use the new codemode default, preserving their tool selection.
To restore the previous behavior, choose `lazy` and run `/reload`.
A fresh runtime allows all five capabilities; a missing or invalid file preserves any existing unsaved availability policy across reloads.
Invalid settings produce a warning and block saves until repaired.
Loading a missing file creates nothing; the first explicit settings change creates it.
Manual file edits apply at the next session start, including `/reload`.
There are no project overrides; `tools` controls availability independently from `toolMode`.
Within one Pi process, saves run in invocation order, reread the latest valid document, and preserve unknown fields.
Malformed JSON or invalid recognized fields block saves without replacing the file.
A failed save restores the previous availability and loaded capabilities while preserving other extensions' active tools.
Mode and availability saves change only their owned fields, so an availability edit does not overwrite a pending saved mode.
The file stores mode, tool names, and a timestamp, never `FIRECRAWL_API_KEY`, request headers, or other secrets.

Older versions used `pi-firecrawl-settings.json`.
A legacy-only file remains readable with a warning and is never modified automatically; rename it to `pi-firecrawl.json`.
The next settings save writes the canonical file.
If both files exist, `pi-firecrawl.json` wins and the legacy file is ignored.
The legacy filename is deprecated and will be removed in a future major release.

## 🛠️ Tools

- `firecrawl_load` — find and load capabilities; available only in Lazy loading mode.
- `firecrawl_scrape` — scrape a single URL and return requested formats such as markdown, HTML, links, screenshots, or JSON.
- `firecrawl_crawl` — start a site crawl job and return the Firecrawl job id.
- `firecrawl_crawl_status` — check a crawl job status and retrieve completed crawl data.
- `firecrawl_map` — discover URLs for a site.
- `firecrawl_search` — search the web through Firecrawl and optionally scrape result pages.

### Tool exposure

| Mode | Tool exposure | Loader |
| --- | --- | --- |
| `codemode` (default) | Five allowed tools are callable through codemode and discoverable with `searchTools()` / `describeTool()`, without direct declarations. | None. |
| `lazy` | Only the loader starts active on native-deferred-compatible models; it appends capabilities as needed. | `firecrawl_load` stays active; loading all five yields six active Firecrawl tools. |
| `direct` | All five allowed tools are declared immediately. | None. |

Counts assume all capabilities are enabled.
Disabled capabilities are hidden and cannot be called or activated in any mode; `/firecrawl disable` makes all five unavailable.
Codemode mode does not explicitly activate capability tools; Pi's general tool controls can explicitly declare allowed codemode tools.

These modes require a Pi release with tool exposure support.
Codemode must be active in Pi for the default workflow.
Add `"defaultTools": ["+codemode"]` to Pi's `settings.json` and `/reload`.
Pi's `--tools` flag is an allowlist for extension tools too; a list that omits the Firecrawl capabilities prevents codemode from discovering or calling them.
The extension warns when codemode is inactive and does not silently switch modes.
Choose `lazy` or `direct` if you do not want to enable codemode.

In Lazy loading mode, with native deferred-tool support, only `firecrawl_load` starts active.
The loader accepts a task-oriented `query`, filters to capabilities allowed by settings, and adds up to three matching tools by default without removing any active Pi tool.
Set `limit` from 1 to 5 to change the maximum number loaded by one call.
A general website-crawl query can load both `firecrawl_crawl` and `firecrawl_crawl_status`, while a status-specific query loads the status capability.
Loaded capability tools remain active for the current session until you make them unavailable through `/firecrawl`.
On reload, resume, or fork, capabilities recorded by `firecrawl_load` on the active branch are restored when the current catalog still allows them.

Native lazy loading requires `compat.supportsMidConvoSystemMessages: true` in Pi's registered model metadata.
Anthropic Messages also requires `supportsMidConvoToolChanges`; OpenAI Chat Completions requires `supportsMidConvoToolAdditions`.
OpenAI Responses, Codex Responses, and Azure Responses require `supportsAdditionalTools` or `supportsToolSearch`.
The extension uses these explicit capabilities, not provider names or model-ID guesses.

When the selected model/provider lacks native deferred support, the extension activates every capability allowed by settings before the next model request instead of using Pi's cache-invalidating lazy-loading fallback.
After a Lazy loading session enters eager exposure, it stays eager across later model switches to avoid removing tool definitions within that session.
Model switches do not change Codemode or Direct tools mode.
The capability tools omit active-only prompt metadata so native deferred loading does not rebuild the system-prompt prefix.

The saved `tools` array controls which capabilities the extension may expose.
An empty array makes every Firecrawl API capability unavailable; only Lazy loading mode retains an active loader.

`firecrawl_load` performs no network request and does not create response artifacts.
Every API capability fails with a clear configuration error when `FIRECRAWL_API_KEY` is missing; configure the key instead of retrying repeatedly.
Settings changes, reloads, and a Lazy loading fallback to eager exposure are intentional model-visible tool transitions; ordinary turns do not reconfigure the tools or rewrite conversation history.

Tool output is limited to 50 KB or 2,000 lines, whichever is reached first.
When a response is truncated, the result reports the original and displayed sizes and the path to a complete temporary JSON file.
Tool-result metadata contains only size and artifact information rather than a duplicate of the raw Firecrawl response.
Oversized Firecrawl error bodies are bounded in the same way.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/firecrawl` | Manage available Firecrawl tools and inspect configuration. |
| `/firecrawl help` | Show command usage. |
| `/firecrawl config` (alias: `quickstart`) | Show API-key presence and API URL without revealing the key. |
| `/firecrawl status` | Show running/saved mode, effective exposure, callable and declared counts, loader state, saved catalog, and configuration status. |
| `/firecrawl settings` | Edit tool mode and capability availability in TUI, or show manual-edit instructions in RPC. |
| `/firecrawl tools` (aliases: `toggle`, `select`) | Choose available capabilities; each toggle saves immediately. |
| `/firecrawl enable` (alias: `on`) | Make all five API capabilities available and save the selection. |
| `/firecrawl disable` (alias: `off`) | Make all API capabilities unavailable and save the empty selection. |

All routes support TUI and RPC and reject unknown or trailing arguments.
Only `enable` and `disable` also support print and JSON modes.
Disabling capabilities leaves the slash command available and retains `firecrawl_load` only in Lazy loading mode; see [Tool exposure](#tool-exposure).
Done, Escape, or cancellation closes the tool selector **without undoing saved changes**.

## 🔒 Security and privacy

Firecrawl API tools send requested URLs, options, and related data to the configured API endpoint.
Review the endpoint's privacy policy before sending private or authenticated URLs.

`FIRECRAWL_API_KEY` is sent as a bearer credential but is never logged, displayed, or stored by the extension.
Truncated response artifacts use private temporary files, remain available only for the current session, and are removed on shutdown or reload.

## 🧪 Examples

Call `firecrawl_scrape` to scrape a page as Markdown:

```json
{
  "url": "https://example.com",
  "formats": ["markdown"]
}
```

Call `firecrawl_map` to discover URLs on a small site:

```json
{
  "url": "https://example.com",
  "limit": 20
}
```

Call `firecrawl_crawl` to start a crawl with Markdown extraction:

```json
{
  "url": "https://example.com",
  "limit": 10,
  "scrapeOptions": {
    "formats": ["markdown"]
  }
}
```

## 🧠 Use cases

- Research documentation from inside Pi.
- Crawl websites for migration or audit tasks.
- Extract clean markdown for AI context.
- Discover URLs before scraping a site.
- Combine web search with coding-agent implementation work.

## 🗂️ Package layout

```text
packages/pi-firecrawl/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── firecrawl.ts                   # Web tools and command orchestration
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, Firecrawl, web scraping, web crawling, URL discovery, web search, markdown extraction, AI research agent, TypeScript Pi tools.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
