import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queryViaCodexAppServer } from "./app-server-client.js";
import { normalizeBackendPayload } from "./normalize.js";
import type {
	CodexUsageReport,
	PiModel,
	QueryUsageOptions,
	QueryUsageResult,
	RateLimitStatusPayload,
	UsageQueryError,
} from "./types.js";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_ERROR_BODY_CHARS = 600;

export function isOpenAICodexModel(model: Pick<PiModel, "provider"> | undefined): boolean {
	return model?.provider === CODEX_PROVIDER_ID;
}

export function isStaleExtensionContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

export async function queryUsage(
	ctx: ExtensionContext,
	options: Pick<QueryUsageOptions, "timeoutMs">,
): Promise<QueryUsageResult> {
	const errors: UsageQueryError[] = [];

	try {
		const report = await queryViaPiAuth(ctx, options.timeoutMs);
		return { ok: true, report };
	} catch (cause) {
		if (isStaleExtensionContextError(cause)) throw cause;
		errors.push({ source: "pi-auth", message: errorMessage(cause), cause });
	}

	try {
		const report = await queryViaCodexAppServer(options.timeoutMs);
		return { ok: true, report };
	} catch (cause) {
		if (isStaleExtensionContextError(cause)) throw cause;
		errors.push({ source: "codex-app-server", message: errorMessage(cause), cause });
	}

	return { ok: false, errors };
}

async function queryViaPiAuth(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<CodexUsageReport> {
	const auth = await resolvePiCodexAuth(ctx);
	if (!auth) {
		throw new Error(
			"No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
		);
	}

	const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers: auth.headers }, timeoutMs);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
		);
	}

	const payload = parseJsonObject(text, "Codex usage endpoint response");
	return normalizeBackendPayload(payload as RateLimitStatusPayload, Date.now(), "pi-auth");
}

async function resolvePiCodexAuth(
	ctx: ExtensionContext,
): Promise<{ headers: Record<string, string> } | undefined> {
	const models = codexAuthCandidateModels(ctx);
	const errors: string[] = [];

	for (const model of models) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			errors.push(auth.error);
			continue;
		}

		const headers = { ...(auth.headers ?? {}) };
		if (!hasHeader(headers, "Authorization") && auth.apiKey) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
		if (!hasHeader(headers, "User-Agent")) {
			headers["User-Agent"] = "pi-codex-usage";
		}
		if (hasHeader(headers, "Authorization")) {
			return { headers };
		}
	}

	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
	return undefined;
}

function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || model.provider !== CODEX_PROVIDER_ID) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};

	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model);
	for (const model of ctx.modelRegistry.getAll()) add(model);
	return candidates;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(
				`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage.`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function parseJsonObject(text: string, description: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${description} was not valid JSON: ${errorMessage(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${description} was not an object.`);
	}
	return parsed as Record<string, unknown>;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function redactErrorBody(body: string): string {
	return truncateEnd(
		body
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
			.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
			.trim(),
		MAX_ERROR_BODY_CHARS,
	);
}

function truncateEnd(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
