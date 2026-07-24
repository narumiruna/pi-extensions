import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi, driveCustomSelector } from "../../../test/support.js";
import { registerStarshipCommand } from "../src/commands.js";
import { BUILT_IN_EXAMPLE, loadStarshipConfig, settingsFilePath } from "../src/config.js";
import piStarship from "../src/pi-starship.js";

test("/starship keeps direct routes and opens a stateful narrow TUI menu", async () => {
	const mock = createMockPi();
	const fallback = loadStarshipConfig("/tmp/missing-pi-starship-main-menu.toml");
	const loaded = { ...fallback, source: "user" as const, rawDocument: BUILT_IN_EXAMPLE };
	registerStarshipCommand(mock.pi, {
		getLoaded: () => loaded,
		apply() {},
		settingsPath: "/tmp/missing-pi-starship-main-menu.toml",
	});
	const command = mock.commands.get("starship");
	assert.ok(command);
	assert.ok(command.getArgumentCompletions);
	assert.deepEqual(
		(command.getArgumentCompletions("") as Array<{ value: string }>).map((item) => item.value),
		["settings", "status", "help"],
	);
	assert.deepEqual(
		(command.getArgumentCompletions("st") as Array<{ value: string }>).map((item) => item.value),
		["status"],
	);

	const renders: string[][] = [];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const driven = driveCustomSelector(factory, ["\u001b"], 28);
			renders.push(...driven.renders);
			return driven.result;
		},
	});
	await command.handler("", context.ctx);
	const screen = renders.flat().join("\n");
	assert.match(screen, /pi-starship/u);
	assert.match(screen, /Built-in footer · Healthy/u);
	assert.match(screen, /Customize footer/u);
	assert.match(screen, /Check configuration/u);
	assert.match(screen, /Help/u);
	assert.match(screen, /Advanced/u);
	assert.ok(renders.flat().every((line) => visibleWidth(line) <= 28));
});

