export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
export const DEFAULT_MAX_CONTEXT_BYTES = 50 * 1024;
export const DEFAULT_MAX_MESSAGES = 200;
export const TRUNCATION_MARKER = "\n… [truncated by pi-subagents]";
export const TAIL_TRUNCATION_MARKER = "… [truncated by pi-subagents]\n";

export interface BoundedText {
	text: string;
	truncated: boolean;
	originalBytes: number;
}

function normalizeByteLimit(maxBytes: number): number {
	if (maxBytes === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
	if (!Number.isFinite(maxBytes)) return 0;
	return Math.max(0, Math.floor(maxBytes));
}

export function truncateUtf8(text: string, maxBytes: number): BoundedText {
	const limit = normalizeByteLimit(maxBytes);
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (originalBytes <= limit) return { text, truncated: false, originalBytes };
	if (limit === 0) return { text: "", truncated: true, originalBytes };

	const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
	if (marker.length >= limit) {
		return {
			text: Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/�+$/g, ""),
			truncated: true,
			originalBytes,
		};
	}
	const prefix = Buffer.from(text, "utf8").subarray(0, limit - marker.length).toString("utf8").replace(/�+$/g, "");
	return { text: `${prefix}${TRUNCATION_MARKER}`, truncated: true, originalBytes };
}

export function truncateUtf8Tail(text: string, maxBytes: number): BoundedText {
	const limit = normalizeByteLimit(maxBytes);
	const bytes = Buffer.from(text, "utf8");
	const originalBytes = bytes.length;
	if (originalBytes <= limit) return { text, truncated: false, originalBytes };
	if (limit === 0) return { text: "", truncated: true, originalBytes };

	const marker = Buffer.from(TAIL_TRUNCATION_MARKER, "utf8");
	if (marker.length >= limit) {
		return {
			text: bytes.subarray(originalBytes - limit).toString("utf8").replace(/^�+/g, ""),
			truncated: true,
			originalBytes,
		};
	}
	const suffix = bytes
		.subarray(originalBytes - (limit - marker.length))
		.toString("utf8")
		.replace(/^�+/g, "");
	return { text: `${TAIL_TRUNCATION_MARKER}${suffix}`, truncated: true, originalBytes };
}

export function appendBounded(current: string, addition: string, maxBytes: number): BoundedText {
	return truncateUtf8(current + addition, maxBytes);
}
