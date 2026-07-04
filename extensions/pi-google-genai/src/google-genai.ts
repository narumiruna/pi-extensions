import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
	truncateLine,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DEFAULT_MODEL = "gemini-3.5-flash";
export const DEFAULT_API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const GOOGLE_GENAI_TOOL_NAMES = [
	"google_search",
	"google_maps",
	"google_url_context",
] as const;

const STATUS_KEY = "google-genai";
const CONFIG_FILE_NAME = "google-genai.json";
const SEARCH_TYPES = ["web_search", "image_search"] as const;
const SOURCE_LIMIT = 10;
const COMMAND_COMPLETIONS = [
	{ value: "init", label: "init", description: "Create or update Google GenAI config" },
	{ value: "status", label: "status", description: "Show Google GenAI config status" },
	{ value: "config", label: "config", description: "Show Google GenAI config status" },
	{ value: "help", label: "help", description: "Show Google GenAI command usage" },
	{ value: "tools", label: "tools", description: "Select Google GenAI tools" },
	{ value: "enable", label: "enable", description: "Enable all Google GenAI tools" },
	{ value: "disable", label: "disable", description: "Disable all Google GenAI tools" },
];

const SearchTypesParameter = Type.Optional(
	Type.Array(Type.Union([Type.Literal("web_search"), Type.Literal("image_search")]), {
		description: "Optional Google Search grounding types. Defaults to Google's web search.",
	}),
);

type GoogleGenaiToolName = (typeof GOOGLE_GENAI_TOOL_NAMES)[number];
type SearchType = (typeof SEARCH_TYPES)[number];
type CommandAction =
	| "status"
	| "init"
	| "help"
	| "tools"
	| "enable"
	| "disable"
	| "unknown";

export interface GoogleGenaiConfig {
	apiKey?: string;
	model: string;
	apiUrl: string;
	timeoutMs: number;
	tools: GoogleGenaiToolName[];
}

export interface LoadedGoogleGenaiConfig {
	config: GoogleGenaiConfig;
	path: string;
	warnings: string[];
	configLoaded: boolean;
}

interface GoogleGenaiSource {
	type: string;
	title?: string;
	name?: string;
	url?: string;
	status?: string;
	placeId?: string;
}

interface GoogleGenaiDetails {
	model: string;
	outputText: string;
	sources: GoogleGenaiSource[];
	toolSteps: unknown[];
	truncated: boolean;
	truncation?: {
		truncatedBy: "lines" | "bytes" | null;
		totalLines: number;
		totalBytes: number;
		outputLines: number;
		outputBytes: number;
	};
	fullResponsePath?: string;
}

interface InteractionRequest {
	model: string;
	input: string;
	tools: Array<Record<string, unknown>>;
}

interface FetchSignal {
	signal: AbortSignal;
	cleanup(): void;
	isTimeout(): boolean;
}

let rawResponseDirectoryPromise: Promise<string> | undefined;

