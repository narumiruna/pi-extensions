import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_API_URL = "https://api.firecrawl.dev/v1";
const STATUS_KEY = "firecrawl";

const StringArray = Type.Array(Type.String());

interface FirecrawlState {
	apiUrl: string;
}

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

const state: FirecrawlState = {
	apiUrl: normalizeApiUrl(process.env.FIRECRAWL_API_URL ?? process.env.FIRECRAWL_BASE_URL),
};

const scrapeTool = defineTool({
	name: "firecrawl_scrape",
	label: "Firecrawl: Scrape",
	description: "Scrape a single URL through Firecrawl and return requested formats.",
	promptSnippet: "Scrape a URL through Firecrawl",
	promptGuidelines: [
		"Use firecrawl_scrape when you need clean markdown, HTML, links, screenshots, or structured extraction for one URL.",
		"If FIRECRAWL_API_KEY is missing, report the configuration error instead of retrying repeatedly.",
	],
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
		onlyMainContent: Type.Optional(
			Type.Boolean({ description: "Return only the main page content when supported." }),
		),
		includeTags: Type.Optional(StringArray),
		excludeTags: Type.Optional(StringArray),
		waitFor: Type.Optional(Type.Number({ description: "Milliseconds to wait before scraping." })),
		timeout: Type.Optional(
			Type.Number({ description: "Firecrawl request timeout in milliseconds." }),
		),
		mobile: Type.Optional(Type.Boolean({ description: "Use a mobile user agent when supported." })),
		skipTlsVerification: Type.Optional(
			Type.Boolean({ description: "Skip TLS certificate verification when supported." }),
		),
		removeBase64Images: Type.Optional(
			Type.Boolean({ description: "Remove base64 image data from the response when supported." }),
		),
		blockAds: Type.Optional(
			Type.Boolean({ description: "Block ads while scraping when supported." }),
		),
		headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Additional HTTP headers Firecrawl should use while fetching the target URL.",
			}),
		),
		jsonOptions: Type.Optional(
			Type.Any({ description: "Firecrawl jsonOptions for structured extraction." }),
		),
		actions: Type.Optional(
			Type.Array(Type.Any(), {
				description: "Firecrawl browser actions to perform before scraping.",
			}),
		),
		location: Type.Optional(Type.Any({ description: "Firecrawl location options." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "firecrawl: scrape", async () => {
			const payload = await firecrawlRequest("POST", "/scrape", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

const crawlTool = defineTool({
	name: "firecrawl_crawl",
	label: "Firecrawl: Crawl",
	description: "Start a Firecrawl crawl job for a website.",
	promptSnippet: "Start a Firecrawl site crawl job",
	parameters: Type.Object({
		url: Type.String({ description: "Starting URL for the crawl." }),
		limit: Type.Optional(Type.Number({ description: "Maximum number of pages to crawl." })),
		maxDepth: Type.Optional(Type.Number({ description: "Maximum crawl depth when supported." })),
		includePaths: Type.Optional(
			Type.Array(Type.String(), { description: "URL path patterns to include." }),
		),
		excludePaths: Type.Optional(
			Type.Array(Type.String(), { description: "URL path patterns to exclude." }),
		),
		allowBackwardLinks: Type.Optional(
			Type.Boolean({ description: "Allow crawling backward links when supported." }),
		),
		allowExternalLinks: Type.Optional(
			Type.Boolean({ description: "Allow crawling external links when supported." }),
		),
		ignoreSitemap: Type.Optional(Type.Boolean({ description: "Ignore sitemap discovery." })),
		deduplicateSimilarURLs: Type.Optional(
			Type.Boolean({ description: "Deduplicate similar URLs when supported." }),
		),
		scrapeOptions: Type.Optional(
			Type.Any({ description: "Firecrawl scrapeOptions applied to crawled pages." }),
		),
		webhook: Type.Optional(Type.Any({ description: "Firecrawl webhook configuration." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "firecrawl: crawl", async () => {
			const payload = await firecrawlRequest("POST", "/crawl", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

const crawlStatusTool = defineTool({
	name: "firecrawl_crawl_status",
	label: "Firecrawl: Crawl Status",
	description: "Check a Firecrawl crawl job status and retrieve completed crawl data.",
	promptSnippet: "Check a Firecrawl crawl job status",
	parameters: Type.Object({
		id: Type.String({ description: "Crawl job id returned by firecrawl_crawl." }),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "firecrawl: crawl status", async () => {
			const payload = await firecrawlRequest(
				"GET",
				`/crawl/${encodeURIComponent(params.id)}`,
				undefined,
				signal,
			);
			return jsonResult(payload);
		});
	},
});

const mapTool = defineTool({
	name: "firecrawl_map",
	label: "Firecrawl: Map",
	description: "Discover URLs for a site through Firecrawl's map endpoint.",
	promptSnippet: "Map/discover URLs for a site through Firecrawl",
	parameters: Type.Object({
		url: Type.String({ description: "Website URL to map." }),
		search: Type.Optional(
			Type.String({ description: "Optional search term to filter discovered URLs." }),
		),
		ignoreSitemap: Type.Optional(Type.Boolean({ description: "Ignore sitemap discovery." })),
		sitemapOnly: Type.Optional(
			Type.Boolean({ description: "Only use sitemap URLs when supported." }),
		),
		includeSubdomains: Type.Optional(
			Type.Boolean({ description: "Include subdomains when supported." }),
		),
		limit: Type.Optional(Type.Number({ description: "Maximum number of URLs to return." })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "firecrawl: map", async () => {
			const payload = await firecrawlRequest("POST", "/map", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

const searchTool = defineTool({
	name: "firecrawl_search",
	label: "Firecrawl: Search",
	description: "Search the web through Firecrawl and optionally scrape search results.",
	promptSnippet: "Search the web through Firecrawl",
	parameters: Type.Object({
		query: Type.String({ description: "Search query." }),
		limit: Type.Optional(Type.Number({ description: "Maximum number of search results." })),
		tbs: Type.Optional(
			Type.String({ description: "Google-style time based search filter when supported." }),
		),
		location: Type.Optional(Type.String({ description: "Search location when supported." })),
		scrapeOptions: Type.Optional(
			Type.Any({ description: "Firecrawl scrapeOptions for search result pages." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "firecrawl: search", async () => {
			const payload = await firecrawlRequest("POST", "/search", cleanObject(params), signal);
			return jsonResult(payload);
		});
	},
});

export default function firecrawl(pi: ExtensionAPI) {
	pi.registerTool(scrapeTool);
	pi.registerTool(crawlTool);
	pi.registerTool(crawlStatusTool);
	pi.registerTool(mapTool);
	pi.registerTool(searchTool);

	pi.registerCommand("firecrawl", {
		description: "Show Firecrawl extension configuration status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildStatusMessage(), hasApiKey() ? "info" : "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function firecrawlRequest(
	method: "GET" | "POST",
	path: string,
	body: unknown,
	signal: AbortSignal | undefined,
) {
	const apiKey = getApiKey();
	const response = await fetch(`${state.apiUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});

	const responseText = await response.text();
	const payload = parseResponseBody(responseText);

	if (!response.ok) {
		throw new Error(
			`Firecrawl ${method} ${path} returned ${response.status} ${response.statusText}: ${formatPayload(payload)}`,
		);
	}

	return payload;
}

function getApiKey() {
	const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"FIRECRAWL_API_KEY is required for pi-firecrawl. Set it in the environment before running pi.",
		);
	}

	return apiKey;
}

function hasApiKey() {
	return Boolean(process.env.FIRECRAWL_API_KEY?.trim());
}

function normalizeApiUrl(apiUrl: string | undefined) {
	return (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

function parseResponseBody(responseText: string) {
	if (!responseText) return null;

	try {
		return JSON.parse(responseText) as unknown;
	} catch {
		return responseText;
	}
}

function formatPayload(payload: unknown) {
	if (typeof payload === "string") return payload;
	return JSON.stringify(payload);
}

function jsonResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

async function withStatus<T>(ctx: StatusContext, status: string, callback: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await callback();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function buildStatusMessage() {
	return hasApiKey()
		? `Firecrawl configured: ${state.apiUrl} (API key present).`
		: `Firecrawl missing FIRECRAWL_API_KEY. API URL: ${state.apiUrl}.`;
}

function cleanObject<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => cleanObject(item)) as T;
	}

	if (!value || typeof value !== "object") return value;

	const entries = Object.entries(value)
		.filter(([, entryValue]) => entryValue !== undefined)
		.map(([entryKey, entryValue]) => [entryKey, cleanObject(entryValue)]);

	return Object.fromEntries(entries) as T;
}
