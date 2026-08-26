import { randomBytes } from "node:crypto";
import { type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { errorMessage, fingerprintResolvedAuth, redactUsageError } from "./core.js";
import {
	fallbackOAuthCredentialCandidates,
	type OAuthCredentialCandidateReader,
} from "./oauth-credential-source.js";
import { normalizeCodexBackendPayload } from "./providers/codex.js";
import { normalizeGitHubCopilotUsagePayload } from "./providers/github-copilot.js";
import { normalizeOpenCodeZenPayload } from "./providers/opencode-zen.js";
import { normalizeOpenRouterKeyPayload } from "./providers/openrouter.js";
import type {
	CodexBackendPayload,
	GitHubCopilotUsagePayload,
	OpenCodeZenPayload,
	OpenRouterKeyPayload,
	PiModel,
	ResolvedUsageAuth,
	UsageProviderAdapter,
	UsageReport,
} from "./types.js";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GITHUB_COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
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
		id: "github-copilot",
		displayName: "GitHub Copilot",
		semantics: {
			kind: "consumer-subscription",
			label: "GitHub Copilot account allowance",
		},
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				GITHUB_COPILOT_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"GitHub Copilot usage endpoint",
			);
			return normalizeGitHubCopilotUsagePayload(payload as GitHubCopilotUsagePayload, Date.now());
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
	{
		id: "opencode-go",
		displayName: "OpenCode Go",
		semantics: { kind: "consumer-subscription", label: "OpenCode Zen plan usage" },
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				opencodeUsageUrl(auth.model.baseUrl),
				auth,
				signal,
				timeoutMs,
				"OpenCode Zen usage endpoint",
			);
			return normalizeOpenCodeZenPayload(payload as OpenCodeZenPayload, Date.now());
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
	credentialReader: StoredCredentialReader = readStoredCredential,
	candidateReader?: OAuthCredentialCandidateReader,
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
	const registry = ctx.modelRegistry as unknown as UsageAuthRegistry;
	let modelAuth: RequestAuth | undefined;
	if (ctx.model?.provider === adapter.id && typeof registry.getApiKeyAndHeaders === "function") {
		const result = await registry.getApiKeyAndHeaders(ctx.model);
		if (!result.ok) throw new Error(redactUsageError(result.error));
		if (authorizationFrom(result)) modelAuth = result;
	}
	if (typeof registry.getProviderAuth !== "function") {
		throw new Error("pi-usage requires Pi 0.81.0 or newer to validate resolved provider auth.");
	}
	const providerResult = await registry.getProviderAuth(adapter.id);
	if (
		providerResult?.auth.baseUrl &&
		!hasOfficialUrlOrigin(providerResult.auth.baseUrl, adapter.id)
	) {
		throw new Error(
			`${adapter.displayName} usage cannot send a proxy-resolved credential to the official usage endpoint.`,
		);
	}
	const auth = modelAuth ?? providerResult?.auth;
	if (!auth) return undefined;
	if (adapter.id === "github-copilot") {
		const offered = candidateReader
			? candidateReader(ctx, adapter.id)
			: fallbackOAuthCredentialCandidates(adapter.id, credentialReader);
		if (!offered.ok) {
			throw new Error("GitHub Copilot OAuth credential discovery failed closed.");
		}
		return resolveGitHubCopilotUsageAuth(
			auth,
			model,
			salt,
			offered.candidates,
			offered.offeredCount === 0,
		);
	}
	const authorization = authorizationFrom(auth);
	if (!authorization) return undefined;
	const headers = { Authorization: authorization };
	const secrets = [auth.apiKey, headerValue(auth.headers, "Authorization"), authorization].filter(
		(value): value is string => Boolean(value),
	);
	return {
		apiKey: auth.apiKey,
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

export async function fetchProviderJson(
	url: string,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
	description: string,
	request: {
		method?: "GET" | "POST";
		body?: Record<string, unknown>;
	} = {},
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
		if (request.body && !hasHeader(headers, "Content-Type")) {
			headers["Content-Type"] = "application/json";
		}
		const response = await fetch(url, {
			method: request.method ?? "GET",
			headers,
			...(request.body ? { body: JSON.stringify(request.body) } : {}),
			signal: controller.signal,
		});
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

type RequestAuth = {
	apiKey?: string;
	headers?: Record<string, string | null>;
};

type StoredCredentialReader = (providerId: string) => unknown;

type UsageAuthRegistry = {
	getApiKeyAndHeaders?(
		model: PiModel,
	): Promise<({ ok: true } & RequestAuth) | { ok: false; error: string }>;
	getProviderAuth?(providerId: string): Promise<
		| {
				auth: RequestAuth & { baseUrl?: string };
		  }
		| undefined
	>;
};

function resolveGitHubCopilotUsageAuth(
	auth: RequestAuth,
	model: PiModel,
	salt: Uint8Array,
	candidates: readonly unknown[],
	standaloneFallback: boolean,
): ResolvedUsageAuth {
	const resolvedAccess = bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
	if (!resolvedAccess) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
	let sawOAuth = false;
	let sawMatchingAccess = false;
	let sawIncompleteMatch = false;
	let sawEnterpriseMatch = false;
	const matches = new Map<string, { refresh: string; storedAccess: string }>();
	for (const candidate of candidates) {
		try {
			const credential = asObject(candidate);
			if (credential?.type !== "oauth") continue;
			sawOAuth = true;
			const storedAccess =
				typeof credential.access === "string" && credential.access ? credential.access : undefined;
			if (storedAccess !== resolvedAccess) continue;
			sawMatchingAccess = true;
			const enterpriseUrl = credential.enterpriseUrl;
			if (
				typeof enterpriseUrl === "string" &&
				enterpriseUrl &&
				!isPublicGitHubDomain(enterpriseUrl)
			) {
				sawEnterpriseMatch = true;
				continue;
			}
			const refresh =
				typeof credential.refresh === "string" && credential.refresh
					? credential.refresh
					: undefined;
			if (!refresh) {
				sawIncompleteMatch = true;
				continue;
			}
			matches.set(`${storedAccess.length}:${storedAccess}${refresh}`, { refresh, storedAccess });
		} catch {
			// Malformed candidates never authorize a provider request.
		}
	}
	if (sawEnterpriseMatch) {
		throw new Error("GitHub Copilot usage does not yet support GitHub Enterprise accounts.");
	}
	if (sawIncompleteMatch) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
	if (matches.size > 1) {
		throw new Error(
			"Conflicting OAuth credentials match the active GitHub Copilot runtime account.",
		);
	}
	const match = matches.values().next().value;
	if (!match) {
		if (!sawOAuth) {
			throw new Error(
				standaloneFallback
					? "GitHub Copilot usage requires the OAuth account configured through Pi /login."
					: "GitHub Copilot usage requires an OAuth account configured through Pi /login or a compatible credential source.",
			);
		}
		if (sawMatchingAccess) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
		throw new Error(
			standaloneFallback
				? "The active GitHub Copilot runtime account does not match Pi's stored OAuth account."
				: "The active GitHub Copilot runtime account does not match any available OAuth account.",
		);
	}
	const { refresh, storedAccess } = match;
	const authorization = `Bearer ${refresh}`;
	const headers = {
		Authorization: authorization,
		"X-GitHub-Api-Version": "2025-05-01",
	};
	return {
		apiKey: refresh,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets: [refresh, storedAccess, resolvedAccess, authorization],
		model,
	};
}

function authorizationFrom(auth: RequestAuth): string | undefined {
	return (
		headerValue(auth.headers, "Authorization") ??
		(auth.apiKey ? `Bearer ${auth.apiKey}` : undefined)
	);
}

function bearerToken(authorization: string | undefined): string | undefined {
	const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
	return match?.[1];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function isPublicGitHubDomain(value: string): boolean {
	try {
		const url = new URL(value.includes("://") ? value : `https://${value}`);
		return url.hostname.toLowerCase() === "github.com";
	} catch {
		return false;
	}
}

function hasOfficialOrigin(model: PiModel, providerId: string): boolean {
	return hasOfficialUrlOrigin(model.baseUrl, providerId);
}

function hasOfficialUrlOrigin(value: string, providerId: string): boolean {
	try {
		const url = new URL(value);
		if (providerId === "openai-codex") return url.origin === "https://chatgpt.com";
		if (providerId === "openrouter") return url.origin === "https://openrouter.ai";
		if (providerId === "opencode-go") return url.origin === "https://opencode.ai";
		if (providerId === "github-copilot") {
			return (
				url.protocol === "https:" && /^api\.[a-z0-9-]+\.githubcopilot\.com$/u.test(url.hostname)
			);
		}
		return false;
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

function opencodeUsageUrl(baseUrl: string | undefined): string {
	const base = baseUrl?.trim().replace(/\/+$/u, "");
	if (!base) throw new Error("OpenCode Go model base URL is unavailable.");
	return `${base}/usage`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
