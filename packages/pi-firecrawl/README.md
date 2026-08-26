# 🔥 pi-firecrawl — Scrape and Research the Web from Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-firecrawl)](https://www.npmjs.com/package/@narumitw/pi-firecrawl) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give Pi on-demand [Firecrawl](https://www.firecrawl.dev/) tools for web search, scraping, crawling, URL discovery, and retrieval-friendly content extraction.

## ✨ Features

- Scrapes a URL into markdown, HTML, links, screenshots, or structured JSON.
- Starts crawl jobs, checks their status, and retrieves completed crawl data.
- Discovers site URLs and searches the web with optional result-page scraping.
- Loads only the Firecrawl capabilities needed for the task and manages availability through `/firecrawl`.
- Supports custom Firecrawl endpoints and shows activity only while a tool is running.
- Bounds model-visible output while preserving oversized responses in private temporary files.
- Reads the API key from the environment and never logs, displays, or stores it.

## 📦 Install

```bash
pi install npm:@narumitw/pi-firecrawl
```

Try without installing permanently:

```bash
FIRECRAWL_API_KEY=fc-... pi -e npm:@narumitw/pi-firecrawl
```

Build and try this package locally from the repository root:

```bash
npm --workspace @narumitw/pi-firecrawl run build
FIRECRAWL_API_KEY=fc-... pi -e ./packages/pi-firecrawl
```

The package declares `dist/index.ts`, so an unbuilt local checkout must run the build before Pi loads the package directory.

## 🚀 Quick start

Set `FIRECRAWL_API_KEY`, start Pi with the extension, and ask the agent to load the Firecrawl capability needed for the task.
Use `/firecrawl` to review configuration and control which capability tools may be loaded.

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
The extension never logs or displays the API key.

## 🛠️ Tools

- `firecrawl_load` — find and load Firecrawl capabilities relevant to a web research task.
- `firecrawl_scrape` — scrape a single URL and return requested formats such as markdown, HTML, links, screenshots, or JSON.
- `firecrawl_crawl` — start a site crawl job and return the Firecrawl job id.
- `firecrawl_crawl_status` — check a crawl job status and retrieve completed crawl data.
- `firecrawl_map` — discover URLs for a site.
- `firecrawl_search` — search the web through Firecrawl and optionally scrape result pages.

### Tool exposure

All six tools are registered.

On a model/provider with native deferred-tool support, only `firecrawl_load` starts active for this extension.

The loader accepts a task-oriented `query`, filters to capabilities allowed by settings, and adds up to three matching tools by default without removing any active Pi tool.

Set `limit` from 1 to 5 to change the maximum number loaded by one call.

A general website-crawl query can load both `firecrawl_crawl` and `firecrawl_crawl_status`, while a status-specific query loads the status capability.

Loaded capability tools remain active for the session unless the user makes them unavailable through `/firecrawl`.

On reload, resume, or fork, capabilities recorded by `firecrawl_load` on the active branch are restored when the current catalog still allows them.

Pi uses native deferred tool references on compatible Anthropic models, native additional-tools or tool-search loading on compatible OpenAI and Codex Responses models, and native Kimi loading on compatible OpenAI Chat Completions models.

Kimi-compatible models declare `compat.deferredToolsMode: "kimi"` in Pi's model metadata.

`azure-openai-responses` remains eager because Pi's Azure adapter does not implement native deferred tool-search serialization.

When the selected model/provider lacks native deferred support, the extension activates every capability allowed by settings before the next model request instead of using Pi's cache-invalidating lazy-loading fallback.

After a session enters eager exposure, it stays eager across later model switches to avoid removing tool definitions within that session.

The capability tools omit active-only prompt metadata so native deferred loading does not rebuild the system-prompt prefix.

The saved `tools` array controls which capabilities the extension may expose.

An empty array leaves the loader active but makes every Firecrawl API capability unavailable.

`firecrawl_load` performs no network request and does not create response artifacts.

Every API capability fails with a clear configuration error when `FIRECRAWL_API_KEY` is missing, and the always-active loader guidance tells the agent not to retry repeatedly.

