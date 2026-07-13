import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	assertSafeApiUrl,
	loadGoogleGenaiConfig,
	resolveGoogleGenaiAuth,
} from "./config.js";
import { formatToolResult } from "./response-format.js";

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

export async function callInteraction(
	request: { input: string; tool: Record<string, unknown>; timeoutMs?: number; timeoutAdvice?: string },
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
	const timeoutMs = request.timeoutMs ?? config.timeoutMs;
	const timeoutSignal = makeTimeoutSignal(signal, timeoutMs);
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
			throw new Error(formatTimeoutError(timeoutMs, request.timeoutAdvice));
		}
		throw error;
	} finally {
		timeoutSignal.cleanup();
	}
}

function formatTimeoutError(timeoutMs: number, timeoutAdvice?: string) {
	return [
		`Google GenAI request timed out after ${timeoutMs}ms.`,
		"This is a timeout, not a no-results response.",
		timeoutAdvice ?? "Try narrowing the query or splitting broad comparison/review queries.",
		"To allow longer calls, set pi-google-genai.json timeoutMs or the per-call timeoutMs parameter.",
	].join(" ");
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
