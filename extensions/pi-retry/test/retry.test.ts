import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import retry, { parseStallTimeoutMs } from "../src/retry.js";

test("retry registers stall timeout flag and provider lifecycle handlers", () => {
	const mock = createMockPi();
	retry(mock.pi);

	assert.ok(mock.flags.has("retry-stall-timeout-ms"));
	assert.ok(mock.events.has("message_end"));
	assert.ok(mock.events.has("before_provider_request"));
	assert.ok(mock.events.has("session_shutdown"));
});

test("parseStallTimeoutMs accepts disable values and positive finite strings", () => {
	assert.equal(parseStallTimeoutMs(undefined), undefined);
	assert.equal(parseStallTimeoutMs(""), undefined);
	assert.equal(parseStallTimeoutMs("0"), 0);
	assert.equal(parseStallTimeoutMs("off"), 0);
	assert.equal(parseStallTimeoutMs("false"), 0);
	assert.equal(parseStallTimeoutMs("12.8"), 12);
	assert.equal(parseStallTimeoutMs("-1"), undefined);
	assert.equal(parseStallTimeoutMs(100), undefined);
});

test("message_end appends pi retry hint for unknown provider errors once", () => {
	const mock = createMockPi();
	retry(mock.pi);
	const handler = mock.events.get("message_end")?.[0];
	assert.ok(handler);

	const event = {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Unknown error (no error details in response)",
		},
	};
	const result = handler(event, createMockContext({ hasUI: false }).ctx);
	assert.ok(result && typeof result === "object" && "message" in result);
	const retryResult = result as { message: { errorMessage: string } };

	assert.match(retryResult.message.errorMessage, /\[unknown-error-retry\] provider returned error/);
	assert.equal(
		handler({ message: retryResult.message }, createMockContext({ hasUI: false }).ctx),
		undefined,
	);
});

test("message_end appends pi retry hint for Codex websocket connection limits once", () => {
	const mock = createMockPi();
	retry(mock.pi);
	const handler = mock.events.get("message_end")?.[0];
	assert.ok(handler);

	const event = {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage:
				'Codex error: {"type":"error","error":{"code":"websocket_connection_limit_reached","message":"Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue."},"status":400}',
		},
	};
	const result = handler(event, createMockContext({ hasUI: false }).ctx);
	assert.ok(result && typeof result === "object" && "message" in result);
	const retryResult = result as { message: { errorMessage: string } };

	assert.match(
		retryResult.message.errorMessage,
		/\[codex-websocket-limit-retry\] provider returned error/,
	);
	assert.equal(
		handler({ message: retryResult.message }, createMockContext({ hasUI: false }).ctx),
		undefined,
	);
});
