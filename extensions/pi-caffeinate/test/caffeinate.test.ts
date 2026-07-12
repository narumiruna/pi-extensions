import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import caffeinate, {
	commandCompletions,
	formatMode,
	normalizeCaffeinateSettings,
	parseCommand,
	splitCommand,
	windowsInhibitorScript,
} from "../src/caffeinate.js";

const NEW_SETTINGS_FILE = "pi-caffeinate.json";
const LEGACY_SETTINGS_FILE = "pi-caffeinate-settings.json";

test("caffeinate registers lifecycle handlers and command controls", () => {
	const mock = createMockPi();
	caffeinate(mock.pi);

	assert.ok(mock.commands.has("caffeinate"));
	assert.deepEqual([...mock.events.keys()].sort(), [
		"agent_end",
		"agent_start",
		"session_shutdown",
		"session_start",
	]);
});

test("parseCommand accepts documented commands and aliases", () => {
	assert.equal(parseCommand(""), "menu");
	assert.equal(parseCommand(" status "), "status");
	assert.equal(parseCommand("system"), "sleep");
	assert.equal(parseCommand("screen"), "display");
	assert.equal(parseCommand("off"), "stop");
	assert.equal(parseCommand("wat"), "unknown");
});

test("commandCompletions filters single-token prefixes", () => {
	assert.deepEqual(commandCompletions("sta"), [
		{ value: "status", label: "status", description: "Show current status" },
	]);
	assert.equal(commandCompletions("status "), null);
	assert.equal(commandCompletions("status now"), null);
});

test("splitCommand handles quotes and escaped spaces", () => {
	assert.deepEqual(splitCommand("cmd --name 'two words' \"quoted\" a\\ b"), [
		"cmd",
		"--name",
		"two words",
		"quoted",
		"a b",
	]);
});

test("normalizeCaffeinateSettings accepts quiet booleans and defaults quiet to false", () => {
	assert.deepEqual(normalizeCaffeinateSettings({ mode: "sleep" }), {
		mode: "sleep",
		quiet: false,
		updatedAt: 0,
	});
	assert.deepEqual(normalizeCaffeinateSettings({ mode: "display", quiet: true }), {
		mode: "display",
		quiet: true,
		updatedAt: 0,
	});
	assert.deepEqual(normalizeCaffeinateSettings({ mode: "display", quiet: false }), {
		mode: "display",
		quiet: false,
		updatedAt: 0,
	});
	assert.equal(normalizeCaffeinateSettings({ mode: "display", quiet: "yes" }), undefined);
	assert.equal(normalizeCaffeinateSettings({ mode: "display", updatedAt: "now" }), undefined);
	assert.equal(normalizeCaffeinateSettings({ mode: "screen" }), undefined);
});

test("session start warns for deprecated PI_CAFFEINATE_ICON", async (t) => {
	const original = process.env.PI_CAFFEINATE_ICON;
	t.after(() => {
		if (original === undefined) delete process.env.PI_CAFFEINATE_ICON;
		else process.env.PI_CAFFEINATE_ICON = original;
	});

	await withTempAgentDir(async () => {
		process.env.PI_CAFFEINATE_ICON = "☕";
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		caffeinateModule.default(mock.pi);
		const { ctx, notifications } = createMockContext();
		const handler = mock.events.get("session_start")?.[0];

		await handler?.({}, ctx);

		assert.equal(notifications.length, 1);
		assert.match(notifications[0]?.message ?? "", /PI_CAFFEINATE_ICON is deprecated/);
		assert.match(notifications[0]?.message ?? "", /still works for now/);
		assert.match(notifications[0]?.message ?? "", /If you use @narumitw\/pi-statusline/);
	});
});

test("windowsInhibitorScript flags and formatMode labels are user-facing", () => {
	assert.match(windowsInhibitorScript("sleep"), /\[uint32\]'0x80000001'/);
	assert.match(windowsInhibitorScript("display"), /\[uint32\]'0x80000003'/);
	assert.match(windowsInhibitorScript("display"), /\[uint32\]'0x80000000'/);
	assert.equal(formatMode("sleep"), "system-awake");
	assert.equal(formatMode("display"), "display-awake");
});