Tool output is limited to 50 KB or 2,000 lines, whichever is reached first.
When a response is truncated, the result reports the original and displayed sizes and the path to a complete temporary JSON file.
These files use private permissions, remain available for the current session, and are removed during session shutdown or reload.
Tool-result metadata contains only size and artifact information rather than a duplicate of the raw Firecrawl response.
Oversized Firecrawl error bodies are bounded in the same way.

## 💬 Commands

```text
/firecrawl
```

Opens a menu with configuration quick start, command usage, tool-catalog status, controls for making all Firecrawl capabilities available or unavailable, and a selector for choosing individual tools.

Direct subcommands are also available:

```text
/firecrawl help
/firecrawl config
/firecrawl quickstart
/firecrawl status
/firecrawl tools
/firecrawl toggle
/firecrawl enable
/firecrawl disable
```

- `help` shows command usage.
- `config` shows API-key presence and API URL without displaying the API key value.
- `quickstart` is an alias for `config`.
- `status` shows available and loaded capability counts, loader state, the persisted catalog, settings file path, API-key presence, API URL, and active non-Firecrawl tool count.
- `tools` opens a width-safe immediate-save selector for choosing available capabilities.
- `toggle` is an alias for `tools`.
- `enable` makes all five API capabilities available and follows the current native-deferred or eager exposure mode.
- `disable` makes all five API capabilities unavailable and unloads affected active definitions.
  The slash command and `firecrawl_load` remain available.

The menu, `tools`, `help`, `config`, `quickstart`, and `status` routes require TUI or RPC mode so their results are observable.

Print and JSON modes reject those routes and unknown commands explicitly instead of entering unavailable UI or silently notifying a no-op channel.

The deterministic `enable` and `disable` routes remain available in every mode.

Tool-selector toggles save immediately in user action order.

Done, Escape, or cancellation closes the selector without undoing changes that were already saved.

The available capability names are saved to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-firecrawl.json
```

When the file is missing or invalid, the extension preserves Pi's current Firecrawl availability policy instead of replacing it.
An unsaved catalog remains stable across runtime reloads.
A valid saved catalog is restored on Pi startup and `/reload`, with capability definitions exposed natively deferred or eagerly according to model/provider support.
A missing file is created by the first successful availability change.
Within one Pi process, catalog saves run in invocation order, reread the latest valid document, and preserve unknown fields.
Malformed JSON or invalid recognized fields block the save without replacement; a failed save restores both the prior availability and loaded capability state while preserving other extensions' active tools.
The settings file stores only tool names and a timestamp; it never stores `FIRECRAWL_API_KEY`, request headers, or other secrets.

Compatibility: older versions used `pi-firecrawl-settings.json`.
A legacy-only file remains readable with a warning and is never modified automatically; rename it to `pi-firecrawl.json`.
The first subsequent settings save writes the canonical file.
If both files exist, `pi-firecrawl.json` wins and the legacy file is ignored.
The legacy filename is deprecated and will be removed in a future major release.

## 🧪 Examples

Scrape a page as markdown:

```json
{
  "url": "https://example.com",
  "formats": ["markdown"]
}
```

Map a small site:

```json
{
  "url": "https://example.com",
  "limit": 20
}
```

Start a crawl with markdown extraction:

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

```txt
packages/pi-firecrawl/
├── dist/                  # Generated TypeScript runtime loaded by Jiti
├── scripts/
│   └── build-runtime.mjs  # Deterministic runtime builder and boundary validator
├── src/
│   ├── index.ts       # Pi package entrypoint
│   ├── firecrawl.ts   # Extension registration and command orchestration
│   ├── lazy-tools.ts  # Deferred capability catalog and loader tool
│   └── *.ts           # Package-local client, settings, selector, and tool modules
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

`index.ts` is the Pi entrypoint and forwards to `firecrawl.ts`; the other source modules are internal.

The generated runtime is built from the authoritative `src/index.ts` graph and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, Firecrawl, web scraping, web crawling, URL discovery, web search, markdown extraction, AI research agent, TypeScript Pi tools.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
