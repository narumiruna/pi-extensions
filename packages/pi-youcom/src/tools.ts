import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasApiKey, withStatus, youcomRequest } from "./client.js";
import { formatJsonResult } from "./response-format.js";
import { YOUCOM_TOOL_NAMES } from "./tool-names.js";

const EXTRACTION_MODES = ["none", "highlights", "full_page"] as const;
const OUTPUT_LIMIT_DESCRIPTION = `Output is truncated to 2,000 lines or 50 KB; complete truncated responses are saved temporarily and their path is returned.`;

/**
 * Tool parameters are forwarded to the You.com MCP server as tool arguments.
 * The schemas below mirror the server's you-search input schema.
 */
export const searchTool = defineTool({
	name: YOUCOM_TOOL_NAMES[0],
	label: "You.com: Search",
	description: `Search the web for current information through You.com and return ranked results with URLs, snippets, and optional query-relevant passages. Inline site:, lang:, and loc: filters are supported. ${OUTPUT_LIMIT_DESCRIPTION}`,
	parameters: Type.Object({
		query: Type.String({ description: "Short natural-language search query." }),
		count: Type.Optional(Type.Number({ description: "Maximum number of results (1-100)." })),
		freshness: Type.Optional(
			Type.String({
				description:
					"Limit results to a recent window: day, week, month, year, or a YYYY-MM-DDtoYYYY-MM-DD range. Omit for evergreen facts.",
			}),
		),
		extraction: Type.Optional(
			StringEnum(EXTRACTION_MODES, {
				description: "Extraction mode. Defaults to highlights.",
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "search", async () => {
			const payload = await youcomRequest(
				"tools/call",
				{ name: "you-search", arguments: cleanObject(params) },
				signal,
			);
			return await formatJsonResult(payload, ctx.sessionManager);
		});
	},
});

export const contentsTool = defineTool({
	name: YOUCOM_TOOL_NAMES[1],
	label: "You.com: Contents",
	description: `Read a web page through You.com and return extracted page content. Requires YDC_API_KEY because the keyless free profile only exposes search. ${OUTPUT_LIMIT_DESCRIPTION}`,
	parameters: Type.Object({
		url: Type.String({ description: "URL to read." }),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		if (!hasApiKey()) {
			throw new Error(
				"youcom_contents requires YDC_API_KEY. Set it to switch to the authenticated You.com MCP endpoint, then retry.",
			);
		}
		return withStatus(ctx, "contents", async () => {
			const payload = await youcomRequest(
				"tools/call",
				{ name: "you-contents", arguments: cleanObject(params) },
				signal,
			);
			return await formatJsonResult(payload, ctx.sessionManager);
		});
	},
});

function cleanObject<T>(value: T): T {
	if (Array.isArray(value)) return value.map(cleanObject) as T;
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.map(([key, item]) => [key, cleanObject(item)]),
	) as T;
}
