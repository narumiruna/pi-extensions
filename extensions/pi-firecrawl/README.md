# pi-firecrawl

A public [pi](https://pi.dev) extension package that exposes [Firecrawl](https://www.firecrawl.dev/) web scraping, crawling, URL discovery, and search APIs as native pi tools.

## Install

```bash
pi install npm:@narumitw/pi-firecrawl
```

Try without installing:

```bash
FIRECRAWL_API_KEY=fc-... pi -e npm:@narumitw/pi-firecrawl
```

Try this package locally from the repository root:

```bash
FIRECRAWL_API_KEY=fc-... pi -e ./extensions/pi-firecrawl
```

## Configuration

Set a Firecrawl API key before running pi:

```bash
export FIRECRAWL_API_KEY=fc-your-key
```

Optional API endpoint override:

```bash
export FIRECRAWL_API_URL=https://api.firecrawl.dev/v1
```

`FIRECRAWL_BASE_URL` is also accepted for compatibility. The extension never logs or displays the API key.

## Tools

- `firecrawl_scrape` — scrape a single URL and return requested formats such as markdown, HTML, links, or JSON.
- `firecrawl_crawl` — start a site crawl job and return the Firecrawl job id.
- `firecrawl_crawl_status` — check a crawl job status and retrieve completed crawl data.
- `firecrawl_map` — discover URLs for a site.
- `firecrawl_search` — search the web through Firecrawl and optionally scrape result pages.

All tools fail with a clear configuration error when `FIRECRAWL_API_KEY` is missing.

## Command

```text
/firecrawl
```

Shows whether the extension sees an API key and which Firecrawl API URL it will call.

## Examples

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

## Package layout

```txt
extensions/pi-firecrawl/
├── src/
│   └── firecrawl.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```
