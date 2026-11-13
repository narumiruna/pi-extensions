export const FIRECRAWL_TOOL_NAMES = [
  "firecrawl_scrape",
  "firecrawl_crawl",
  "firecrawl_crawl_status",
  "firecrawl_map",
  "firecrawl_search",
] as const;

export type FirecrawlToolName = (typeof FIRECRAWL_TOOL_NAMES)[number];
