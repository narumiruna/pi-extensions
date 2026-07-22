export const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 50_000;
const MAX_COLLECTION_LENGTH = 200;
const MAX_DEPTH = 12;
const TRUNCATED = "[truncated: content budget exceeded]";
const BASE64_DATA_URI = /data:[^,\s"'`]*;base64,[^\s"'`]*/gi;
const BASE64_DATA_URI_OMITTED = "[base64 data URI omitted]";
const OPAQUE_SIGNATURE_KEYS = new Set(["thinkingSignature", "textSignature", "thoughtSignature"]);

export function sanitizeTraceValue(value: unknown): unknown {
	const budget = { remaining: MAX_CAPTURE_BYTES };
	const sanitized = sanitize(value, new WeakSet<object>(), 0, budget);
	return serializedBytes(sanitized) <= MAX_CAPTURE_BYTES ? sanitized : TRUNCATED;
}

function sanitize(
	value: unknown,
	active: WeakSet<object>,
	depth: number,
	budget: { remaining: number },
): unknown {
	if (budget.remaining <= byteLength(TRUNCATED)) return TRUNCATED;
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return consume(value, budget);
	}
	if (typeof value === "string") {
		const bounded = truncateString(value, Math.min(MAX_STRING_LENGTH, budget.remaining));
		const redacted = bounded.replace(BASE64_DATA_URI, BASE64_DATA_URI_OMITTED);
		return consume(redacted, budget);
	}
	if (typeof value === "bigint") return consume(value.toString(), budget);
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		return undefined;
	}
	if (value instanceof Date) {
		return consume(Number.isNaN(value.getTime()) ? "[invalid date]" : value.toISOString(), budget);
	}
	if (value instanceof Error) {
		return sanitize({ name: value.name, message: value.message }, active, depth, budget);
	}
	if (depth >= MAX_DEPTH) return consume("[maximum depth reached]", budget);
	if (active.has(value)) return consume("[circular]", budget);
	active.add(value);

	let result: unknown;
	if (Array.isArray(value)) {
		const items: unknown[] = [];
		for (const item of value.slice(0, MAX_COLLECTION_LENGTH)) {
			if (budget.remaining <= byteLength(TRUNCATED)) break;
			items.push(sanitize(item, active, depth + 1, budget));
		}
		if (items.length < value.length) items.push(`[${value.length - items.length} items omitted]`);
		result = items;
	} else {
		const record = value as Record<string, unknown>;
		const output: Record<string, unknown> = {};
		const objectType = readProperty(record, "type").value;
		const redactData = objectType === "image" || objectType === "base64";
		let visited = 0;
		let processed = 0;
		let omitted = false;
		try {
			for (const key in record) {
				if (visited >= MAX_COLLECTION_LENGTH || budget.remaining <= byteLength(TRUNCATED)) {
					omitted = true;
					break;
				}
				visited += 1;
				if (!Object.hasOwn(record, key) || OPAQUE_SIGNATURE_KEYS.has(key)) continue;
				const keyBudget = Math.min(MAX_STRING_LENGTH, Math.max(0, budget.remaining - 4));
				if (key.length > keyBudget) {
					omitted = true;
					break;
				}
				const keyBytes = byteLength(key);
				if (keyBytes > keyBudget) {
					omitted = true;
					break;
				}
				budget.remaining -= keyBytes + 4;
				const property = readProperty(record, key);
				if (redactData && key === "data") {
					output[key] = consume("[base64 omitted]", budget);
				} else if (!property.ok) output[key] = consume("[unreadable property]", budget);
				else output[key] = sanitize(property.value, active, depth + 1, budget);
				processed += 1;
			}
		} catch {
			if (processed === 0) {
				active.delete(value);
				return consume("[unreadable object]", budget);
			}
			omitted = true;
		}
		if (omitted) output.$truncated = "additional object entries omitted";
		result = output;
	}
	active.delete(value);
	return result;
}

function readProperty(
	record: Record<string, unknown>,
	key: string,
): { ok: true; value: unknown } | { ok: false; value?: undefined } {
	try {
		return { ok: true, value: record[key] };
	} catch {
		return { ok: false };
	}
}

function consume<T>(value: T, budget: { remaining: number }): T | string {
	const size = serializedBytes(value);
	if (size > budget.remaining) {
		budget.remaining -= byteLength(TRUNCATED);
		return TRUNCATED;
	}
	budget.remaining -= size;
	return value;
}

function truncateString(value: string, maxBytes: number): string {
	const boundedPrefix = value.slice(0, maxBytes);
	if (boundedPrefix.length === value.length && byteLength(boundedPrefix) <= maxBytes) {
		return boundedPrefix;
	}
	const suffix = "… [truncated]";
	const target = Math.max(0, maxBytes - byteLength(suffix) - 2);
	let bytes = 0;
	let output = "";
	for (const character of boundedPrefix) {
		const size = byteLength(character);
		if (bytes + size > target) break;
		output += character;
		bytes += size;
	}
	return `${output}${suffix}`;
}

function serializedBytes(value: unknown): number {
	return byteLength(JSON.stringify(value) ?? "null");
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
