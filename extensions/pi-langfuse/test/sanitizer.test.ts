import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CAPTURE_BYTES, sanitizeTraceValue } from "../src/tracing.js";
import { serializedBytes } from "./support.js";

test("sanitizeTraceValue globally bounds adversarial values in UTF-8 bytes", () => {
	const shared = { text: "repeated" };
	const circular: Record<string, unknown> = { label: "cycle" };
	circular.self = circular;
	const value = {
		manyKeys: Object.fromEntries(
			Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, "🪢".repeat(100)]),
		),
		nested: Array.from({ length: 300 }, () => ["界".repeat(1_000)]),
		sharedA: shared,
		sharedB: shared,
		circular,
	};

	const sanitized = sanitizeTraceValue(value);
	assert.ok(serializedBytes(sanitized) <= MAX_CAPTURE_BYTES);
	assert.match(JSON.stringify(sanitized), /truncated|omitted|circular/i);
	assert.deepEqual(sanitizeTraceValue({ first: shared, second: shared }), {
		first: { text: "repeated" },
		second: { text: "repeated" },
	});
	assert.match(JSON.stringify(sanitizeTraceValue(circular)), /circular/i);
	assert.deepEqual(
		sanitizeTraceValue({
			imageUrl: "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==",
			parameterizedImageUrl: "data:image/svg+xml;charset=utf-8;base64,cHJpdmF0ZS1pbWFnZQ==",
			embeddedDataUri:
				"example: data:application/octet-stream;base64,not-valid%%% should not be parsed",
		}),
		{
			imageUrl: "[base64 data URI omitted]",
			parameterizedImageUrl: "[base64 data URI omitted]",
			embeddedDataUri: "example: [base64 data URI omitted] should not be parsed",
		},
	);
});

test("sanitizeTraceValue bounds string work before redaction and UTF-8 sizing", () => {
	const originalByteLength = Buffer.byteLength;
	const originalReplace = RegExp.prototype[Symbol.replace];
	Buffer.byteLength = ((value: unknown, encoding?: BufferEncoding) => {
		if (typeof value === "string") {
			assert.ok(
				value.length <= MAX_CAPTURE_BYTES,
				"sanitizer scanned the complete oversized string",
			);
		}
		return Reflect.apply(originalByteLength, Buffer, [value, encoding]) as number;
	}) as typeof Buffer.byteLength;
	RegExp.prototype[Symbol.replace] = function (this: RegExp, value: string, replacement: unknown) {
		assert.ok(
			value.length <= MAX_CAPTURE_BYTES,
			"sanitizer redacted the complete oversized string",
		);
		return Reflect.apply(originalReplace, this, [value, replacement]) as string;
	} as (typeof RegExp.prototype)[typeof Symbol.replace];

	try {
		const sanitized = sanitizeTraceValue(
			`data:text/plain;base64,${"a".repeat(MAX_CAPTURE_BYTES * 4)}`,
		);
		assert.match(String(sanitized), /base64 data URI omitted|truncated/i);
	} finally {
		Buffer.byteLength = originalByteLength;
		RegExp.prototype[Symbol.replace] = originalReplace;
	}
});

test("sanitizeTraceValue stops enumerating object properties at the collection cap", () => {
	const value = Object.fromEntries(
		Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, `value-${index}`]),
	);
	const originalKeys = Object.keys;
	Object.keys = ((target: object) => {
		assert.notEqual(target, value, "sanitizer materialized every source key");
		return originalKeys(target);
	}) as typeof Object.keys;

	try {
		const sanitized = sanitizeTraceValue(value);
		assert.match(JSON.stringify(sanitized), /object entries omitted/i);
	} finally {
		Object.keys = originalKeys;
	}
});

test("sanitizeTraceValue bounds inherited enumerable property scans", () => {
	const prototype = Object.fromEntries(
		Array.from({ length: 1_000 }, (_, index) => [`inherited-${index}`, `value-${index}`]),
	);
	const value = Object.create(prototype) as Record<string, unknown>;
	const originalHasOwn = Object.hasOwn;
	let propertyChecks = 0;
	Object.hasOwn = ((target: object, key: PropertyKey) => {
		if (target === value) {
			propertyChecks += 1;
			assert.ok(propertyChecks <= 200, "sanitizer scanned beyond inherited property limits");
		}
		return originalHasOwn(target, key);
	}) as typeof Object.hasOwn;

	try {
		assert.deepEqual(sanitizeTraceValue(value), {
			$truncated: "additional object entries omitted",
		});
	} finally {
		Object.hasOwn = originalHasOwn;
	}
});

test("sanitizeTraceValue omits object keys larger than the remaining budget", () => {
	const oversizedKey = "k".repeat(MAX_CAPTURE_BYTES * 4);
	const sanitized = sanitizeTraceValue({ [oversizedKey]: "secret" });

	assert.deepEqual(sanitized, { $truncated: "additional object entries omitted" });
	assert.ok(serializedBytes(sanitized) <= MAX_CAPTURE_BYTES);
});

test("sanitizeTraceValue strips opaque Pi continuation signatures at every depth", () => {
	assert.deepEqual(
		sanitizeTraceValue({
			text: "ordinary content",
			textSignature: "opaque-text",
			nested: {
				thinking: "ordinary thinking",
				thinkingSignature: "opaque-thinking",
				tool: { name: "read", thoughtSignature: "opaque-tool" },
			},
		}),
		{
			text: "ordinary content",
			nested: {
				thinking: "ordinary thinking",
				tool: { name: "read" },
			},
		},
	);
});

test("sanitizeTraceValue contains malformed object values", () => {
	const invalidDate = new Date(Number.NaN);
	const value = {
		before: "kept",
		invalidDate,
		get inaccessible() {
			throw new Error("getter failed");
		},
		source: {
			type: "base64",
			mediaType: "image/png",
			get data() {
				throw new Error("base64 getter failed");
			},
		},
		after: "also kept",
	};

	assert.deepEqual(sanitizeTraceValue(value), {
		before: "kept",
		invalidDate: "[invalid date]",
		inaccessible: "[unreadable property]",
		source: { type: "base64", mediaType: "image/png", data: "[base64 omitted]" },
		after: "also kept",
	});
});
