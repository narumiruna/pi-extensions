import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool, formatSize } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cleanObject, firecrawlRequest, jsonResult, withStatus } from "./client.js";
import { FIRECRAWL_TOOL_NAMES } from "./tool-names.js";

const StringArray = Type.Array(Type.String());
const OUTPUT_LIMIT_DESCRIPTION = `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; complete truncated responses are saved temporarily and their path is returned.`;

export const scrapeTool = defineTool({
  name: FIRECRAWL_TOOL_NAMES[0],
  label: "Firecrawl: Scrape",
  description: `Scrape a single URL through Firecrawl and return requested formats. ${OUTPUT_LIMIT_DESCRIPTION}`,
  parameters: Type.Object({
    url: Type.String({ description: "URL to scrape." }),
    formats: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Requested Firecrawl output format, such as markdown, html, rawHtml, links, screenshot, or json.",
        }),
        { description: "Firecrawl output formats. Defaults to Firecrawl's API default." },
      ),
    ),
    onlyMainContent: Type.Optional(Type.Boolean({ description: "Return only the main page content when supported." })),
    includeTags: Type.Optional(StringArray),
    excludeTags: Type.Optional(StringArray),
    waitFor: Type.Optional(Type.Number({ description: "Milliseconds to wait before scraping." })),
    timeout: Type.Optional(Type.Number({ description: "Firecrawl request timeout in milliseconds." })),
    mobile: Type.Optional(Type.Boolean({ description: "Use a mobile user agent when supported." })),
    skipTlsVerification: Type.Optional(
      Type.Boolean({ description: "Skip TLS certificate verification when supported." }),
    ),
    removeBase64Images: Type.Optional(
      Type.Boolean({ description: "Remove base64 image data from the response when supported." }),
    ),
    blockAds: Type.Optional(Type.Boolean({ description: "Block ads while scraping when supported." })),
    headers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Additional HTTP headers Firecrawl should use while fetching the target URL.",
      }),
    ),
    jsonOptions: Type.Optional(Type.Any({ description: "Firecrawl jsonOptions for structured extraction." })),
    actions: Type.Optional(
      Type.Array(Type.Any(), {
        description: "Firecrawl browser actions to perform before scraping.",
      }),
    ),
    location: Type.Optional(Type.Any({ description: "Firecrawl location options." })),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "scrape", async () => {
      const payload = await firecrawlRequest("POST", "/scrape", cleanObject(params), signal, ctx.sessionManager);
      return await jsonResult(payload, ctx.sessionManager);
    });
  },
});

export const crawlTool = defineTool({
  name: FIRECRAWL_TOOL_NAMES[1],
  label: "Firecrawl: Crawl",
  description: `Start a Firecrawl crawl job for a website. ${OUTPUT_LIMIT_DESCRIPTION}`,
  parameters: Type.Object({
    url: Type.String({ description: "Starting URL for the crawl." }),
    limit: Type.Optional(Type.Number({ description: "Maximum number of pages to crawl." })),
    maxDepth: Type.Optional(Type.Number({ description: "Maximum crawl depth when supported." })),
    includePaths: Type.Optional(Type.Array(Type.String(), { description: "URL path patterns to include." })),
    excludePaths: Type.Optional(Type.Array(Type.String(), { description: "URL path patterns to exclude." })),
    allowBackwardLinks: Type.Optional(Type.Boolean({ description: "Allow crawling backward links when supported." })),
    allowExternalLinks: Type.Optional(Type.Boolean({ description: "Allow crawling external links when supported." })),
    ignoreSitemap: Type.Optional(Type.Boolean({ description: "Ignore sitemap discovery." })),
    deduplicateSimilarURLs: Type.Optional(Type.Boolean({ description: "Deduplicate similar URLs when supported." })),
    scrapeOptions: Type.Optional(Type.Any({ description: "Firecrawl scrapeOptions applied to crawled pages." })),
    webhook: Type.Optional(Type.Any({ description: "Firecrawl webhook configuration." })),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "crawl", async () => {
      const payload = await firecrawlRequest("POST", "/crawl", cleanObject(params), signal, ctx.sessionManager);
      return await jsonResult(payload, ctx.sessionManager);
    });
  },
});

export const crawlStatusTool = defineTool({
  name: FIRECRAWL_TOOL_NAMES[2],
  label: "Firecrawl: Crawl Status",
  description: `Check a Firecrawl crawl job status and retrieve completed crawl data. ${OUTPUT_LIMIT_DESCRIPTION}`,
  parameters: Type.Object({
    id: Type.String({ description: "Crawl job id returned by firecrawl_crawl." }),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "crawl status", async () => {
      const payload = await firecrawlRequest(
        "GET",
        `/crawl/${encodeURIComponent(params.id)}`,
        undefined,
        signal,
        ctx.sessionManager,
      );
      return await jsonResult(payload, ctx.sessionManager);
    });
  },
});

export const mapTool = defineTool({
  name: FIRECRAWL_TOOL_NAMES[3],
  label: "Firecrawl: Map",
  description: `Discover URLs for a site through Firecrawl's map endpoint. ${OUTPUT_LIMIT_DESCRIPTION}`,
  parameters: Type.Object({
    url: Type.String({ description: "Website URL to map." }),
    search: Type.Optional(Type.String({ description: "Optional search term to filter discovered URLs." })),
    ignoreSitemap: Type.Optional(Type.Boolean({ description: "Ignore sitemap discovery." })),
    sitemapOnly: Type.Optional(Type.Boolean({ description: "Only use sitemap URLs when supported." })),
    includeSubdomains: Type.Optional(Type.Boolean({ description: "Include subdomains when supported." })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of URLs to return." })),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "map", async () => {
      const payload = await firecrawlRequest("POST", "/map", cleanObject(params), signal, ctx.sessionManager);
      return await jsonResult(payload, ctx.sessionManager);
    });
  },
});

export const searchTool = defineTool({
  name: FIRECRAWL_TOOL_NAMES[4],
  label: "Firecrawl: Search",
  description: `Search the web through Firecrawl and optionally scrape search results. ${OUTPUT_LIMIT_DESCRIPTION}`,
  parameters: Type.Object({
    query: Type.String({ description: "Search query." }),
    limit: Type.Optional(Type.Number({ description: "Maximum number of search results." })),
    tbs: Type.Optional(Type.String({ description: "Google-style time based search filter when supported." })),
    location: Type.Optional(Type.String({ description: "Search location when supported." })),
    scrapeOptions: Type.Optional(Type.Any({ description: "Firecrawl scrapeOptions for search result pages." })),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    return withStatus(ctx, "search", async () => {
      const payload = await firecrawlRequest("POST", "/search", cleanObject(params), signal, ctx.sessionManager);
      return await jsonResult(payload, ctx.sessionManager);
    });
  },
});
