const API_BASE_URL = "https://api.telegra.ph";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ERROR_DETAIL_BYTES = 8 * 1024;
const ERROR_TRUNCATION_SUFFIX = "\n[Remote error detail truncated]";

type TelegraphMethod = "createAccount" | "createPage" | "getPage" | "editPage";
type FormValue = string | number | boolean | undefined;

export async function telegraphRequest(
	method: TelegraphMethod,
	path: string | undefined,
	parameters: Record<string, FormValue>,
	signal?: AbortSignal,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error("Telegraph request timeout must be a positive integer.");
	}
	if (signal?.aborted) throw abortReason(signal);

	const url = `${API_BASE_URL}/${method}${path ? `/${encodeURIComponent(path)}` : ""}`;
	const body = new URLSearchParams();
	for (const [name, value] of Object.entries(parameters)) {
		if (value !== undefined) body.set(name, String(value));
	}
	const secrets = [parameters.access_token].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	const controller = new AbortController();
	const timeoutError = new Error(`Telegraph ${method} request timed out after ${timeoutMs}ms.`);
	const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
	timeout.unref?.();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) signal.addEventListener("abort", onAbort, { once: true });

	try {
		let response: Response;
		let responseText: string;
		let phase: "request" | "response read" = "request";
		try {
			response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
				body: body.toString(),
				signal: controller.signal,
			});
			phase = "response read";
			responseText = await response.text();
		} catch (error) {
			if (signal?.aborted) throw abortReason(signal);
			if (controller.signal.reason === timeoutError) throw timeoutError;
			throw new Error(
				`Telegraph ${method} ${phase} failed: ${formatRemoteDetail(formatError(error), secrets)}`,
			);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(responseText) as unknown;
		} catch {
			throw new Error(
				`Telegraph ${method} returned invalid JSON (${response.status}): ${formatRemoteDetail(responseText, secrets)}`,
			);
		}
		if (!isPlainObject(payload) || typeof payload.ok !== "boolean") {
			throw new Error(`Telegraph ${method} returned a malformed response envelope.`);
		}
		if (!response.ok || !payload.ok) {
			const detail = typeof payload.error === "string" ? payload.error : response.statusText;
			throw new Error(
				`Telegraph ${method} failed (${response.status}): ${formatRemoteDetail(detail || "unknown error", secrets)}`,
			);
		}
		if (!Object.hasOwn(payload, "result")) {
			throw new Error(`Telegraph ${method} returned no result.`);
		}
		return payload.result;
	} finally {
		clearTimeout(timeout);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

export function redactSecrets(value: string, secrets: readonly string[]) {
	let redacted = value;
	for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
		if (secret) redacted = redacted.split(secret).join("[REDACTED]");
	}
	return redacted;
}

function formatRemoteDetail(value: string, secrets: readonly string[]) {
	return truncateUtf8(redactSecrets(value, secrets), MAX_ERROR_DETAIL_BYTES);
}

function truncateUtf8(value: string, maxBytes: number) {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	const contentBudget = maxBytes - Buffer.byteLength(ERROR_TRUNCATION_SUFFIX);
	let bytes = 0;
	let output = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > contentBudget) break;
		output += character;
		bytes += characterBytes;
	}
	return `${output}${ERROR_TRUNCATION_SUFFIX}`;
}

function abortReason(signal: AbortSignal) {
	return signal.reason instanceof Error ? signal.reason : new Error("Telegraph request aborted.");
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
