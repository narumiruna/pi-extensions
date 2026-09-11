import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import toolExtension from "../src/index.js";
import { createToolCatalog } from "../src/tool-catalog.js";

initTheme("dark", false);

const configuredTools = [
	{
		name: "read",
		description: "Read a file from disk.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "File path" } },
			required: ["path"],
		},
		promptGuidelines: ["Use read before editing a file.", "Columns\tstay aligned."],
		sourceInfo: {
			path: "<builtin:read>",
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		},
	},
	{
		name: "deploy",
		description: "Deploy the current project.",
		parameters: { type: "object", properties: {} },
		promptGuidelines: undefined,
		sourceInfo: {
			path: "/home/test/.pi/extensions/deploy.ts",
			source: "deploy.ts",
			scope: "user",
			origin: "package",
			baseDir: "/home/test/.pi/extensions",
		},
	},
] as const;

const TEST_SETTINGS = {
	settingsPath: "/test/pi-tool.json",
	readSettings: async () => ({
		kind: "missing" as const,
		settings: { activeToolStatus: false },
	}),
	updateSettings: async (patch: { activeToolStatus?: boolean }) => ({
		activeToolStatus: patch.activeToolStatus ?? false,
	}),
	awaitSettingsWrites: async () => {},
};

function startToolExtension(pi: Parameters<typeof toolExtension>[0]) {
	toolExtension(pi, TEST_SETTINGS);
}

async function openToolCatalog(tui: ReturnType<typeof createTuiHarness>) {
	tui.press("tui.select.confirm");
	await tui.waitForOpen();
}

test("catalog lists every tool alphabetically with active state and complete exposed metadata", () => {
	const catalog = createToolCatalog(configuredTools as never, ["read"], {
		read: "Read file contents from the current workspace",
	});
	assert.equal(catalog.title, "Tools · 1/2 active");
	assert.deepEqual(
		catalog.items.map(({ id, statusText }) => ({ id, statusText })),
		[
			{ id: "deploy", statusText: "inactive" },
			{ id: "read", statusText: "active" },
		],
	);

	const deploy = catalog.items[0];
	assert.ok(deploy);
	assert.equal(deploy.description, "Deploy the current project.");
	assert.match(
		deploy.detailContent,
		/Source: deploy\.ts\nScope: user\nOrigin: package\nPath: \/home\/test/u,
	);
	assert.match(deploy.detailContent, /Parameter schema\n\{\n {2}"type": "object"/u);
	assert.match(
		deploy.detailContent,
		/Effective prompt snippet\nNone in the current system prompt\./u,
	);
	assert.match(deploy.detailContent, /Prompt guidelines\nNone/u);

	const read = catalog.items[1];
	assert.match(read?.detailContent ?? "", /"required": \[\n {4}"path"\n {2}\]/u);
	assert.match(
		read?.detailContent ?? "",
		/Effective prompt snippet\nRead file contents from the current workspace/u,
	);
	assert.match(read?.detailContent ?? "", /Prompt guidelines\n• Use read before editing/u);
	assert.match(read?.detailContent ?? "", /• Columns\tstay aligned/u);
});

test("TUI browser searches across exposed tool metadata", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 100, rows: 24 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	await openToolCatalog(tui);
	for (const size of [
		{ width: 60, rows: 16 },
		{ width: 24, rows: 8 },
		{ width: 8, rows: 4 },
		{ width: 1, rows: 1 },
	]) {
		const lines = tui.resize(size);
		assert.ok(lines.length <= Math.max(1, size.rows - 3), `${size.width}x${size.rows}`);
		assert.ok(
			lines.every((line) => displayCellWidth(line) <= size.width),
			`${size.width}x${size.rows}`,
		);
	}
	tui.resize({ width: 100, rows: 24 });
	tui.type("builtin temporary");
	const frame = stripVTControlCharacters(tui.render().join("\n"));
	assert.match(frame, /read.*\[active\]/u);
	assert.doesNotMatch(frame, /deploy/u);
	tui.press("ctrl+c");
	await running;
});

test("exact detail documents do not become implicit browse search metadata", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 60, rows: 16 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	await openToolCatalog(tui);
	tui.type("Parameter schema");
	assert.match(stripVTControlCharacters(tui.render().join("\n")), /No matching items/u);
	tui.press("ctrl+c");
	await running;
});