test("caffeinate loads the new settings file without a migration warning", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "sleep");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		assert.equal(notifications.length, 0);

		await mock.commands.get("caffeinate")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Mode: system-awake/);
		assert.match(notifications.at(-1)?.message ?? "", /Quiet mode: disabled/);
		assert.match(notifications.at(-1)?.message ?? "", /Settings: .*pi-caffeinate\.json/);
	});
});

test("session reload applies manual quiet mode changes", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0];
		await sessionStart?.({ reason: "startup" }, ctx);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Quiet mode: disabled/);

		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		await sessionStart?.({ reason: "reload" }, ctx);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Quiet mode: enabled/);
	});
});

test("caffeinate migrates legacy-only settings and warns", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "sleep");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE), {
			mode: "sleep",
			updatedAt: 1,
		});
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /migrated/i);
		assert.match(notifications[0]?.message ?? "", /pi-caffeinate-settings\.json/);
		assert.match(notifications[0]?.message ?? "", /pi-caffeinate\.json/);

		await mock.commands.get("caffeinate")?.handler("status", ctx);
		const statusMessage = notifications.at(-1)?.message ?? "";
		assert.match(statusMessage, /Mode: system-awake/);
		assert.match(statusMessage, /Settings: .*pi-caffeinate\.json/);
		assert.match(statusMessage, /Settings note: .*migrated/i);
	});
});

test("caffeinate falls back to valid legacy settings when migration fails", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "sleep");
		symlinkSync("missing-caffeinate-settings-target", path.join(agentDir, NEW_SETTINGS_FILE));
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /migration failed/i);
		assert.match(notifications[0]?.message ?? "", /legacy file was used for this session/i);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Mode: system-awake/);
	});
});

test("caffeinate prefers new settings created while legacy settings are loading", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "sleep");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0]?.({}, ctx);
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display");
		await sessionStart;

		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Mode: display-awake/);
	});
});

test("caffeinate prefers new settings when both files exist and reports legacy ignored", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display");
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "sleep");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		const statusMessage = notifications.at(-1)?.message ?? "";
		assert.match(statusMessage, /Mode: display-awake/);
		assert.match(statusMessage, /Settings: .*pi-caffeinate\.json/);
		assert.match(statusMessage, /legacy settings ignored/i);
	});
});

test("caffeinate does not fall back to legacy settings when the new file is invalid", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeFileSync(
			path.join(agentDir, NEW_SETTINGS_FILE),
			JSON.stringify({ mode: "bad", updatedAt: 1 }),
		);
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "sleep");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /pi-caffeinate\.json/);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Mode: display-awake/);
	});
});

test("caffeinate ignores invalid legacy settings without creating the new file", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeFileSync(
			path.join(agentDir, LEGACY_SETTINGS_FILE),
			JSON.stringify({ mode: "bad", updatedAt: 1 }),
		);
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /settings ignored/i);
		assert.match(notifications[0]?.message ?? "", /pi-caffeinate-settings\.json/);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Mode: display-awake/);
	});
});

test("caffeinate saves mode only to the new settings file and preserves quiet mode", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "display");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.commands.get("caffeinate")?.handler("sleep", ctx);

		const savedSettings = readSettings(agentDir, NEW_SETTINGS_FILE);
		assert.equal(savedSettings.mode, "sleep");
		assert.equal(savedSettings.quiet, true);
		assert.equal(typeof savedSettings.updatedAt, "number");
		assert.equal(readSettings(agentDir, LEGACY_SETTINGS_FILE).mode, "display");
		assert.match(notifications.at(-1)?.message ?? "", /mode set to system-awake and saved/);
	});
});

