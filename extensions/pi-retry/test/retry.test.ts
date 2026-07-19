import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "../../../test/support.js";
import retry, { parseStallTimeoutMs, readPiRetryPolicy } from "../src/retry.js";

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

function writeSettings(directory: string, settings: unknown) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
}

function createSettingsWorkspace(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-retry-test-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { agentDir, cwd };
}

function createProjectSettingsWorkspace(t: TestContext, settings: unknown) {
	const { cwd } = createSettingsWorkspace(t);
	writeSettings(join(cwd, CONFIG_DIR_NAME), settings);
	return cwd;
}

test("readPiRetryPolicy resolves defaults, global settings, and trusted project overrides", (t) => {
	const { agentDir, cwd } = createSettingsWorkspace(t);
	const context = createMockContext({ cwd, isProjectTrusted: () => false });

	assert.deepEqual(readPiRetryPolicy(context.ctx, agentDir), { enabled: true, errors: [] });

	writeSettings(agentDir, { retry: { enabled: false } });
	assert.deepEqual(readPiRetryPolicy(context.ctx, agentDir), { enabled: false, errors: [] });

	writeSettings(join(cwd, CONFIG_DIR_NAME), { retry: { enabled: true } });
	assert.deepEqual(readPiRetryPolicy(context.ctx, agentDir), { enabled: false, errors: [] });
	const trustedContext = createMockContext({ cwd, isProjectTrusted: () => true });
	assert.deepEqual(readPiRetryPolicy(trustedContext.ctx, agentDir), { enabled: true, errors: [] });

	writeFileSync(join(agentDir, "settings.json"), "{");
	const malformedGlobal = readPiRetryPolicy(context.ctx, agentDir);
	assert.equal(malformedGlobal.enabled, true);
	assert.equal(malformedGlobal.errors.length, 1);
	assert.match(malformedGlobal.errors[0] ?? "", /^global settings:/);

	writeSettings(agentDir, { retry: { enabled: false } });
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "{");
	const malformedProject = readPiRetryPolicy(trustedContext.ctx, agentDir);
	assert.equal(malformedProject.enabled, false);
	assert.equal(malformedProject.errors.length, 1);
	assert.match(malformedProject.errors[0] ?? "", /^project settings:/);
});

test("session_start warns once when Pi agent-level retry is disabled", async (t) => {
	const mock = createMockPi();
	retry(mock.pi);
	const handler = mock.events.get("session_start")?.[0];
	assert.ok(handler);

	const cwd = createProjectSettingsWorkspace(t, { retry: { enabled: false } });
	const context = createMockContext({ cwd, hasUI: true, isProjectTrusted: () => true });
	await handler({}, context.ctx);
	await handler({}, context.ctx);

	assert.deepEqual(context.notifications, [
		{
			message:
				'pi-retry requires Pi setting "retry.enabled": true; retry hints and stall recovery are inactive while it is disabled.',
			level: "warning",
		},
	]);
});

test("disabled Pi retry policy suppresses retry UI for matched errors", async (t) => {
	const mock = createMockPi();
	retry(mock.pi);
	const sessionStart = mock.events.get("session_start")?.[0];
	const messageEnd = mock.events.get("message_end")?.[0];
	assert.ok(sessionStart);
	assert.ok(messageEnd);

	const cwd = createProjectSettingsWorkspace(t, { retry: { enabled: false } });
	const context = createMockContext({ cwd, hasUI: true, isProjectTrusted: () => true });
	await sessionStart({}, context.ctx);
	const result = await messageEnd(
		{
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Unknown error (no error details in response)",
			},
		},
		context.ctx,
	);

	assert.ok(result && typeof result === "object" && "message" in result);
	assert.equal(context.statuses.get("unknown-error-retry"), undefined);
	assert.equal(context.notifications.length, 1);
});

test("disabled Pi retry policy does not abort a stalled provider request", async (t) => {
	const mock = createMockPi();
	let abortCount = 0;
	retry(mock.pi);
	const flag = mock.flags.get("retry-stall-timeout-ms");
	assert.ok(flag);
	flag.value = "5";
	const sessionStart = mock.events.get("session_start")?.[0];
	const beforeProviderRequest = mock.events.get("before_provider_request")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(beforeProviderRequest);
	assert.ok(sessionShutdown);

	const cwd = createProjectSettingsWorkspace(t, { retry: { enabled: false } });
	const context = createMockContext({
		cwd,
		hasUI: true,
		isIdle: () => false,
		isProjectTrusted: () => true,
		abort: () => abortCount++,
	});
	await sessionStart({}, context.ctx);
	await beforeProviderRequest({}, context.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await sessionShutdown({}, context.ctx);

	assert.equal(abortCount, 0);
	assert.equal(context.statuses.get("unknown-error-retry"), undefined);
});

test("before_provider_request refreshes an injected retry policy", async () => {
	const mock = createMockPi();
	let enabled = false;
	let abortCount = 0;
	retry(mock.pi, {
		readRetryPolicy: () => ({ enabled, errors: [] }),
	});
	const flag = mock.flags.get("retry-stall-timeout-ms");
	assert.ok(flag);
	flag.value = "5";
	const sessionStart = mock.events.get("session_start")?.[0];
	const beforeProviderRequest = mock.events.get("before_provider_request")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(beforeProviderRequest);
	assert.ok(sessionShutdown);

	const context = createMockContext({
		hasUI: true,
		isIdle: () => false,
		abort: () => abortCount++,
	});
	await sessionStart({}, context.ctx);
	await beforeProviderRequest({}, context.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(abortCount, 0);

	enabled = true;
	await beforeProviderRequest({}, context.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(abortCount, 1);
	assert.equal(context.statuses.get("unknown-error-retry"), "retrying");
	await sessionShutdown({}, context.ctx);
});

test("retry policy read failures warn once and preserve the last known policy", async () => {
	const mock = createMockPi();
	retry(mock.pi, {
		readRetryPolicy: () => ({ enabled: undefined, errors: ["global settings: invalid JSON"] }),
	});
	const sessionStart = mock.events.get("session_start")?.[0];
	const beforeProviderRequest = mock.events.get("before_provider_request")?.[0];
	const sessionShutdown = mock.events.get("session_shutdown")?.[0];
	assert.ok(sessionStart);
	assert.ok(beforeProviderRequest);
	assert.ok(sessionShutdown);

	const context = createMockContext({ hasUI: true });
	await sessionStart({}, context.ctx);
	await sessionStart({}, context.ctx);
	await beforeProviderRequest({}, context.ctx);
	await sessionShutdown({}, context.ctx);

	assert.deepEqual(context.notifications, [
		{
			message:
				"pi-retry could not read Pi retry settings; preserving the last known policy. global settings: invalid JSON",
			level: "warning",
		},
	]);
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

test("message_end appends pi retry hint for Codex generic retryable errors once", () => {
	const mock = createMockPi();
	retry(mock.pi);
	const handler = mock.events.get("message_end")?.[0];
	assert.ok(handler);

	const result = handler(
		{
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage:
					"Codex error: An error occurred while processing your request. You can retry your request, or contact support if the issue persists.",
			},
		},
		createMockContext({ hasUI: false }).ctx,
	);
	assert.ok(result && typeof result === "object" && "message" in result);
	const retryResult = result as { message: { errorMessage: string } };

	assert.match(retryResult.message.errorMessage, /\[codex-generic-retry\] provider returned error/);
	assert.equal(retryResult.message.errorMessage.match(/provider returned error/g)?.length, 1);
	assert.equal(
		handler({ message: retryResult.message }, createMockContext({ hasUI: false }).ctx),
		undefined,
	);
});
