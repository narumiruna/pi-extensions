import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FIRECRAWL_TOOL_NAMES, type FirecrawlToolName } from "./tool-names.js";

export const FIRECRAWL_LOAD_TOOL_NAME = "firecrawl_load";

const AVAILABLE_TOOLS_STORE = Symbol.for("@narumitw/pi-firecrawl.available-tools-store");
const SESSION_AVAILABLE_TOOLS_STORE = Symbol.for(
	"@narumitw/pi-firecrawl.session-available-tools-store",
);
type FirecrawlGlobal = typeof globalThis & {
	[AVAILABLE_TOOLS_STORE]?: WeakMap<ExtensionAPI, Set<FirecrawlToolName>>;
	[SESSION_AVAILABLE_TOOLS_STORE]?: WeakMap<object, Set<FirecrawlToolName>>;
};
const sharedGlobal = globalThis as FirecrawlGlobal;
const existingAvailableToolsStore = sharedGlobal[AVAILABLE_TOOLS_STORE];
const availableToolsByApi =
	existingAvailableToolsStore ?? new WeakMap<ExtensionAPI, Set<FirecrawlToolName>>();
if (!existingAvailableToolsStore) sharedGlobal[AVAILABLE_TOOLS_STORE] = availableToolsByApi;
const existingSessionAvailableToolsStore = sharedGlobal[SESSION_AVAILABLE_TOOLS_STORE];
const availableToolsBySession =
	existingSessionAvailableToolsStore ?? new WeakMap<object, Set<FirecrawlToolName>>();
if (!existingSessionAvailableToolsStore) {
	sharedGlobal[SESSION_AVAILABLE_TOOLS_STORE] = availableToolsBySession;
}
const lazyExposureByApi = new WeakMap<ExtensionAPI, boolean>();

const CRAWL_CREATION_TERMS = new Set(["begin", "create", "launch", "start"]);

const SEARCH_TEXT: Record<FirecrawlToolName, string> = {
	firecrawl_scrape:
		"scrape scraping extract extraction single url page pages markdown html raw links screenshot json structured content",
	firecrawl_crawl: "crawl crawling website site start pages depth paths sitemap batch",
	firecrawl_crawl_status:
		"crawl crawling status job monitor check retrieve completed progress results",
	firecrawl_map: "map mapping discover discovery url urls links sitemap site inventory",
	firecrawl_search:
		"search searching web internet query results research discover discovery optionally scrape",
};

export function initializeAvailableFirecrawlTools(pi: ExtensionAPI, sessionOwner?: object) {
	if (sessionOwner) {
		const sessionTools = availableToolsBySession.get(sessionOwner);
		if (sessionTools) {
			setAvailableTools(pi, sessionTools, sessionOwner);
			return;
		}
	}
	const apiTools = availableToolsByApi.get(pi);
	if (apiTools) {
		if (sessionOwner) setAvailableTools(pi, apiTools, sessionOwner);
		return;
	}
	const activeTools = new Set(pi.getActiveTools());
	setAvailableTools(
		pi,
		FIRECRAWL_TOOL_NAMES.filter((name) => activeTools.has(name)),
		sessionOwner,
	);
}

export function configureFirecrawlToolExposure(
	pi: ExtensionAPI,
	availableTools: readonly FirecrawlToolName[],
	loadedTools: readonly FirecrawlToolName[] = [],
	sessionOwner?: object,
	model?: ExtensionContext["model"],
) {
	const available = setAvailableTools(pi, availableTools, sessionOwner);
	const lazyExposure = supportsNativeDeferredToolLoading(model);
	lazyExposureByApi.set(pi, lazyExposure);
	const loaded = new Set(loadedTools);
	const exposedTools = lazyExposure
		? FIRECRAWL_TOOL_NAMES.filter((name) => available.has(name) && loaded.has(name))
		: FIRECRAWL_TOOL_NAMES.filter((name) => available.has(name));
	const nonCapabilityTools = pi
		.getActiveTools()
		.filter((name) => !FIRECRAWL_TOOL_NAMES.includes(name as FirecrawlToolName));
	pi.setActiveTools(unique([...nonCapabilityTools, FIRECRAWL_LOAD_TOOL_NAME, ...exposedTools]));
}

export function requireEagerFirecrawlToolExposure(pi: ExtensionAPI) {
	lazyExposureByApi.set(pi, false);
	const active = pi.getActiveTools();
	const available = availableFirecrawlTools(pi);
	pi.setActiveTools(unique([...active, FIRECRAWL_LOAD_TOOL_NAME, ...available]));
}

export function applyAvailableFirecrawlTools(
	pi: ExtensionAPI,
	availableTools: readonly FirecrawlToolName[],
	sessionOwner?: object,
) {
	const available = setAvailableTools(pi, availableTools, sessionOwner);
	const lazyExposure = lazyExposureByApi.get(pi) === true;
	const active = pi
		.getActiveTools()
		.filter(
			(name) =>
				!FIRECRAWL_TOOL_NAMES.includes(name as FirecrawlToolName) ||
				(lazyExposure && available.has(name as FirecrawlToolName)),
		);
	const eagerTools = lazyExposure ? [] : FIRECRAWL_TOOL_NAMES.filter((name) => available.has(name));
	pi.setActiveTools(unique([...active, FIRECRAWL_LOAD_TOOL_NAME, ...eagerTools]));
}

export function firecrawlToolExposureMode(pi: ExtensionAPI) {
	return lazyExposureByApi.get(pi) === true ? "native deferred" : "eager";
}

