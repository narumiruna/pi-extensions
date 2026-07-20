import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStarshipCommand } from "../src/commands.js";
import { BUILT_IN_EXAMPLE, loadStarshipConfig, settingsFilePath } from "../src/config.js";
import piStarship from "../src/pi-starship.js";

test("/starship registers settings, status, and help autocomplete", () => {
	const mock = createMockPi();
	piStarship(mock.pi);
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
		const context = createMockContext({
			mode: "tui",
			editor: async (_title: string, value: string) => {
				initial = value;
				return "format = 'saved'\n";
			},
		});
		await emit(mock.events, "session_start", {}, context.ctx);
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(initial, BUILT_IN_EXAMPLE);
		assert.equal(readFileSync(settingsFilePath(root), "utf8"), "format = 'saved'\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /saved/i);

		const footer = (context.footer as FooterFactory)(
			{ requestRender() {} },
			{},
			{
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				onBranchChange: () => () => undefined,
			},
		);
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
		const context = createMockContext({ mode: "tui", editor: async () => "format = 'new'\n" });
		await mock.commands.get("starship")?.handler("settings", context.ctx);
		assert.equal(applied, false);
		assert.equal(readFileSync(path, "utf8"), "format = 'old'\n");
		assert.match(context.notifications.at(-1)?.message ?? "", /disk full/);
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

		const print = createMockContext({ mode: "print", hasUI: false });
		await mock.commands.get("starship")?.handler("status", print.ctx);
		await mock.commands.get("starship")?.handler("help", print.ctx);
		assert.deepEqual(print.notifications, []);
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
