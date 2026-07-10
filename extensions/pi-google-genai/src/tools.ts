import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	cleanObject,
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
} from "./config.js";
import { callInteraction } from "./interaction-client.js";

const STATUS_KEY = "google-genai";
const SEARCH_TYPES = ["web_search", "image_search"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

const SearchTypesParameter = Type.Optional(
	Type.Array(Type.Union([Type.Literal("web_search"), Type.Literal("image_search")]), {
		description: "Optional Google Search grounding types. Defaults to Google's web search.",
	}),
);
const TimeoutMsParameter = Type.Optional(
	Type.Integer({
		description: `Per-call timeout in milliseconds. Overrides google-genai.json timeoutMs and the ${DEFAULT_TIMEOUT_MS}ms default. Must be an integer from 1 to ${MAX_TIMEOUT_MS}.`,
		minimum: 1,
		maximum: MAX_TIMEOUT_MS,
	}),
);

export function validateSearchTypes(searchTypes: unknown): SearchType[] | undefined {
	if (searchTypes === undefined) return undefined;
	if (!Array.isArray(searchTypes)) throw new Error("searchTypes must be an array.");
	const values = [...new Set(searchTypes)];
	for (const value of values) {
		if (!SEARCH_TYPES.includes(value as SearchType)) {
			throw new Error(`searchTypes supports only: ${SEARCH_TYPES.join(", ")}.`);
		}
	}
	return values as SearchType[];
}

function isValidTimeoutMs(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
}

export function validateTimeoutMs(timeoutMs: unknown): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (!isValidTimeoutMs(timeoutMs)) {
		throw new Error(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds.`);
	}
	return timeoutMs;
}

export function validateMapsLocation(params: { latitude?: unknown; longitude?: unknown }) {
	const hasLatitude = params.latitude !== undefined;
	const hasLongitude = params.longitude !== undefined;
	if (hasLatitude !== hasLongitude) {
		throw new Error("latitude and longitude must be provided together.");
	}
	if (!hasLatitude) return {};
	if (typeof params.latitude !== "number" || !Number.isFinite(params.latitude)) {
		throw new Error("latitude must be a finite number.");
	}
	if (typeof params.longitude !== "number" || !Number.isFinite(params.longitude)) {
		throw new Error("longitude must be a finite number.");
	}
	if (params.latitude < -90 || params.latitude > 90) {
		throw new Error("latitude must be between -90 and 90.");
	}
	if (params.longitude < -180 || params.longitude > 180) {
		throw new Error("longitude must be between -180 and 180.");
	}
	return { latitude: params.latitude, longitude: params.longitude };
}

export function validateUrls(urls: unknown): string[] {
	if (!Array.isArray(urls) || urls.length === 0) {
		throw new Error("urls must contain at least one http:// or https:// URL.");
	}
	return urls.map((url) => {
		if (typeof url !== "string" || !url.trim()) {
			throw new Error("urls must contain non-empty strings.");
		}
		let parsed: URL;
		try {
			parsed = new URL(url.trim());
		} catch {
			throw new Error(`Invalid URL: ${url}`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`Only http:// and https:// URLs are supported: ${url}`);
		}
		return url.trim();
	});
}

export const googleSearchTool = defineTool({
	name: "google_search",
	label: "Google GenAI: Search",
	description: `Search Google through Gemini Interactions grounding. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
	promptSnippet: "Search Google through Gemini grounding",
	promptGuidelines: [
		"Use google_search when the user asks for current public web or image-search-backed information.",
		"Split or narrow broad trend, multi-product, or market-research questions before synthesizing.",
		"If Google GenAI auth is missing, report the configuration error instead of retrying repeatedly.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search question or query." }),
		searchTypes: SearchTypesParameter,
		timeoutMs: TimeoutMsParameter,
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const searchTypes = validateSearchTypes(params.searchTypes);
		const timeoutMs = validateTimeoutMs(params.timeoutMs);
		return withStatus(ctx, "search", () =>
			callInteraction(
				{
					input: params.query,
					tool: cleanObject({ type: "google_search", search_types: searchTypes }),
					timeoutMs,
					timeoutAdvice:
						"Broad trend, comparison, review, or search-result synthesis queries can time out; narrow the query or split it into smaller google_search calls before increasing the timeout.",
				},
				ctx,
				signal,
			),
		);
	},
});

export const googleMapsTool = defineTool({
	name: "google_maps",
	label: "Google GenAI: Maps",
	description: `Ask Google Maps-grounded questions through Gemini Interactions. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
	promptSnippet: "Ask Google Maps-grounded questions",
	promptGuidelines: [
		"Use google_maps for place, nearby, route, and local-business questions that benefit from Google Maps grounding.",
		"Provide both latitude and longitude when the user's current location matters; omit both for general place questions.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Maps-grounded question or place query." }),
		latitude: Type.Optional(Type.Number({ description: "User latitude in degrees." })),
		longitude: Type.Optional(Type.Number({ description: "User longitude in degrees." })),
		timeoutMs: TimeoutMsParameter,
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const location = validateMapsLocation(params);
		const timeoutMs = validateTimeoutMs(params.timeoutMs);
		return withStatus(ctx, "maps", () =>
			callInteraction(
				{
					input: params.query,
					tool: cleanObject({ type: "google_maps", ...location }),
					timeoutMs,
				},
				ctx,
				signal,
			),
		);
	},
});

export const googleUrlContextTool = defineTool({
	name: "google_url_context",
	label: "Google GenAI: URL Context",
	description: `Ask Gemini to use specific http/https URLs as context. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
	promptSnippet: "Ask Gemini to use specific URL context",
	promptGuidelines: [
		"Use google_url_context when the user provides specific URLs and asks about their contents.",
		"Use firecrawl tools instead when the user needs raw HTML, markdown extraction, or site crawling.",
	],
	parameters: Type.Object({
		prompt: Type.String({ description: "Question or instruction for the provided URLs." }),
		urls: Type.Array(Type.String({ description: "HTTP or HTTPS URL to fetch as context." }), {
			description: "One or more http:// or https:// URLs.",
			minItems: 1,
		}),
		timeoutMs: TimeoutMsParameter,
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const urls = validateUrls(params.urls);
		const timeoutMs = validateTimeoutMs(params.timeoutMs);
		return withStatus(ctx, "url", () =>
			callInteraction(
				{
					input: `${params.prompt}\n\nURLs:\n${urls.join("\n")}`,
					tool: { type: "url_context" },
					timeoutMs,
				},
				ctx,
				signal,
			),
		);
	},
});

async function withStatus<T>(ctx: ExtensionContext, status: string, fn: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await fn();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