export function supportsNativeDeferredToolLoading(model: ExtensionContext["model"]): boolean {
	if (!model) return false;
	if (model.api === "anthropic-messages") {
		const configured = compatBoolean(model.compat, "supportsToolReferences");
		if (configured !== undefined) return configured;
		if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
		const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
		if (!version) return false;
		const major = Number(version[1]);
		const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
		return major > 4 || (major === 4 && minor >= 5);
	}
	if (model.api === "openai-completions") {
		return compatString(model.compat, "deferredToolsMode") === "kimi";
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		return (
			compatBoolean(model.compat, "supportsAdditionalTools") === true ||
			compatBoolean(model.compat, "supportsToolSearch") === true
		);
	}
	return false;
}

export function availableFirecrawlTools(pi: ExtensionAPI) {
	const available = availableToolsByApi.get(pi) ?? new Set();
	return FIRECRAWL_TOOL_NAMES.filter((name) => available.has(name));
}

export function createFirecrawlLoadTool(pi: ExtensionAPI) {
	return defineTool({
		name: FIRECRAWL_LOAD_TOOL_NAME,
		label: "Firecrawl: Load Tools",
		description:
			"Find and enable Firecrawl tools relevant to a web scraping, crawling, URL discovery, crawl-status, or search task. Loaded tools remain available for the session.",
		promptSnippet: "Load Firecrawl web research capabilities on demand",
		promptGuidelines: [
			"Use firecrawl_load when a task requires Firecrawl web scraping, crawling, URL discovery, crawl status, or search and the needed firecrawl_* capability is not active.",
			"If FIRECRAWL_API_KEY is missing, report the configuration error instead of retrying repeatedly.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Firecrawl capability or web research task to find tools for.",
				maxLength: 500,
			}),
			limit: Type.Optional(
				Type.Integer({
					description: "Maximum tools to load. Defaults to 3.",
					minimum: 1,
					maximum: 5,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			signal?.throwIfAborted();
			const available = new Set(availableFirecrawlTools(pi));
			const matches = matchFirecrawlTools(params.query, params.limit ?? 3, available);
			const active = pi.getActiveTools();
			const activeSet = new Set(active);
			const added = matches.filter((name) => !activeSet.has(name));
			if (added.length > 0) pi.setActiveTools(unique([...active, ...added]));

			const text =
				matches.length === 0
					? "No available Firecrawl tools matched the query."
					: added.length > 0
						? `Loaded Firecrawl tools: ${added.join(", ")}`
						: `Matching Firecrawl tools are already loaded: ${matches.join(", ")}`;
			return {
				content: [{ type: "text" as const, text }],
				details: { matches, added },
			};
		},
	});
}

function matchFirecrawlTools(
	query: string,
	limit: number,
	available: ReadonlySet<FirecrawlToolName>,
) {
	const terms = [
		...new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((term) => term.length >= 2),
		),
	];
	if (terms.length === 0) return [];
	const ranked = FIRECRAWL_TOOL_NAMES.filter((name) => available.has(name))
		.map((name, index) => ({
			name,
			index,
			score: terms.reduce(
				(score, term) => score + (SEARCH_TEXT[name].split(" ").includes(term) ? 1 : 0),
				0,
			),
		}))
		.filter((match) => match.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);
	const bestScore = ranked[0]?.score;
	if (bestScore === undefined) return [];
	const matches = ranked
		.filter((match) => match.score === bestScore)
		.slice(0, limit)
		.map((match) => match.name);
	if (
		matches.includes("firecrawl_crawl") &&
		available.has("firecrawl_crawl_status") &&
		!matches.includes("firecrawl_crawl_status") &&
		matches.length < limit
	) {
		matches.push("firecrawl_crawl_status");
	}
	if (
		matches.includes("firecrawl_crawl_status") &&
		available.has("firecrawl_crawl") &&
		!matches.includes("firecrawl_crawl") &&
		terms.some((term) => CRAWL_CREATION_TERMS.has(term)) &&
		matches.length < limit
	) {
		matches.unshift("firecrawl_crawl");
	}
	return matches;
}

export function loadedFirecrawlToolsFromBranch(
	entries: readonly unknown[],
	availableTools: readonly FirecrawlToolName[],
) {
	const available = new Set(availableTools);
	const loaded = new Set<FirecrawlToolName>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (
			message.role !== "toolResult" ||
			message.toolName !== FIRECRAWL_LOAD_TOOL_NAME ||
			message.isError === true
		) {
			continue;
		}
		const details = isRecord(message.details) ? message.details : undefined;
		const recordedNames = [
			...(Array.isArray(message.addedToolNames) ? message.addedToolNames : []),
			...(details && Array.isArray(details.added) ? details.added : []),
		];
		for (const name of recordedNames) {
			if (isFirecrawlToolName(name) && available.has(name)) loaded.add(name);
		}
	}
	return FIRECRAWL_TOOL_NAMES.filter((name) => loaded.has(name));
}

function setAvailableTools(
	pi: ExtensionAPI,
	availableTools: readonly FirecrawlToolName[] | ReadonlySet<FirecrawlToolName>,
	sessionOwner?: object,
) {
	const available = new Set(availableTools);
	availableToolsByApi.set(pi, available);
	if (sessionOwner) availableToolsBySession.set(sessionOwner, new Set(available));
	return available;
}

function isFirecrawlToolName(value: unknown): value is FirecrawlToolName {
	return typeof value === "string" && FIRECRAWL_TOOL_NAMES.includes(value as FirecrawlToolName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compatBoolean(value: unknown, key: string) {
	if (!isRecord(value)) return undefined;
	return typeof value[key] === "boolean" ? value[key] : undefined;
}

function compatString(value: unknown, key: string) {
	if (!isRecord(value)) return undefined;
	return typeof value[key] === "string" ? value[key] : undefined;
}

function unique(values: readonly string[]) {
	return [...new Set(values)];
}
