import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupResponses, openResponses } from "./response-format.js";
import { contentsTool, searchTool } from "./tools.js";

export {
	configuredServerUrl,
	hasApiKey,
	normalizeUrl,
	parseSseStream,
	youcomRequest,
} from "./client.js";
export {
	boundResponseText,
	cleanupResponses,
	formatJsonResult,
	openResponses,
} from "./response-format.js";
export { YOUCOM_TOOL_NAMES } from "./tool-names.js";

/**
 * Passive You.com web search extension.
 *
 * Registers model-facing tools backed by the You.com MCP server. Tools are
 * only available when the extension is installed; no default Pi behavior
 * changes. Keyless search works through the free profile of the You.com MCP
 * endpoint; setting YDC_API_KEY switches to the authenticated endpoint and
 * enables page content extraction.
 */
export default function youcom(pi: ExtensionAPI) {
	pi.registerTool(searchTool);
	pi.registerTool(contentsTool);

	pi.on("session_start", async (_event, ctx) => {
		openResponses(ctx.sessionManager);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await cleanupResponses(ctx.sessionManager);
	});
}