test("settings opens the raw TOML in TUI, saves atomically, and applies immediately", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const mock = createMockPi();
		(mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () =>
			gitResult();
		piStarship(mock.pi);
		let initial = "";
		let preview = "";
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			editor: async (_title: string, value: string) => {
				initial = value;
				return "format = 'saved'\n";
			},
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, ["\r"], 40);
				preview = driven.renders.flat().join("\n");
				return driven.result;
			},
			confirm: async () => true,
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		const footer = (context.footer as FooterFactory)(
			{ requestRender() {} },
			{},
			{
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(initial, BUILT_IN_EXAMPLE);
		assert.match(preview, /preview/iu);
		assert.match(preview, /saved/u);
		assert.match(preview, /Continue to apply/u);
		assert.equal(readFileSync(settingsFilePath(root), "utf8"), "format = 'saved'\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /saved/i);

		assert.deepEqual(footer.render(80), ["saved"]);
		footer.dispose();
		await emit(mock.events, "session_shutdown", {}, context.ctx);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid and cancelled edits keep the old file and effective config", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "format = 'old'\n");
	try {
		const mock = createMockPi();
		let loaded = loadStarshipConfig(path);
		let applied = 0;
		let nextEdit: string | undefined = "format = [";
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
				applied += 1;
			},
			settingsPath: path,
		});
		const context = createMockContext({
			mode: "tui",
			editor: async () => nextEdit,
		});
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(readFileSync(path, "utf8"), "format = 'old'\n");
		assert.equal(loaded.config.format, "old");
		assert.equal(applied, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", /parse/i);

		nextEdit = undefined;
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(applied, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("save failures retain current state and report the error", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "format = 'old'\n");
	try {
		const mock = createMockPi();
		const loaded = loadStarshipConfig(path);
		let applied = false;
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply() {
				applied = true;
			},
			settingsPath: path,
			save() {
				throw new Error("disk full");
			},
		});
		let previewCalls = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			editor: async () => "format = 'new'\n",
			custom: async (factory: unknown) => {
				const inputs = previewCalls++ === 0 ? ["\r"] : ["\u001b"];
				return driveCustomSelector(factory, inputs, 40).result;
			},
			confirm: async () => true,
		});
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(previewCalls, 2);
		assert.equal(applied, false);
		assert.equal(readFileSync(path, "utf8"), "format = 'old'\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /disk full/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime apply failures restore the previous file and effective configuration", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "format = 'old'\n");
	try {
		const mock = createMockPi();
		let loaded = loadStarshipConfig(path);
		let previewCalls = 0;
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply(next) {
				if (next.config.format === "new") throw new Error("renderer rejected config");
				loaded = next;
			},
			settingsPath: path,
		});
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			editor: async () => "format = 'new'\n",
			custom: async (factory: unknown) => {
				const inputs = previewCalls++ === 0 ? ["\r"] : ["\u001b"];
				return driveCustomSelector(factory, inputs, 36).result;
			},
			confirm: async () => true,
		});
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(readFileSync(path, "utf8"), "format = 'old'\n");
		assert.equal(loaded.config.format, "old");
		assert.match(context.notifications.at(-1)?.message ?? "", /previous.*restored/iu);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-TUI settings never opens an editor and status/help are protocol-safe", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	try {
		const mock = createMockPi();
		const loaded = loadStarshipConfig(settingsFilePath(root));
		let editorCalls = 0;
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply() {},
			settingsPath: settingsFilePath(root),
		});
		const rpc = createMockContext({
			mode: "rpc",
			hasUI: true,
			editor: async () => {
				editorCalls += 1;
				return undefined;
			},
		});
		await mock.commands.get("starship")?.handler("settings", rpc.ctx);
		assert.equal(editorCalls, 0);
		assert.match(rpc.notifications.at(-1)?.message ?? "", /pi-starship\.toml/);
		await mock.commands.get("starship")?.handler("", rpc.ctx);
		assert.match(rpc.notifications.at(-1)?.message ?? "", /interactive footer menu/iu);

		const print = createMockContext({ mode: "print", hasUI: false });
		await mock.commands.get("starship")?.handler("status", print.ctx);
		await mock.commands.get("starship")?.handler("help", print.ctx);
		assert.deepEqual(print.notifications, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preview and confirmation cancellation preserve the previous document and runtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "format = 'old'\nfuture = 'preserved'\n");
	try {
		const mock = createMockPi();
		let loaded = loadStarshipConfig(path);
		let applied = 0;
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
				applied += 1;
			},
			settingsPath: path,
		});

		let customCalls = 0;
		let confirmations = 0;
		const previewCancel = createMockContext({
			mode: "tui",
			hasUI: true,
			editor: async () => "format = 'new'\nfuture = 'preserved'\n",
			custom: async (factory: unknown) => {
				customCalls += 1;
				return driveCustomSelector(factory, ["\u001b"], 30).result;
			},
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		});
		await mock.commands.get("starship")?.handler("settings", previewCancel.ctx);
		assert.equal(customCalls, 1);
		assert.equal(confirmations, 0);
		assert.equal(applied, 0);
		assert.equal(readFileSync(path, "utf8"), "format = 'old'\nfuture = 'preserved'\n");

		customCalls = 0;
		const confirmationCancel = createMockContext({
			mode: "tui",
			hasUI: true,
			editor: async () => "format = 'new'\nfuture = 'preserved'\n",
			custom: async (factory: unknown) => {
				const inputs = customCalls++ === 0 ? ["\r"] : ["\u001b"];
				return driveCustomSelector(factory, inputs, 30).result;
			},
			confirm: async () => false,
		});
		await mock.commands.get("starship")?.handler("settings", confirmationCancel.ctx);
		assert.equal(customCalls, 2);
		assert.equal(applied, 0);
		assert.equal(readFileSync(path, "utf8"), "format = 'old'\nfuture = 'preserved'\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("main and Advanced menus expose current state and a clear Back path", async () => {
	const mock = createMockPi();
	const loaded = loadStarshipConfig("/tmp/missing-pi-starship-menu.toml");
	registerStarshipCommand(mock.pi, {
		getLoaded: () => loaded,
		apply() {},
		settingsPath: "/tmp/missing-pi-starship-menu.toml",
	});
	let call = 0;
	const screens: string[] = [];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const inputs =
				call === 0
					? ["\u001b[B", "\u001b[B", "\u001b[B", "\r"]
					: call === 1
						? ["\u001b[B", "\u001b[B", "\r"]
						: ["\u001b"];
			const driven = driveCustomSelector(factory, inputs, 26);
			screens[call++] = driven.renders.flat().join("\n");
			assert.ok(driven.renders.flat().every((line) => visibleWidth(line) <= 26));
			return driven.result;
		},
	});
	await mock.commands.get("starship")?.handler("", context.ctx);
	assert.equal(call, 3);
	assert.match(screens[1] ?? "", /Advanced/u);
	assert.match(screens[1] ?? "", /Configuration details/u);
	assert.match(screens[1] ?? "", /Restore built-in/u);
	assert.match(screens[1] ?? "", /Back/u);
	assert.match(screens[2] ?? "", /Customize footer/u);
});