const googleSearchTool = defineTool({
	name: "google_search",
	label: "Google GenAI: Search",
	description: `Search Google through Gemini Interactions grounding. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
	promptSnippet: "Search Google through Gemini grounding",
	promptGuidelines: [
		"Use google_search when the user asks for current public web or image-search-backed information.",
		"If Google GenAI auth is missing, report the configuration error instead of retrying repeatedly.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search question or query." }),
		searchTypes: SearchTypesParameter,
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const searchTypes = validateSearchTypes(params.searchTypes);
		return withStatus(ctx, "search", () =>
			callInteraction(
				{
					input: params.query,
					tool: cleanObject({ type: "google_search", search_types: searchTypes }),
				},
				ctx,
				signal,
			),
		);
	},
});

const googleMapsTool = defineTool({
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
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const location = validateMapsLocation(params);
		return withStatus(ctx, "maps", () =>
			callInteraction(
				{
					input: params.query,
					tool: cleanObject({ type: "google_maps", ...location }),
				},
				ctx,
				signal,
			),
		);
	},
});

const googleUrlContextTool = defineTool({
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
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const urls = validateUrls(params.urls);
		return withStatus(ctx, "url", () =>
			callInteraction(
				{
					input: `${params.prompt}\n\nURLs:\n${urls.join("\n")}`,
					tool: { type: "url_context" },
				},
				ctx,
				signal,
			),
		);
	},
});

export default function googleGenai(pi: ExtensionAPI) {
	pi.registerTool(googleSearchTool);
	pi.registerTool(googleMapsTool);
	pi.registerTool(googleUrlContextTool);

	pi.registerCommand("google-genai", {
		description: "Configure Google GenAI grounding tools",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			await handleCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const loaded = await loadGoogleGenaiConfig();
		if (loaded.configLoaded) applyGoogleToolSelection(pi, loaded.config.tools);
		if (loaded.warnings.length > 0) ctx.ui.notify(loaded.warnings.join("\n"), "warning");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await cleanupRawResponseDirectory();
	});
}

export function googleGenaiConfigPath() {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), CONFIG_FILE_NAME);
}

export function parseCommand(rawArgs: string): CommandAction {
	const [command = ""] = splitArgs(rawArgs);
	switch (command) {
		case "":
		case "status":
		case "config":
			return "status";
		case "init":
			return "init";
		case "help":
			return "help";
		case "tools":
		case "toggle":
		case "select":
			return "tools";
		case "enable":
		case "on":
			return "enable";
		case "disable":
		case "off":
			return "disable";
		default:
			return "unknown";
	}
}

export function commandCompletions(prefix: string) {
	if (/\s/.test(prefix.trimStart())) return null;
	const token = prefix.trimStart();
	const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(token));
	return matches.length > 0 ? matches : null;
}

export function normalizeGoogleGenaiSettings(value: unknown): GoogleGenaiConfig {
	return normalizeConfigWithWarnings(value).config;
}

export async function loadGoogleGenaiConfig(): Promise<LoadedGoogleGenaiConfig> {
	const path = googleGenaiConfigPath();
	const warnings: string[] = [];
	await ensureConfigPermissions(path, warnings);
	const raw = await readJsonIfExists(path, warnings);
	const configLoaded = isObject(raw);
	if (raw !== undefined && !configLoaded) {
		warnings.push("google-genai.json must contain a JSON object; ignoring config.");
	}
	const normalized = normalizeConfigWithWarnings(configLoaded ? raw : undefined);
	return {
		config: normalized.config,
		path,
		warnings: [...warnings, ...normalized.warnings],
		configLoaded,
	};
}

export async function resolveGoogleGenaiAuth(
	config: Pick<GoogleGenaiConfig, "apiKey">,
	ctx: Pick<ExtensionContext, "modelRegistry">,
) {
	if (config.apiKey) {
		if (isUnsupportedConfigApiKey(config.apiKey)) {
			throw new Error(
				"Interpolation and command syntax are not supported in google-genai.json apiKey. Use a literal key, /login google, or GEMINI_API_KEY.",
			);
		}
		return config.apiKey;
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("google");
	if (apiKey) return apiKey;

	throw new Error(
		`Missing Google GenAI API key. Run /google-genai init, run /login google, or set GEMINI_API_KEY. Config path: ${googleGenaiConfigPath()}`,
	);
}

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

export async function formatToolResult(raw: unknown, model: string) {
	const outputText = extractOutputText(raw).trim() || "No response received.";
	const sources = extractSources(raw);
	const toolSteps = extractToolSteps(raw);
	const text = formatContent(outputText, sources);
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const details: GoogleGenaiDetails = {
		model,
		outputText,
		sources,
		toolSteps,
		truncated: truncation.truncated,
	};

	if (!truncation.truncated) {
		return { content: [{ type: "text" as const, text: truncation.content }], details };
	}

	const fullResponsePath = await writeRawResponse(raw);
	details.fullResponsePath = fullResponsePath;
	details.truncation = {
		truncatedBy: truncation.truncatedBy,
		totalLines: truncation.totalLines,
		totalBytes: truncation.totalBytes,
		outputLines: truncation.outputLines,
		outputBytes: truncation.outputBytes,
	};
	const footer = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full response saved to: ${fullResponsePath}]`;
	const suffix = joinBlocks([sources.length > 0 ? formatSourcesSection(sources) : "", footer]);
	const truncatedOutput = truncateHead(outputText, {
		maxLines: Math.max(0, DEFAULT_MAX_LINES - countLines(suffix) - 1),
		maxBytes: Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8") - 2),
	});
	const content = joinBlocks([truncatedOutput.content, suffix]);

	return { content: [{ type: "text" as const, text: content }], details };
}

export function buildStatusMessage(loaded: LoadedGoogleGenaiConfig, authSource: string) {
	const { config, path, warnings } = loaded;
	return [
		"Google GenAI config:",
		`path: ${path}`,
		`model: ${config.model}`,
		`apiUrl: ${config.apiUrl}`,
		`timeoutMs: ${config.timeoutMs}`,
		`auth: ${authSource}`,
		`tools: ${formatPersistedTools(config.tools)}`,
		...(warnings.length > 0 ? ["warnings:", ...warnings.map((warning) => `- ${warning}`)] : []),
	].join("\n");
}

async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	const action = parseCommand(rawArgs);
	switch (action) {
		case "status":
			await showStatus(ctx);
			return;
		case "init":
			await initConfig(ctx, pi);
			return;
		case "help":
			ctx.ui.notify(helpText(), "info");
			return;
		case "tools":
			await selectTools(ctx, pi);
			return;
		case "enable":
			await saveToolSelection([...GOOGLE_GENAI_TOOL_NAMES]);
			applyGoogleToolSelection(pi, [...GOOGLE_GENAI_TOOL_NAMES]);
			ctx.ui.notify("Enabled all Google GenAI tools.", "info");
			return;
		case "disable":
			await saveToolSelection([]);
			applyGoogleToolSelection(pi, []);
			ctx.ui.notify("Disabled all Google GenAI tools. Use /google-genai enable to restore them.", "info");
			return;
		case "unknown":
			ctx.ui.notify(helpText(), "warning");
			return;
	}
}

