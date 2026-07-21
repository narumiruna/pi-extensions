import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, fingerprintResolvedAuth, redactUsageError } from "./core.js";
import { normalizeCodexBackendPayload } from "./providers/codex.js";
import { normalizeOpenRouterKeyPayload } from "./providers/openrouter.js";
import type {
	CodexBackendPayload,
	OpenRouterKeyPayload,
	PiModel,
	ResolvedUsageAuth,
	UsageProviderAdapter,
	UsageReport,
} from "./types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export const AUTH_FINGERPRINT_SALT = randomBytes(32);

export const SUPPORTED_ADAPTERS: readonly UsageProviderAdapter[] = [
	{
		id: "openai-codex",
		displayName: "OpenAI Codex",
		semantics: {
			kind: "consumer-subscription",
			label: "ChatGPT subscription limits",
		},
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				CODEX_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"Codex usage endpoint",
			);
			return normalizeCodexBackendPayload(payload as CodexBackendPayload, Date.now());
		},
	},
	{
		id: "openrouter",
		displayName: "OpenRouter",
		semantics: { kind: "api-key", label: "API-key spend limits" },
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				OPENROUTER_KEY_URL,
				auth,
				signal,
				timeoutMs,
				"OpenRouter key endpoint",
			);
			return normalizeOpenRouterKeyPayload(payload as OpenRouterKeyPayload, Date.now());
		},
	},
];

export function adapterForProvider(
	providerId: string | undefined,
): UsageProviderAdapter | undefined {
	return SUPPORTED_ADAPTERS.find((adapter) => adapter.id === providerId);
}

export function isStaleExtensionContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

export async function resolveUsageAuth(
	ctx: ExtensionContext,
	adapter: UsageProviderAdapter,
	salt: Uint8Array = AUTH_FINGERPRINT_SALT,
): Promise<ResolvedUsageAuth | undefined> {
	if (ctx.model?.provider === adapter.id && !hasOfficialOrigin(ctx.model, adapter.id)) {
		throw new Error(
			`${adapter.displayName} usage cannot send a custom provider base URL credential to the official usage endpoint.`,
		);
	}

	const model = candidateModels(ctx, adapter.id).find((candidate) =>
		hasOfficialOrigin(candidate, adapter.id),
	);
	if (!model) return undefined;
	const registry = ctx.modelRegistry as unknown as ProviderAuthRegistry;
	if (typeof registry.getProviderAuth !== "function") {
		throw new Error("pi-usage requires Pi 0.81.0 or newer to validate resolved provider auth.");
	}
	const result = await registry.getProviderAuth(adapter.id);
	if (!result) return undefined;
	if (result.auth.baseUrl && !hasOfficialUrlOrigin(result.auth.baseUrl, adapter.id)) {
		throw new Error(
			`${adapter.displayName} usage cannot send a proxy-resolved credential to the official usage endpoint.`,
		);
	}
	const resolvedAuthorization = headerValue(result.auth.headers, "Authorization");
	const authorization =
		resolvedAuthorization ?? (result.auth.apiKey ? `Bearer ${result.auth.apiKey}` : undefined);
	if (!authorization) return undefined;
	const headers = { Authorization: authorization };
	const secrets = [result.auth.apiKey, resolvedAuthorization, authorization].filter(
		(value): value is string => Boolean(value),
	);
	return {
		apiKey: result.auth.apiKey,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets,
		model,
	};
}

export async function queryProviderUsage(
	adapter: UsageProviderAdapter,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<UsageReport> {
	try {
		return await adapter.query(auth, signal, timeoutMs);
	} catch (error) {
		if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
		throw new Error(redactUsageError(errorMessage(error), auth.secrets));
	}
}

export function providerIsConfigured(ctx: ExtensionContext, providerId: string): boolean {
	try {
		return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
	} catch {
		return candidateModels(ctx, providerId).length > 0;
	}
}

function candidateModels(ctx: ExtensionContext, providerId: string): PiModel[] {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || model.provider !== providerId) return;
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

async function fetchProviderJson(
	url: string,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
	description: string,
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const headers = { ...auth.headers };
		if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-usage";
		const response = await fetch(url, { headers, signal: controller.signal });
		if (controller.signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		const text = await readBoundedResponse(
			response,
			response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
			!response.ok,
			description,
		);
		if (controller.signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		if (!response.ok) {
			throw new Error(
				`${description} returned ${response.status} ${response.statusText}: ${redactUsageError(text, auth.secrets)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch (error) {
			throw new Error(`${description} returned invalid JSON: ${errorMessage(error)}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${description} response was not an object.`);
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (timedOut) {
			throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
		}
		if (signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortFromCaller);
	}
}

async function readBoundedResponse(
	response: Response,
	maxBytes: number,
	truncateOverflow: boolean,
	description: string,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (truncated && !truncateOverflow) {
		throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(body);
	return truncated ? `${text}…` : text;
}

type ProviderAuthRegistry = {
	getProviderAuth?(providerId: string): Promise<
		| {
				auth: {
					apiKey?: string;
					headers?: Record<string, string | null>;
					baseUrl?: string;
				};
		  }
		| undefined
	>;
};

function hasOfficialOrigin(model: PiModel, providerId: string): boolean {
	return hasOfficialUrlOrigin(model.baseUrl, providerId);
}

function hasOfficialUrlOrigin(value: string, providerId: string): boolean {
	const expected = providerId === "openai-codex" ? "https://chatgpt.com" : "https://openrouter.ai";
	try {
		return new URL(value).origin === expected;
	} catch {
		return false;
	}
}

function headerValue(
	headers: Record<string, string | null> | undefined,
	name: string,
): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
	);
	return entry?.[1] ?? undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