test("Advanced restore previews, confirms, and atomically applies the built-in footer", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "format = 'custom'\nfuture = true\n");
	try {
		const mock = createMockPi();
		let loaded = loadStarshipConfig(path);
		let applied = 0;
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
				applied += 1;
			},
			settingsPath: path,
			renderPreview: (draft, width) => [draft.config.format.slice(0, width)],
		});
		let call = 0;
		let restorePreview = "";
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs =
					call === 0
						? ["\u001b[B", "\u001b[B", "\u001b[B", "\r"]
						: call === 1
							? ["\u001b[B", "\r"]
							: ["\r"];
				const driven = driveCustomSelector(factory, inputs, 32);
				if (call === 2) restorePreview = driven.renders.flat().join("\n");
				call += 1;
				return driven.result;
			},
			confirm: async () => true,
		});
		await mock.commands.get("starship")?.handler("", context.ctx);
		assert.match(restorePreview, /Restore preview/u);
		assert.match(restorePreview, /░▒▓/u);
		assert.equal(applied, 1);
		assert.equal(readFileSync(path, "utf8"), BUILT_IN_EXAMPLE);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid drafts can return to editing before preview and atomic apply", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "format = 'old'\nfuture = 'preserved'\n");
	try {
		const mock = createMockPi();
		let loaded = loadStarshipConfig(path);
		let editorCalls = 0;
		let menuCalls = 0;
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply(next) {
				loaded = next;
			},
			settingsPath: path,
		});
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			editor: async () => {
				editorCalls += 1;
				return editorCalls === 1 ? "format = [" : "format = 'new'\nfuture = 'preserved'\n";
			},
			custom: async (factory: unknown) => {
				assert.equal(readFileSync(path, "utf8"), "format = 'old'\nfuture = 'preserved'\n");
				menuCalls += 1;
				return driveCustomSelector(factory, ["\r"], 34).result;
			},
			confirm: async () => true,
		});
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(editorCalls, 2);
		assert.equal(menuCalls, 2);
		assert.equal(readFileSync(path, "utf8"), "format = 'new'\nfuture = 'preserved'\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("diagnostics, Help, and configuration details stay shallow and fit narrow terminals", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "future = true\n");
	try {
		const mock = createMockPi();
		const loaded = loadStarshipConfig(path);
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply() {},
			settingsPath: path,
		});
		let call = 0;
		const screens: string[] = [];
		const inputSets = [
			["\u001b[B", "\r"],
			["\r"],
			["\u001b[B", "\u001b[B", "\r"],
			["\r"],
			["\u001b[B", "\u001b[B", "\u001b[B", "\r"],
			["\r"],
			["\r"],
			["\u001b[B", "\u001b[B", "\r"],
			["\u001b"],
		];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, inputSets[call] ?? ["\u001b"], 24);
				screens[call++] = driven.renders.flat().join("\n");
				assert.ok(driven.renders.flat().every((line) => visibleWidth(line) <= 24));
				return driven.result;
			},
		});
		await mock.commands.get("starship")?.handler("", context.ctx);
		assert.equal(call, 9);
		assert.match(screens[0] ?? "", /1\s+warning/u);
		assert.match(screens[1] ?? "", /Configuration health/u);
		assert.match(screens[1] ?? "", /future/u);
		assert.match(screens[3] ?? "", /pi-starship help/u);
		assert.match(screens[6] ?? "", /Configuration details/u);
		assert.match(screens[6] ?? "", /Path:/u);
		assert.match(screens[7] ?? "", /Back/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("restore preview cancellation has no side effects in a narrow terminal", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	const original = "format = 'custom'\nfuture = true\n";
	writeFileSync(path, original);
	try {
		const mock = createMockPi();
		const loaded = loadStarshipConfig(path);
		let applied = 0;
		let confirmations = 0;
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply() {
				applied += 1;
			},
			settingsPath: path,
			renderPreview: (draft, width) => [draft.config.format.slice(0, width)],
		});
		let call = 0;
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: async (factory: unknown) => {
				const inputs =
					call === 0
						? ["\u001b[B", "\u001b[B", "\u001b[B", "\r"]
						: call === 1
							? ["\u001b[B", "\r"]
							: ["\u001b"];
				const driven = driveCustomSelector(factory, inputs, 20);
				assert.ok(driven.renders.flat().every((line) => visibleWidth(line) <= 20));
				call += 1;
				return driven.result;
			},
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		});
		await mock.commands.get("starship")?.handler("", context.ctx);
		assert.equal(call, 4);
		assert.equal(confirmations, 0);
		assert.equal(applied, 0);
		assert.equal(readFileSync(path, "utf8"), original);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("status reports source/path/warnings and help reports manual configuration", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
	const path = settingsFilePath(root);
	writeFileSync(path, "future = true\n");
	try {
		const mock = createMockPi();
		const loaded = loadStarshipConfig(path);
		registerStarshipCommand(mock.pi, {
			getLoaded: () => loaded,
			apply() {},
			settingsPath: path,
		});
		const context = createMockContext({ mode: "tui", hasUI: true });
		await mock.commands.get("starship")?.handler("status", context.ctx);
		const status = context.notifications.at(-1)?.message ?? "";
		assert.match(status, /source: user/i);
		assert.match(status, /pi-starship\.toml/i);
		assert.match(status, /future/i);
		await mock.commands.get("starship")?.handler("help", context.ctx);
		assert.match(context.notifications.at(-1)?.message ?? "", /settings.*status.*help/is);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function emit(
	events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
	name: string,
	...args: unknown[]
) {
	for (const handler of events.get(name) ?? []) await handler(...args);
}

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
function gitResult(): ExecResult {
	return { stdout: "## main\n", stderr: "", code: 0, killed: false };
}

type FooterFactory = (
	tui: { requestRender(): void },
	theme: unknown,
	data: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		onBranchChange(callback: () => void): () => void;
	},
) => { render(width: number): string[]; dispose(): void };
