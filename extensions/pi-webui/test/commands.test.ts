import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
} from "../../../test/support.js";
import { type RuntimeDependencies, WebUIRuntime } from "../src/runtime.js";
import { DEFAULT_SETTINGS, type SettingsLoadResult } from "../src/settings.js";

initTheme("dark", false);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("condition was not met");
}

function createRuntime(
	overrides: Partial<RuntimeDependencies> = {},
	loaded: SettingsLoadResult = {
		kind: "missing",
		path: "/agent/pi-webui.json",
		settings: { ...DEFAULT_SETTINGS },
		source: "defaults",
		document: {},
	},
) {
	const mock = createMockPi();
	let links = 0;
	const runtime = new WebUIRuntime(mock.pi, {
		loadSettings: async () => loaded,
		saveSettings: async (settings, document) => ({ ...document, ...settings }),
		initializeSettings: async () => "created",
		startServer: async () => ({
			issueLink: () => `http://127.0.0.1:1234/bootstrap?token=${++links}`,
			close: async () => undefined,
		}),
		readPiSettings: async () => ({ autoResize: true, blockImages: false, warnings: [] }),
		processImages: async () => [],
		...overrides,
	});
	runtime.register();
	return { mock, runtime };
}

test("webui command completes and routes settings, status, help, and invalid arguments", async () => {
	const { mock, runtime } = createRuntime();
	const context = createMockContext({ hasUI: true, mode: "rpc" });
	await runtime.start(context.ctx);
	const command = mock.commands.get("webui");
	assert.ok(command);
	const completions = command.getArgumentCompletions?.("") as Array<{ value: string }> | undefined;
	assert.ok(completions);
	assert.deepEqual(
		completions.map((item) => item.value),
		["settings", "status", "help", "init"],
	);

	await command.handler("settings", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /manual.*pi-webui\.json/i);
	await command.handler("status", context.ctx);
	const status = context.notifications.at(-1)?.message ?? "";
	assert.match(status, /startOnSessionStart: false.*defaults/is);
	assert.match(
		status,
		/Image limits \(defaults\): 8 images, 10 MiB\/image, 40 MiB\/batch, 50,000,000 pixels\/image/,
	);
	assert.match(status, /server: stopped/i);
	assert.doesNotMatch(status, /token=/i);
	await command.handler("help", context.ctx);
	const help = context.notifications.at(-1)?.message ?? "";
	assert.match(help, /\/webui \[settings\|status\|help\|init\]/i);
	assert.match(help, /"startOnSessionStart": false/);
	assert.match(help, /maxImages.*maxImageBytes.*maxBatchBytes.*maxImagePixels/i);
	assert.match(help, /provider-ready dimension\/Base64 limits are fixed/i);
	assert.doesNotMatch(help, /token=/i);
	await command.handler("unknown", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /usage:/i);

	await command.handler("", context.ctx);
	await command.handler("status", context.ctx);
	const runningStatus = context.notifications.at(-1)?.message ?? "";
	assert.match(runningStatus, /server: running/i);
	assert.doesNotMatch(runningStatus, /token=/i);
});

test("settings never opens custom TUI in RPC, JSON, or print modes", async () => {
	const { mock, runtime } = createRuntime();
	let customCalls = 0;
	for (const mode of ["rpc", "json", "print"]) {
		const context = createMockContext({
			hasUI: mode === "rpc",
			mode,
			custom: async () => {
				customCalls += 1;
			},
		});
		await runtime.start(context.ctx);
		await mock.commands.get("webui")?.handler("settings", context.ctx);
	}
	assert.equal(customCalls, 0);
});

test("init creates defaults without TUI in non-TUI modes and opens settings in TUI", async () => {
	let initialized = 0;
	let customCalls = 0;
	const { mock, runtime } = createRuntime({
		initializeSettings: async () => {
			initialized += 1;
			return initialized === 1 ? "created" : "exists";
		},
	});
	const rpc = createMockContext({
		hasUI: true,
		mode: "rpc",
		custom: async () => {
			customCalls += 1;
		},
	});
	await runtime.start(rpc.ctx);
	await mock.commands.get("webui")?.handler("init", rpc.ctx);
	assert.equal(initialized, 1);
	assert.equal(customCalls, 0);
	assert.match(rpc.notifications.at(-1)?.message ?? "", /created.*pi-webui\.json/i);

	const tui = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) => {
			customCalls += 1;
			const selector = createCustomSelectorHarness(factory);
			selector.handleInput("\u001b");
			return selector.result;
		},
	});
	await mock.commands.get("webui")?.handler("init", tui.ctx);
	assert.equal(initialized, 2);
	assert.equal(customCalls, 1);
	assert.match(tui.notifications[0]?.message ?? "", /already exists/i);
});

test("settings changes save in action order and update effective status", async () => {
	const first = deferred<void>();
	const requested: boolean[] = [];
	const { mock, runtime } = createRuntime({
		saveSettings: async (settings, document) => {
			requested.push(settings.startOnSessionStart);
			if (requested.length === 1) await first.promise;
			return { ...document, ...settings };
		},
	});
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) => {
			const selector = createCustomSelectorHarness(factory);
			assert.doesNotMatch(
				selector.render().join("\n"),
				/maxImages|maxImageBytes|maxBatchBytes|maxImagePixels/,
			);
			selector.handleInput("\r");
			selector.handleInput("\r");
			await waitFor(() => requested.length === 1);
			assert.deepEqual(requested, [true]);
			first.resolve(undefined);
			await waitFor(() => requested.length === 2);
			selector.handleInput("\u001b");
			return selector.result;
		},
	});
	await runtime.start(context.ctx);
	await mock.commands.get("webui")?.handler("settings", context.ctx);
	assert.deepEqual(
		requested,
		[true, false],
		context.notifications.map((item) => item.message).join("\n"),
	);
	await mock.commands.get("webui")?.handler("status", context.ctx);
	assert.match(
		context.notifications.at(-1)?.message ?? "",
		/startOnSessionStart: false.*settings file/is,
	);
});

test("failed settings save rolls back the displayed and effective value", async () => {
	const { mock, runtime } = createRuntime({
		saveSettings: async () => {
			throw new Error("disk full");
		},
	});
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) => {
			const selector = createCustomSelectorHarness(factory);
			selector.handleInput("\r");
			await waitFor(() => context.notifications.some((item) => /disk full/i.test(item.message)));
			assert.ok(selector.render().some((line) => /false/.test(line)));
			selector.handleInput("\u001b");
			return selector.result;
		},
	});
	await runtime.start(context.ctx);
	await mock.commands.get("webui")?.handler("settings", context.ctx);
	await mock.commands.get("webui")?.handler("status", context.ctx);
	assert.match(
		context.notifications.at(-1)?.message ?? "",
		/startOnSessionStart: false.*defaults/is,
	);
});