async function callInteraction(
	request: { input: string; tool: Record<string, unknown> },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
) {
	const loaded = await loadGoogleGenaiConfig();
	const { config } = loaded;
	assertSafeApiUrl(config.apiUrl);
	const apiKey = await resolveGoogleGenaiAuth(config, ctx);
	const body: InteractionRequest = {
		model: config.model,
		input: request.input,
		tools: [request.tool],
	};
	const timeoutSignal = makeTimeoutSignal(signal, config.timeoutMs);
	try {
		const response = await fetch(config.apiUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": apiKey,
			},
			body: JSON.stringify(body),
			signal: timeoutSignal.signal,
		});
		const responseText = await response.text();
		const payload = parseJsonResponse(responseText);
		if (!response.ok) {
			throw new Error(`Google GenAI request failed (${response.status}): ${errorMessage(payload)}`);
		}
		return formatToolResult(payload, config.model);
	} catch (error) {
		if (timeoutSignal.isTimeout()) {
			throw new Error(`Google GenAI request timed out after ${config.timeoutMs}ms.`);
		}
		throw error;
	} finally {
		timeoutSignal.cleanup();
	}
}

async function initConfig(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	if (!ctx.hasUI) {
		ctx.ui.notify("/google-genai init requires interactive UI. Edit google-genai.json manually or use /login google.", "warning");
		return;
	}
	const loaded = await loadGoogleGenaiConfig();
	const apiKey = await ctx.ui.input(
		"Google GenAI API key (leave blank to keep existing/use /login google/GEMINI_API_KEY):",
	);
	if (apiKey === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}
	const model = await ctx.ui.input("Google GenAI model:", loaded.config.model);
	if (model === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	const next: GoogleGenaiConfig = {
		...loaded.config,
		apiKey: apiKey.trim() || loaded.config.apiKey,
		model: model.trim() || loaded.config.model || DEFAULT_MODEL,
		apiUrl: loaded.config.apiUrl || DEFAULT_API_URL,
		timeoutMs: loaded.config.timeoutMs || DEFAULT_TIMEOUT_MS,
		tools: loaded.config.tools ?? [...GOOGLE_GENAI_TOOL_NAMES],
	};
	await writeGoogleGenaiConfig(next);
	applyGoogleToolSelection(pi, next.tools);
	ctx.ui.notify(`Saved Google GenAI config to ${googleGenaiConfigPath()}.`, "info");
}

async function showStatus(ctx: ExtensionCommandContext) {
	const loaded = await loadGoogleGenaiConfig();
	ctx.ui.notify(buildStatusMessage(loaded, await authSource(loaded.config, ctx)), "info");
}

async function selectTools(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	if (!ctx.hasUI) {
		ctx.ui.notify("/google-genai tools requires interactive UI.", "warning");
		return;
	}

	let selected = new Set(currentGoogleTools(pi));
	while (true) {
		const rows = [
			...GOOGLE_GENAI_TOOL_NAMES.map((toolName) => `${selected.has(toolName) ? "[x]" : "[ ]"} ${toolName}`),
			"Enable all Google GenAI tools",
			"Disable all Google GenAI tools",
			"Done",
		];
		const choice = await ctx.ui.select(
			`Google GenAI tools (${selected.size}/${GOOGLE_GENAI_TOOL_NAMES.length})`,
			rows,
		);
		if (!choice || choice === "Done") return;
		if (choice === "Enable all Google GenAI tools") {
			selected = new Set(GOOGLE_GENAI_TOOL_NAMES);
		} else if (choice === "Disable all Google GenAI tools") {
			selected = new Set();
		} else {
			const toolName = GOOGLE_GENAI_TOOL_NAMES.find((name) => choice.endsWith(name));
			if (!toolName) continue;
			if (selected.has(toolName)) selected.delete(toolName);
			else selected.add(toolName);
		}
		const ordered = orderedGoogleTools(selected);
		applyGoogleToolSelection(pi, ordered);
		await saveToolSelection(ordered);
	}
}

function authSource(config: GoogleGenaiConfig, ctx: ExtensionCommandContext) {
	if (config.apiKey) {
		return isUnsupportedConfigApiKey(config.apiKey)
			? "invalid config apiKey (interpolation unsupported)"
			: "config apiKey";
	}
	const status = ctx.modelRegistry.getProviderAuthStatus("google");
	if (status.configured || status.source) {
		return status.label ? `Pi auth/google (${status.label})` : "Pi auth/google";
	}
	return "missing";
}

async function saveToolSelection(tools: GoogleGenaiToolName[]) {
	const loaded = await loadGoogleGenaiConfig();
	await writeGoogleGenaiConfig({ ...loaded.config, tools });
}

function applyGoogleToolSelection(pi: ExtensionAPI, selectedTools: readonly GoogleGenaiToolName[]) {
	const active = pi.getActiveTools();
	const nonGoogle = active.filter((toolName) => !isGoogleGenaiToolName(toolName));
	pi.setActiveTools([...nonGoogle, ...selectedTools]);
}

function currentGoogleTools(pi: ExtensionAPI) {
	const active = new Set(pi.getActiveTools());
	return GOOGLE_GENAI_TOOL_NAMES.filter((toolName) => active.has(toolName));
}

function orderedGoogleTools(tools: Set<GoogleGenaiToolName>) {
	return GOOGLE_GENAI_TOOL_NAMES.filter((toolName) => tools.has(toolName));
}

function isUnsupportedConfigApiKey(apiKey: string) {
	return apiKey.startsWith("$") || apiKey.startsWith("!");
}

function assertSafeApiUrl(apiUrl: string) {
	let parsed: URL;
	try {
		parsed = new URL(apiUrl);
	} catch {
		throw new Error(`Google GenAI apiUrl must be a valid URL: ${apiUrl}`);
	}
	const localHttp =
		parsed.protocol === "http:" &&
		["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
	if (parsed.protocol !== "https:" && !localHttp) {
		throw new Error(
			`Google GenAI apiUrl must use https:// to protect the API key (http://localhost is allowed for local proxies): ${apiUrl}`,
		);
	}
}

function normalizeConfigWithWarnings(value: unknown): { config: GoogleGenaiConfig; warnings: string[] } {
	const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const raw = input as Record<string, unknown>;
	const warnings: string[] = [];
	const tools = normalizeTools(raw.tools, warnings);
	const config: GoogleGenaiConfig = {
		model: normalizeString(raw.model) ?? DEFAULT_MODEL,
		apiUrl: normalizeApiUrl(raw.apiUrl) ?? DEFAULT_API_URL,
		timeoutMs: normalizeTimeout(raw.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
		tools,
	};
	const apiKey = normalizeString(raw.apiKey);
	if (apiKey) config.apiKey = apiKey;
	return { config, warnings };
}

function normalizeTools(value: unknown, warnings: string[]) {
	if (value === undefined) return [...GOOGLE_GENAI_TOOL_NAMES];
	if (!Array.isArray(value)) {
		warnings.push("google-genai.json tools must be an array; defaulting to all tools enabled.");
		return [...GOOGLE_GENAI_TOOL_NAMES];
	}
	const selected: GoogleGenaiToolName[] = [];
	const unknown: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		if (isGoogleGenaiToolName(item)) {
			if (!selected.includes(item)) selected.push(item);
		} else {
			unknown.push(item);
		}
	}
	if (unknown.length > 0) {
		warnings.push(`Ignoring unknown Google GenAI tool name(s): ${unknown.join(", ")}.`);
	}
	return GOOGLE_GENAI_TOOL_NAMES.filter((toolName) => selected.includes(toolName));
}

function normalizeString(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeApiUrl(value: unknown) {
	const url = normalizeString(value);
	if (!url) return undefined;
	return url.replace(/\/+$/, "");
}

function normalizeTimeout(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readJsonIfExists(path: string, warnings: string[]) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		warnings.push(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

async function writeGoogleGenaiConfig(config: GoogleGenaiConfig) {
	const path = googleGenaiConfigPath();
	await mkdir(dirname(path), { recursive: true });
	const tempFile = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempFile, `${JSON.stringify(cleanObject(config), null, "\t")}\n`, { mode: 0o600 });
		await chmod(tempFile, 0o600);
		await rename(tempFile, path);
		await chmod(path, 0o600);
	} catch (error) {
		await rm(tempFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function ensureConfigPermissions(path: string, warnings: string[]) {
	try {
		const current = await stat(path);
		if ((current.mode & 0o777) !== 0o600) await chmod(path, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		warnings.push(`Failed to enforce 0600 permissions for ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function cleanObject<T>(value: T): T {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) result[key] = item;
	}
	return result as T;
}

function splitArgs(rawArgs: string) {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function formatPersistedTools(tools: readonly GoogleGenaiToolName[]) {
	if (tools.length === GOOGLE_GENAI_TOOL_NAMES.length) return "all enabled";
	if (tools.length === 0) return "all disabled";
	return `${tools.length}/${GOOGLE_GENAI_TOOL_NAMES.length} selected: ${tools.join(", ")}`;
}

function isGoogleGenaiToolName(value: string): value is GoogleGenaiToolName {
	return GOOGLE_GENAI_TOOL_NAMES.includes(value as GoogleGenaiToolName);
}

function makeTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): FetchSignal {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromParent = () => controller.abort(signal?.reason);
	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromParent);
		},
		isTimeout: () => timedOut,
	};
}

function parseJsonResponse(text: string) {
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return { message: text, output_text: text };
	}
}

function errorMessage(payload: unknown) {
	if (payload && typeof payload === "object") {
		const error = (payload as { error?: { message?: unknown }; message?: unknown }).error;
		if (typeof error?.message === "string") return error.message;
		const message = (payload as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function extractOutputText(raw: unknown): string {
	if (!raw || typeof raw !== "object") return "";
	const object = raw as { output_text?: unknown; outputText?: unknown; steps?: unknown };
	if (typeof object.output_text === "string") return object.output_text;
	if (typeof object.outputText === "string") return object.outputText;
	const lines: string[] = [];
	for (const step of asArray(object.steps)) {
		if (!isObject(step) || step.type !== "model_output") continue;
		for (const block of asArray(step.content)) {
			if (isObject(block) && block.type === "text" && typeof block.text === "string") {
				lines.push(block.text);
			}
		}
	}
	return lines.join("\n");
}

function extractSources(raw: unknown): GoogleGenaiSource[] {
	const sources: GoogleGenaiSource[] = [];
	if (!raw || typeof raw !== "object") return sources;
	const steps = asArray((raw as { steps?: unknown }).steps);

	for (const step of steps) {
		if (!isObject(step)) continue;
		if (step.type === "model_output") {
			for (const block of asArray(step.content)) {
				if (!isObject(block)) continue;
				for (const annotation of asArray(block.annotations)) addAnnotationSource(sources, annotation);
			}
		} else if (step.type === "google_maps_result") {
			for (const result of asArray(step.result)) {
				if (!isObject(result)) continue;
				for (const place of asArray(result.places)) {
					if (!isObject(place)) continue;
					addSource(sources, {
						type: "place",
						name: stringValue(place.name),
						url: stringValue(place.url),
						placeId: stringValue(place.place_id),
					});
				}
			}
		} else if (step.type === "url_context_result") {
			for (const result of asArray(step.result)) {
				if (!isObject(result)) continue;
				addSource(sources, {
					type: "url_context",
					url: stringValue(result.url),
					status: stringValue(result.status),
				});
			}
		}
	}
	return sources;
}

function addAnnotationSource(sources: GoogleGenaiSource[], annotation: unknown) {
	if (!isObject(annotation) || typeof annotation.type !== "string") return;
	if (annotation.type === "url_citation") {
		addSource(sources, {
			type: "url",
			title: stringValue(annotation.title),
			url: stringValue(annotation.url),
		});
	} else if (annotation.type === "place_citation") {
		addSource(sources, {
			type: "place",
			name: stringValue(annotation.name),
			url: stringValue(annotation.url),
			placeId: stringValue(annotation.place_id),
		});
	} else if (annotation.type === "file_citation") {
		addSource(sources, {
			type: "file",
			title: stringValue(annotation.file_name),
			url: stringValue(annotation.document_uri),
		});
	}
}

function addSource(sources: GoogleGenaiSource[], source: GoogleGenaiSource) {
	if (!source.url && !source.name && !source.title) return;
	const key = `${source.type}\0${source.url ?? ""}\0${source.name ?? ""}\0${source.title ?? ""}`;
	if (sources.some((existing) => `${existing.type}\0${existing.url ?? ""}\0${existing.name ?? ""}\0${existing.title ?? ""}` === key)) return;
	sources.push(source);
}

function extractToolSteps(raw: unknown) {
	if (!raw || typeof raw !== "object") return [];
	return asArray((raw as { steps?: unknown }).steps)
		.filter((step) => isObject(step) && step.type !== "model_output")
		.map((step) => cleanObject(step));
}

function formatContent(outputText: string, sources: GoogleGenaiSource[]) {
	return joinBlocks([outputText, sources.length > 0 ? formatSourcesSection(sources) : ""]);
}

function formatSourcesSection(sources: GoogleGenaiSource[]) {
	const visibleSources = sources.slice(0, SOURCE_LIMIT);
	return [
		"Sources:",
		...visibleSources.map((source, index) =>
			truncateLine(`${index + 1}. ${formatSource(source)}`).text,
		),
	].join("\n");
}

function joinBlocks(blocks: string[]) {
	return blocks.filter(Boolean).join("\n\n");
}

function countLines(content: string) {
	if (!content) return 0;
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines.length;
}

function formatSource(source: GoogleGenaiSource) {
	const label = source.title ?? source.name ?? source.url ?? source.type;
	const url = source.url && source.url !== label ? ` — ${source.url}` : "";
	const status = source.status ? ` (${source.status})` : "";
	return `${label}${url}${status}`;
}

async function writeRawResponse(raw: unknown) {
	const directory = await rawResponseDirectory();
	const path = join(directory, `interaction-${Date.now()}-${randomUUID()}.json`);
	await writeFile(path, `${JSON.stringify(raw, null, "\t")}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return path;
}

function rawResponseDirectory() {
	rawResponseDirectoryPromise ??= mkdtemp(join(tmpdir(), "pi-google-genai-"))
		.then(async (directory) => {
			await chmod(directory, 0o700);
			return directory;
		})
		.catch((error) => {
			rawResponseDirectoryPromise = undefined;
			throw error;
		});
	return rawResponseDirectoryPromise;
}

async function cleanupRawResponseDirectory() {
	const directoryPromise = rawResponseDirectoryPromise;
	rawResponseDirectoryPromise = undefined;
	if (!directoryPromise) return;
	try {
		await rm(await directoryPromise, { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup; avoid making session shutdown fail.
	}
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
	return typeof value === "string" && value ? value : undefined;
}

async function withStatus<T>(ctx: ExtensionContext, status: string, fn: () => Promise<T>) {
	ctx.ui.setStatus(STATUS_KEY, status);
	try {
		return await fn();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function helpText() {
	return [
		"Google GenAI commands:",
		"/google-genai init - create or update config",
		"/google-genai status|config - show config and auth status",
		"/google-genai tools - select enabled Google GenAI tools",
		"/google-genai enable - enable all Google GenAI tools",
		"/google-genai disable - disable all Google GenAI tools",
		"Auth: config apiKey, /login google, or GEMINI_API_KEY.",
	].join("\n");
}