test("quiet mode keeps lifecycle and status active without routine notifications", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		process.env.PI_CAFFEINATE_COMMAND = longRunningCustomCommand();
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications, statuses } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.events.get("agent_start")?.[0]?.({}, ctx);
		const activeStatus = statuses.get("caffeinate");
		await mock.events.get("agent_end")?.[0]?.({}, ctx);

		assert.equal(notifications.length, 0);
		assert.equal(activeStatus, "custom");
		assert.equal(statuses.get("caffeinate"), undefined);
	});
});

test("quiet mode preserves explicit command feedback", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		process.env.PI_CAFFEINATE_COMMAND = longRunningCustomCommand();
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.events.get("agent_start")?.[0]?.({}, ctx);
		await mock.commands.get("caffeinate")?.handler("status", ctx);
		await mock.commands.get("caffeinate")?.handler("stop", ctx);

		assert.match(notifications[0]?.message ?? "", /Quiet mode: enabled/);
		assert.match(notifications[1]?.message ?? "", /Released pi-caffeinate \(manual stop\)/);
	});
});

test("quiet mode preserves inhibitor failure warnings", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		process.env.PI_CAFFEINATE_COMMAND = customNodeCommand("setTimeout(()=>process.exit(7),20)");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications, statuses } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.events.get("agent_start")?.[0]?.({}, ctx);
		await waitFor(() => notifications.length > 0 && statuses.get("caffeinate") === "unavailable");

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "warning");
		assert.match(notifications[0]?.message ?? "", /exited unexpectedly \(code 7\)/);
		assert.equal(statuses.get("caffeinate"), "unavailable");
	});
});

test("default settings keep routine lifecycle notifications", async () => {
	await withTempAgentDir(async () => {
		process.env.PI_CAFFEINATE_COMMAND = longRunningCustomCommand();
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.events.get("agent_start")?.[0]?.({}, ctx);
		await mock.events.get("agent_end")?.[0]?.({}, ctx);

		assert.deepEqual(
			notifications.map(({ message, level }) => ({ message, level })),
			[
				{ message: "Keeping computer awake (custom).", level: "info" },
				{ message: "Released pi-caffeinate (agent finished).", level: "info" },
			],
		);
	});
});

let importCounter = 0;

async function importFreshCaffeinate() {
	return (await import(
		`../src/caffeinate.js?settings-test=${Date.now()}-${importCounter++}`
	)) as typeof import("../src/caffeinate.js");
}

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousDisabled = process.env.PI_CAFFEINATE_DISABLED;
	const previousIcon = process.env.PI_CAFFEINATE_ICON;
	const previousCommand = process.env.PI_CAFFEINATE_COMMAND;
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-caffeinate-settings-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CAFFEINATE_DISABLED;
	delete process.env.PI_CAFFEINATE_ICON;
	delete process.env.PI_CAFFEINATE_COMMAND;
	try {
		return await fn(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousDisabled === undefined) delete process.env.PI_CAFFEINATE_DISABLED;
		else process.env.PI_CAFFEINATE_DISABLED = previousDisabled;
		if (previousIcon === undefined) delete process.env.PI_CAFFEINATE_ICON;
		else process.env.PI_CAFFEINATE_ICON = previousIcon;
		if (previousCommand === undefined) delete process.env.PI_CAFFEINATE_COMMAND;
		else process.env.PI_CAFFEINATE_COMMAND = previousCommand;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function writeSettings(agentDir: string, fileName: string, mode: string, quiet?: boolean) {
	writeFileSync(
		path.join(agentDir, fileName),
		JSON.stringify({ mode, ...(quiet === undefined ? {} : { quiet }), updatedAt: 1 }),
	);
}

function readSettings(agentDir: string, fileName: string) {
	return JSON.parse(readFileSync(path.join(agentDir, fileName), "utf8")) as {
		mode: string;
		quiet?: boolean;
		updatedAt: number;
	};
}

function longRunningCustomCommand() {
	return customNodeCommand("setInterval(()=>{},1000)");
}

function customNodeCommand(script: string) {
	const executable = process.execPath.replaceAll("\\", "/");
	return `${JSON.stringify(executable)} -e ${JSON.stringify(script)}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