test("/tool supports RPC list and detail navigation", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const rpc = createRpcHarness([
		{ kind: "select", response: "Browse tools" },
		{ kind: "select", response: "read [active]" },
		{ kind: "select", response: "Next" },
		{ kind: "select", response: "Next" },
		{ kind: "select", response: "Next" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Close" },
	]);
	let promptOptionReads = 0;
	const base = createMockContext({
		hasUI: true,
		mode: "rpc",
		getSystemPromptOptions: () => {
			promptOptionReads += 1;
			return {
				cwd: "/home/test/project",
				selectedTools: ["read"],
				toolSnippets: { read: "Read file contents from the current workspace" },
			};
		},
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	await command.handler("", { ...base, ui: { ...base.ui, ...rpc.ui } });
	rpc.assertConsumed();
	assert.deepEqual(rpc.dialogs[1]?.options, ["deploy [inactive]", "read [active]", "Back"]);
	assert.doesNotMatch(rpc.dialogs[1]?.options?.join("\n") ?? "", /Parameter schema|File path/u);
	const detailPages = rpc.dialogs
		.slice(2, 6)
		.map(({ title }) => title)
		.join("\n");
	assert.match(detailPages, /Parameter schema/u);
	assert.match(detailPages, /^ {2}"type": "object",$/mu);
	assert.match(detailPages, /^ {4}"path": \{$/mu);
	assert.match(detailPages, /Read file contents from the current workspace/u);
	assert.match(detailPages, /Use read before editing/u);
	assert.equal(promptOptionReads, 1);
});

test("session start applies manual settings and warns when invalid settings are ignored", async () => {
	const enabledMock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	toolExtension(enabledMock.pi, {
		...TEST_SETTINGS,
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: { activeToolStatus: true },
		}),
	});
	const enabledContext = createMockContext({ hasUI: true, mode: "tui" });
	await enabledMock.events.get("session_start")?.[0]?.({}, enabledContext.ctx);
	assert.equal(typeof enabledContext.widgets.get("tool:active-tools"), "function");
	await enabledMock.events.get("session_shutdown")?.[0]?.({}, enabledContext.ctx);

	const invalidMock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	toolExtension(invalidMock.pi, {
		...TEST_SETTINGS,
		readSettings: async () => ({
			kind: "invalid" as const,
			reason: "/test/pi-tool.json: invalid JSON",
			settings: { activeToolStatus: false },
		}),
	});
	const invalidContext = createMockContext({ hasUI: true, mode: "tui" });
	await invalidMock.events.get("session_start")?.[0]?.({}, invalidContext.ctx);
	assert.match(invalidContext.notifications[0]?.message ?? "", /ignored invalid settings/u);
	assert.equal(invalidContext.widgets.has("tool:active-tools"), false);
	await invalidMock.events.get("session_shutdown")?.[0]?.({}, invalidContext.ctx);
});

test("a delayed settings load cannot overwrite a replacement session", async () => {
	let resolveFirst!: (value: { kind: "loaded"; settings: { activeToolStatus: boolean } }) => void;
	let reads = 0;
	const firstLoad = new Promise<{
		kind: "loaded";
		settings: { activeToolStatus: boolean };
	}>((resolve) => {
		resolveFirst = resolve;
	});
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	toolExtension(mock.pi, {
		...TEST_SETTINGS,
		readSettings: async () => {
			reads += 1;
			return reads === 1
				? firstLoad
				: { kind: "loaded" as const, settings: { activeToolStatus: true } };
		},
	});
	const previous = createMockContext({ hasUI: true, mode: "tui" });
	const current = createMockContext({ hasUI: true, mode: "tui" });
	const start = mock.events.get("session_start")?.[0];
	assert.ok(start);
	const previousStart = Promise.resolve(start({}, previous.ctx));
	await Promise.resolve();
	await start({}, current.ctx);
	assert.equal(typeof current.widgets.get("tool:active-tools"), "function");
	resolveFirst({ kind: "loaded", settings: { activeToolStatus: false } });
	await previousStart;
	assert.equal(typeof current.widgets.get("tool:active-tools"), "function");
	assert.equal(previous.widgets.has("tool:active-tools"), false);
	await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
});

test("/tool toggles and persists the active-tool widget in TUI mode", async () => {
	const saved: boolean[] = [];
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	toolExtension(mock.pi, {
		settingsPath: "/test/pi-tool.json",
		readSettings: TEST_SETTINGS.readSettings,
		updateSettings: async (patch) => {
			saved.push(patch.activeToolStatus ?? false);
			return { activeToolStatus: patch.activeToolStatus ?? false };
		},
		awaitSettingsWrites: TEST_SETTINGS.awaitSettingsWrites,
	});
	const lifecycle = createMockContext({ hasUI: true, mode: "tui" });
	await mock.events.get("session_start")?.[0]?.({}, lifecycle.ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 80, rows: 20 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	assert.match(stripVTControlCharacters(tui.render().join("\n")), /Active tool status.*Off/u);
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await tui.waitForOpen();
	assert.match(stripVTControlCharacters(tui.render().join("\n")), /Active tool status.*On/u);
	assert.deepEqual(saved, [true]);
	assert.equal(typeof lifecycle.widgets.get("tool:active-tools"), "function");
	tui.press("ctrl+c");
	await running;
	await mock.events.get("session_shutdown")?.[0]?.({}, lifecycle.ctx);
	assert.equal(lifecycle.widgets.get("tool:active-tools"), undefined);
});

test("/tool toggles and persists the active-tool widget in RPC mode", async () => {
	const saved: boolean[] = [];
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	toolExtension(mock.pi, {
		settingsPath: "/test/pi-tool.json",
		readSettings: TEST_SETTINGS.readSettings,
		updateSettings: async (patch) => {
			saved.push(patch.activeToolStatus ?? false);
			return { activeToolStatus: patch.activeToolStatus ?? false };
		},
		awaitSettingsWrites: TEST_SETTINGS.awaitSettingsWrites,
	});
	const lifecycle = createMockContext({ hasUI: true, mode: "rpc" });
	await mock.events.get("session_start")?.[0]?.({}, lifecycle.ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const rpc = createRpcHarness([
		{ kind: "select", response: "Active tool status: Off" },
		{ kind: "select", response: "Close" },
	]);
	const base = createMockContext({
		hasUI: true,
		mode: "rpc",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	await command.handler("", { ...base, ui: { ...base.ui, ...rpc.ui } });
	rpc.assertConsumed();
	assert.deepEqual(saved, [true]);
	assert.deepEqual(lifecycle.widgets.get("tool:active-tools"), ["Active tool (1)", "read"]);
	await mock.events.get("session_shutdown")?.[0]?.({}, lifecycle.ctx);
});

test("a failed settings save restores the previous widget state", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	toolExtension(mock.pi, {
		settingsPath: "/test/pi-tool.json",
		readSettings: TEST_SETTINGS.readSettings,
		updateSettings: async () => Promise.reject(new Error("injected save failure")),
		awaitSettingsWrites: TEST_SETTINGS.awaitSettingsWrites,
	});
	const lifecycle = createMockContext({ hasUI: true, mode: "rpc" });
	await mock.events.get("session_start")?.[0]?.({}, lifecycle.ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const rpc = createRpcHarness([
		{ kind: "select", response: "Active tool status: Off" },
		{ kind: "select", response: "Close" },
	]);
	const base = createMockContext({
		hasUI: true,
		mode: "rpc",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	});
	const context = base.ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	await command.handler("", { ...context, ui: { ...context.ui, ...rpc.ui } });
	rpc.assertConsumed();
	assert.equal(lifecycle.widgets.get("tool:active-tools"), undefined);
	assert.match(base.notifications[0]?.message ?? "", /widget was restored.*injected save failure/u);
	await mock.events.get("session_shutdown")?.[0]?.({}, lifecycle.ctx);
});

test("/tool rejects arguments and noninteractive modes before opening the catalog", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	startToolExtension(mock.pi);
	const command = mock.commands.get("tool");
	assert.ok(command);
	await assert.rejects(async () => {
		await command.handler("read", createMockContext({ hasUI: true, mode: "tui" }).ctx);
	}, /does not accept arguments/u);
	for (const mode of ["print", "json"] as const) {
		await assert.rejects(async () => {
			await command.handler("", createMockContext({ hasUI: false, mode }).ctx);
		}, /requires TUI or RPC mode/u);
	}
});

test("nested parameter schema indentation survives the TUI detail boundary", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 100, rows: 24 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	await openToolCatalog(tui);
	tui.type("builtin temporary");
	tui.press("tui.select.confirm");
	await tui.waitForOpen();
	assert.equal(tui.openCount, 2, "browse details must stay in one standard menu interaction");
	const frame = stripVTControlCharacters(tui.render().join("\n"));
	assert.match(frame, /^ {2}"type": "object",$/mu);
	assert.match(frame, /^ {4}"path": \{$/mu);
	const narrowFrame = tui.resize({ width: 20, rows: 24 });
	assert.ok(narrowFrame.every((line) => displayCellWidth(line) <= 20));
	const narrowText = stripVTControlCharacters(narrowFrame.join("\n"));
	assert.match(narrowText, /^ {2}"type": "object",$/mu);
	tui.press("tui.select.pageDown");
	const scrolledNarrowFrame = tui.render();
	assert.ok(scrolledNarrowFrame.every((line) => displayCellWidth(line) <= 20));
	assert.match(stripVTControlCharacters(scrolledNarrowFrame.join("\n")), /^ {4}"path": \{$/mu);
	tui.resize({ width: 100, rows: 24 });
	tui.press("end");
	const finalDetailFrame = stripVTControlCharacters(tui.render().join("\n"));
	assert.doesNotMatch(finalDetailFrame, /\t/u);
	assert.match(finalDetailFrame, /Columns\s+stay aligned/u);
	tui.press("tui.select.cancel");
	await tui.waitForOpen();
	assert.equal(tui.openCount, 2, "returning from details must not remount the browser");
	assert.match(stripVTControlCharacters(tui.render().join("\n")), /Search: > builtin temporary/u);
	tui.press("ctrl+c");
	await running;
});

test("terminal controls are stripped by the browse display boundary", async () => {
	const unsafeTools = [
		{
			...configuredTools[0],
			name: "read\u001b]0;owned\u0007",
			description: "Read 工具🙂\u001b[31m file",
		},
	];
	const mock = createMockPi({ allTools: unsafeTools as never, activeTools: [] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 100, rows: 24 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	await openToolCatalog(tui);
	let frame = tui.render().join("\n");
	assert.equal(frame.includes("\u001b]0;owned"), false);
	assert.equal(frame.includes("\u0007"), false);
	tui.press("tui.select.confirm");
	const narrowFrame = tui.resize({ width: 12, rows: 16 });
	assert.ok(narrowFrame.every((line) => displayCellWidth(line) <= 12));
	frame = narrowFrame.join("\n");
	assert.match(stripVTControlCharacters(frame), /工具|🙂/u);
	assert.equal(frame.includes("\u001b]0;owned"), false);
	assert.equal(frame.includes("\u001b[31m"), false);
	assert.equal(frame.includes("\u0007"), false);
	tui.press("ctrl+c");
	await running;

	const rpc = createRpcHarness([
		{ kind: "select", response: "Browse tools" },
		{ kind: "select", response: "read [inactive]" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Close" },
	]);
	await command.handler("", { ...base, mode: "rpc", ui: { ...base.ui, ...rpc.ui } });
	rpc.assertConsumed();
	assert.equal(
		rpc.dialogs.every(
			(dialog) => !dialog.title.includes("\u001b") && !dialog.title.includes("\u0007"),
		),
		true,
	);
});

test("duplicate sanitized labels keep stable raw tool identity in RPC", async () => {
	const duplicateTools = [
		{
			...configuredTools[0],
			name: "same\u001b[31m",
			sourceInfo: { ...configuredTools[0].sourceInfo, path: "<builtin:first>" },
		},
		{
			...configuredTools[0],
			name: "same\u0007",
			sourceInfo: { ...configuredTools[0].sourceInfo, path: "<builtin:second>" },
		},
	];
	const catalog = createToolCatalog(duplicateTools as never, [], {});
	const secondPath = catalog.items[1]?.detailContent
		.split("\n")
		.find((line) => line.startsWith("Path: "));
	assert.ok(secondPath);
	const mock = createMockPi({ allTools: duplicateTools as never, activeTools: [] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const rpc = createRpcHarness([
		{ kind: "select", response: "Browse tools" },
		{ kind: "select", response: "same [inactive] [2]" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Close" },
	]);
	const base = createMockContext({
		hasUI: true,
		mode: "rpc",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	await command.handler("", { ...base, ui: { ...base.ui, ...rpc.ui } });
	rpc.assertConsumed();
	assert.deepEqual(rpc.dialogs[1]?.options, ["same [inactive]", "same [inactive] [2]", "Back"]);
	assert.match(rpc.dialogs[2]?.title ?? "", new RegExp(escapeRegExp(secondPath), "u"));
});

test("session replacement aborts and disposes an open menu", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	startToolExtension(mock.pi);
	const lifecycle = createMockContext({ hasUI: true, mode: "tui" }).ctx;
	await mock.events.get("session_start")?.[0]?.({}, lifecycle);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 100, rows: 24 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	await openToolCatalog(tui);
	tui.press("tui.select.confirm");
	assert.match(stripVTControlCharacters(tui.render().join("\n")), /Parameter schema/u);
	await mock.events.get("session_start")?.[0]?.({}, lifecycle);
	await running;
	assert.equal(tui.isOpen, false);
	assert.equal((tui.result as { kind?: unknown } | undefined)?.kind, "close");
});

test("session shutdown aborts and disposes an open menu", async () => {
	const mock = createMockPi({ allTools: [...configuredTools], activeTools: ["read"] });
	startToolExtension(mock.pi);
	const lifecycle = createMockContext({ hasUI: true, mode: "tui" }).ctx;
	await mock.events.get("session_start")?.[0]?.({}, lifecycle);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 100, rows: 24 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	await mock.events.get("session_shutdown")?.[0]?.({}, lifecycle);
	await running;
	assert.equal(tui.isOpen, false);
	assert.equal((tui.result as { kind?: unknown } | undefined)?.kind, "close");
});

test("an empty catalog remains bounded and can close", async () => {
	const mock = createMockPi({ allTools: [], activeTools: [] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const tui = createTuiHarness({ width: 20, rows: 10 });
	const base = createMockContext({
		hasUI: true,
		mode: "tui",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};
	const running = command.handler("", { ...base, ui: { ...base.ui, custom: tui.custom } });
	await tui.waitForOpen();
	await openToolCatalog(tui);
	const frame = stripVTControlCharacters(tui.render().join("\n"));
	assert.match(frame, /Tools · 0\/0 active/u);
	assert.match(frame, /No items available/u);
	tui.press("ctrl+c");
	await running;
});

test("each command reads a fresh sorted catalog and active state", async () => {
	const allTools: (typeof configuredTools)[number][] = [configuredTools[0]];
	const mock = createMockPi({ allTools, activeTools: [] });
	startToolExtension(mock.pi);
	await mock.events.get("session_start")?.[0]?.({}, createMockContext({ hasUI: true }).ctx);
	const command = mock.commands.get("tool");
	assert.ok(command);
	const base = createMockContext({
		hasUI: true,
		mode: "rpc",
		getSystemPromptOptions: () => ({ cwd: "/home/test/project", toolSnippets: {} }),
	}).ctx as unknown as {
		ui: Record<string, unknown>;
		[key: string]: unknown;
	};

	const first = createRpcHarness([
		{ kind: "select", response: "Browse tools" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Close" },
	]);
	await command.handler("", { ...base, ui: { ...base.ui, ...first.ui } });
	first.assertConsumed();
	assert.deepEqual(first.dialogs[1]?.options, ["read [inactive]", "Back"]);

	allTools.push(configuredTools[1]);
	mock.rawPi.setActiveTools(["deploy"]);
	const second = createRpcHarness([
		{ kind: "select", response: "Browse tools" },
		{ kind: "select", response: "Back" },
		{ kind: "select", response: "Close" },
	]);
	await command.handler("", { ...base, ui: { ...base.ui, ...second.ui } });
	second.assertConsumed();
	assert.deepEqual(second.dialogs[1]?.options, ["deploy [active]", "read [inactive]", "Back"]);
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function displayCellWidth(value: string): number {
	let width = 0;
	for (const character of stripVTControlCharacters(value)) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (/\p{Mark}/u.test(character) || codePoint === 0x200d) continue;
		width +=
			/\p{Extended_Pictographic}/u.test(character) ||
			(codePoint >= 0x1100 &&
				(codePoint <= 0x115f ||
					codePoint === 0x2329 ||
					codePoint === 0x232a ||
					(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
					(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
					(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
					(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
					(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
					(codePoint >= 0xff00 && codePoint <= 0xff60) ||
					(codePoint >= 0xffe0 && codePoint <= 0xffe6)))
				? 2
				: 1;
	}
	return width;
}
