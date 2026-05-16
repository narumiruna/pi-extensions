# 🔥 pi-firecrawl — Firecrawl Web Scraping Tools for Pi Agents

[![npm](https://img.shields.io/npm/v/@narumitw/pi-firecrawl)](https://www.npmjs.com/package/@narumitw/pi-firecrawl) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-firecrawl` is a native [Pi coding agent](https://pi.dev) extension that exposes [Firecrawl](https://www.firecrawl.dev/) scraping, crawling, URL discovery, and search APIs as Pi tools.

Use it to give your AI coding agent reliable web research capabilities for documentation lookup, website audits, competitive research, content extraction, and retrieval-friendly markdown scraping.

## ✨ Features

- Scrape a single URL into markdown, HTML, raw HTML, links, screenshots, or JSON.
- Start Firecrawl crawl jobs from Pi.
- Check crawl job status and retrieve completed crawl data.
- Discover URLs with Firecrawl map.
- Search the web and optionally scrape search result pages.
- Supports Firecrawl API endpoint overrides.
- Shows statusline activity only while Firecrawl tools are running.
- Never logs or displays your Firecrawl API key.

## 📦 Install

```bash
pi install npm:@narumitw/pi-firecrawl
```

Try without installing permanently:

```bash
FIRECRAWL_API_KEY=fc-... pi -e npm:@narumitw/pi-firecrawl
```

Try this package locally from the repository root:

```bash
FIRECRAWL_API_KEY=fc-... pi -e ./extensions/pi-firecrawl
```

## ⚙️ Configuration

Set a Firecrawl API key before running Pi:

```bash
export FIRECRAWL_API_KEY=fc-your-key
```

Optional API endpoint override:

```bash
export FIRECRAWL_API_URL=https://api.firecrawl.dev/v1
```

`FIRECRAWL_BASE_URL` is also accepted for compatibility. The extension never logs or displays the API key.

## 🛠️ Pi tools

- `firecrawl_scrape` — scrape a single URL and return requested formats such as markdown, HTML, links, screenshots, or JSON.
- `firecrawl_crawl` — start a site crawl job and return the Firecrawl job id.
- `firecrawl_crawl_status` — check a crawl job status and retrieve completed crawl data.
- `firecrawl_map` — discover URLs for a site.
- `firecrawl_search` — search the web through Firecrawl and optionally scrape result pages.

All tools fail with a clear configuration error when `FIRECRAWL_API_KEY` is missing.

## 💬 Command

```text
/firecrawl
```

Shows whether the extension sees an API key and which Firecrawl API URL it will call.

## 🚀 Examples

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
extensions/pi-firecrawl/
├── src/
│   └── firecrawl.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

## 🔎 Keywords

Pi extension, Pi coding agent, Firecrawl, web scraping, web crawling, URL discovery, web search, markdown extraction, AI research agent, TypeScript Pi tools.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
