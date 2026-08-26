import assert from "node:assert/strict";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { chooseS3Credentials } from "../src/s3-credentials-ui.js";
import { promptSecret } from "../src/secret-input.js";

test("masked secret input never renders plaintext and submits pasted text", async () => {
	const secret = "private-password";
	const tui = createTuiHarness({ width: 24 });
	const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const pending = promptSecret(ctx, "WebDAV password");
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.send(`\u001b[200~${secret}\u001b[201~`);
	const rendered = tui.render();
	assert.doesNotMatch(rendered.join("\n"), new RegExp(secret));
	assert.match(rendered.join("\n"), /•+/u);
	assert.equal(rendered.join("\n").includes(CURSOR_MARKER), true);
	for (const line of rendered) assert.ok(visibleWidth(line) <= 24);
	tui.press("tui.input.submit");
	assert.equal(await pending, secret);
});

test("stored S3 credential setup aborts with its owning session", async () => {
	const controller = new AbortController();
	let resolveInput: ((value: string) => void) | undefined;
	let customCalls = 0;
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => "Store credentials privately",
		input: async () =>
			await new Promise<string>((resolve) => {
				resolveInput = resolve;
			}),
		custom: async () => {
			customCalls += 1;
			return "secret";
		},
	});
	const setup = chooseS3Credentials(ctx, controller.signal);
	while (!resolveInput) await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new DOMException("Session replaced", "AbortError"));
	resolveInput("access-key");

	await assert.rejects(
		setup,
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	assert.equal(customCalls, 0);
});

test("stored S3 credentials reject a blank access key ID", async () => {
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => "Store credentials privately",
		input: async () => "",
	});

	assert.equal(await chooseS3Credentials(ctx), undefined);
	assert.match(notifications.at(-1)?.message ?? "", /Access key ID is required/i);
});

test("masked secret input cancellation returns without a secret", async () => {
	const tui = createTuiHarness({ width: 12 });
	const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const pending = promptSecret(ctx, "Password");
	await tui.waitForOpen();
	tui.type("secret");
	tui.press("tui.select.cancel");
	assert.equal(await pending, undefined);
});

test("masked secret input uses injected submit and cancellation keybindings", async () => {
	const mapping: Record<string, string> = {
		"tui.input.submit": "s",
		"tui.select.cancel": "q",
	};
	const keybindings: Pick<KeybindingsManager, "matches" | "getKeys"> = {
		matches: (data, binding) => data === mapping[binding],
		getKeys: (binding) => (mapping[binding] ? [mapping[binding] as never] : []),
	};
	const tui = createTuiHarness({ width: 40, keybindings });
	const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const pending = promptSecret(ctx, "Password");
	await tui.waitForOpen();
	const frame = tui.render().join("\n");
	assert.match(frame, /s save • q\/ctrl\+c cancel/u);
	assert.equal(frame.match(/ctrl\+c/gu)?.length, 1);
	tui.send("q");
	assert.equal(await pending, undefined);
});

test("masked secret input keeps Ctrl+C when cancellation is remapped", async () => {
	const mapping: Record<string, string> = {
		"tui.input.submit": "s",
		"tui.select.cancel": "q",
	};
	const keybindings: Pick<KeybindingsManager, "matches" | "getKeys"> = {
		matches: (data, binding) => data === mapping[binding],
		getKeys: (binding) => (mapping[binding] ? [mapping[binding] as never] : []),
	};
	const tui = createTuiHarness({ width: 40, keybindings });
	const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
	const pending = promptSecret(ctx, "Password");
	await tui.waitForOpen();
	tui.type("secret");
	assert.doesNotMatch(tui.render().join("\n"), /secret/u);
	tui.press("ctrl+c");
	assert.equal(await pending, undefined);
	assert.equal(tui.isOpen, false);
});

test("a stale secret prompt never creates its masked component", async () => {
	const owner = new AbortController();
	let releaseHost: () => void = () => undefined;
	const hostGate = new Promise<void>((resolve) => {
		releaseHost = resolve;
	});
	const tui = createTuiHarness({ width: 20 });
	const { ctx } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: Parameters<typeof tui.custom>[0]) => {
			await hostGate;
			return tui.custom(factory);
		},
	});
	const pending = promptSecret(ctx, "Password", { signal: owner.signal });
	owner.abort(new DOMException("Session replaced", "AbortError"));
	releaseHost();
	await flushAsync();
	try {
		assert.equal(tui.isOpen, false);
	} finally {
		if (tui.isOpen) tui.dispose();
	}
	assert.equal(await pending, undefined);
});

async function flushAsync() {
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await Promise.resolve();
}
