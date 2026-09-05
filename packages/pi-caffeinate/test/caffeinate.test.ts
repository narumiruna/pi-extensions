import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { createMockContext, createMockPi, driveCustomSelector } from "../../../test/support.js";
import caffeinate, {
	commandCompletions,
	formatMode,
	getInhibitorCommand,
	normalizeCaffeinateSettings,
	parseCommand,
	splitCommand,
	windowsInhibitorScript,
} from "../src/caffeinate.js";
import type { DbusScreenSaverClient, DbusScreenSaverFactory } from "../src/dbus-inhibit.js";
import { saveSettings } from "../src/settings.js";

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

test("caffeinate menu uses the standard horizontal frame", async () => {
	await withTempAgentDir(async () => {
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		let frame: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const driven = driveCustomSelector(factory, ["\u0003"], 40);
				frame = driven.renders[0] ?? [];
				return driven.result;
			},
		});
		caffeinateModule.default(mock.pi);

		await mock.commands.get("caffeinate")?.handler("", ctx);

		const plain = frame.map(stripVTControlCharacters);
		assert.equal(plain[0], "─".repeat(40));
		assert.equal(plain.at(-1), "─".repeat(40));
	});
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
	t.onTestFinished(() => {
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

test("Linux display mode keeps logind idle and sleep inhibition alongside D-Bus", async () => {
	await withLinuxPathCommands(["systemd-inhibit"], () => {
		const command = getInhibitorCommand("display");

		assert.equal(command?.description, "systemd-inhibit (display-awake)");
		assert.ok(command?.args.includes("--what=idle:sleep"));
		assert.equal(command?.addDbusIdleInhibit, true);
	});
});

test("Linux sleep mode uses only the systemd sleep blocker", async () => {
	await withLinuxPathCommands(["systemd-inhibit"], () => {
		const command = getInhibitorCommand("sleep");

		assert.equal(command?.description, "systemd-inhibit (system-awake)");
		assert.ok(command?.args.includes("--what=sleep"));
		assert.equal(command?.addDbusIdleInhibit, undefined);
	});
});

test("D-Bus idle inhibit handles transport errors and falls back to the niri path", async () => {
	const calls: Array<{ member?: string; path?: string; body?: unknown[] }> = [];
	const connection = new EventEmitter();
	let closeCalls = 0;
	vi.resetModules();
	vi.doMock("dbus-native", () => ({
		sessionBus: () => ({
			connection,
			invoke(
				message: { member?: string; path?: string; body?: unknown[] },
				optionsOrCallback:
					| { signal?: AbortSignal; timeout?: number }
					| ((error: Error | null, value?: number) => void),
				maybeCallback?: (error: Error | null, value?: number) => void,
			) {
				const callback =
					typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
				assert.ok(callback);
				calls.push(message);
				if (message.member === "Inhibit" && message.path === "/org/freedesktop/ScreenSaver") {
					callback(new Error("Unknown object"));
					return;
				}
				callback(null, message.member === "Inhibit" ? 42 : undefined);
			},
			async close() {
				closeCalls += 1;
			},
		}),
	}));

	try {
		const { defaultDbusScreenSaverFactory } = await import("../src/dbus-inhibit.js");
		const client = await defaultDbusScreenSaverFactory();
		assert.doesNotThrow(() => connection.emit("error", new Error("session bus unavailable")));
		await client.inhibit("test");
		await client.uninhibit();
		await client.close();

		assert.deepEqual(
			calls.map(({ member, path, body }) => ({ member, path, body })),
			[
				{
					member: "Inhibit",
					path: "/org/freedesktop/ScreenSaver",
					body: ["pi-caffeinate", "test"],
				},
				{
					member: "Inhibit",
					path: "/ScreenSaver",
					body: ["pi-caffeinate", "test"],
				},
				{ member: "UnInhibit", path: "/ScreenSaver", body: [42] },
			],
		);
		assert.equal(closeCalls, 1);
	} finally {
		vi.doUnmock("dbus-native");
		vi.resetModules();
	}
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

test("session reload applies quiet mode and clears an active status", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display");
		process.env.PI_CAFFEINATE_COMMAND = longRunningCustomCommand();
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications, statuses } = createMockContext();

		caffeinateModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0];
		await sessionStart?.({ reason: "startup" }, ctx);
		await mock.events.get("agent_start")?.[0]?.({}, ctx);
		assert.equal(statuses.get("caffeinate"), "custom");

		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		await sessionStart?.({ reason: "reload" }, ctx);
		const quietStatus = statuses.get("caffeinate");

		await mock.commands.get("caffeinate")?.handler("status", ctx);
		const statusMessage = notifications.at(-1)?.message ?? "";
		await mock.events.get("agent_end")?.[0]?.({}, ctx);

		assert.equal(quietStatus, undefined);
		assert.match(statusMessage, /pi-caffeinate is active/);
		assert.match(statusMessage, /Quiet mode: enabled/);
	});
});

test("caffeinate reads legacy-only settings without modifying either path", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "sleep");
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
		assert.deepEqual(readSettings(agentDir, LEGACY_SETTINGS_FILE), {
			mode: "sleep",
			updatedAt: 1,
		});
		assert.match(notifications[0]?.message ?? "", /using legacy/i);
		assert.match(notifications[0]?.message ?? "", /rename.*pi-caffeinate\.json/i);

		await mock.commands.get("caffeinate")?.handler("status", ctx);
		const statusMessage = notifications.at(-1)?.message ?? "";
		assert.match(statusMessage, /Mode: system-awake/);
		assert.match(statusMessage, /Settings note: .*using legacy/i);
	});
});

test("caffeinate reads valid legacy settings beside a missing canonical symlink target", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, "sleep");
		symlinkSync("missing-caffeinate-settings-target", path.join(agentDir, NEW_SETTINGS_FILE));
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /using legacy/i);
		assert.match(notifications[0]?.message ?? "", /without modifying the legacy file/i);
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
		writeFileSync(
			path.join(agentDir, NEW_SETTINGS_FILE),
			JSON.stringify({ mode: "display", quiet: true, updatedAt: 1, future: { kept: true } }),
		);
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
		assert.deepEqual(savedSettings.future, { kept: true });
		assert.equal(readSettings(agentDir, LEGACY_SETTINGS_FILE).mode, "display");
		assert.match(notifications.at(-1)?.message ?? "", /mode set to system-awake and saved/);
	});
});

test("caffeinate failed publication preserves the prior file and removes its temporary", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const original = readFileSync(settingsPath, "utf8");

		await assert.rejects(
			saveSettings(
				{ mode: "sleep", updatedAt: 2 },
				{ rename: async () => Promise.reject(new Error("publish failed")) },
			),
			/publish failed/,
		);

		assert.equal(readFileSync(settingsPath, "utf8"), original);
		assert.deepEqual(readdirSync(agentDir), [NEW_SETTINGS_FILE]);
	});
});

test("caffeinate legacy-seeded saves preserve canonical settings created before publication", async () => {
	await withTempAgentDir(async (agentDir) => {
		const legacyPath = path.join(agentDir, LEGACY_SETTINGS_FILE);
		const canonicalPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const legacy = JSON.stringify({ mode: "display", quiet: true, updatedAt: 1, legacy: true });
		const concurrent = JSON.stringify({ mode: "display", quiet: false, updatedAt: 2, newer: true });
		writeFileSync(legacyPath, legacy);

		await assert.rejects(
			saveSettings(
				{ mode: "sleep", updatedAt: 3 },
				{
					write: async (temporaryPath, data) => {
						writeFileSync(temporaryPath, data);
						writeFileSync(canonicalPath, concurrent);
					},
				},
			),
			/created concurrently.*retry/i,
		);

		assert.equal(readFileSync(canonicalPath, "utf8"), concurrent);
		assert.equal(readFileSync(legacyPath, "utf8"), legacy);
		assert.deepEqual(
			readdirSync(agentDir).sort(),
			[LEGACY_SETTINGS_FILE, NEW_SETTINGS_FILE].sort(),
		);
	});
});

test("caffeinate mode saves preserve a newer quiet setting", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", false);
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx } = createMockContext();
		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		writeFileSync(
			path.join(agentDir, NEW_SETTINGS_FILE),
			JSON.stringify({ mode: "display", quiet: true, updatedAt: 2, future: 2 }),
		);

		await mock.commands.get("caffeinate")?.handler("sleep", ctx);

		const saved = readSettings(agentDir, NEW_SETTINGS_FILE);
		assert.equal(saved.mode, "sleep");
		assert.equal(saved.quiet, true);
		assert.equal(saved.future, 2);
	});
});

test("caffeinate refuses to overwrite invalid settings when changing mode", async () => {
	await withTempAgentDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const invalid = '{"mode":"invalid","future":"preserved"}\n';
		writeFileSync(settingsPath, invalid);
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx, notifications } = createMockContext();

		caffeinateModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.commands.get("caffeinate")?.handler("sleep", ctx);

		assert.equal(readFileSync(settingsPath, "utf8"), invalid);
		assert.match(notifications.at(-1)?.message ?? "", /not saved/i);

		writeSettings(agentDir, NEW_SETTINGS_FILE, "display");
		await mock.commands.get("caffeinate")?.handler("sleep", ctx);
		assert.equal(readSettings(agentDir, NEW_SETTINGS_FILE).mode, "sleep");
	});
});

test("caffeinate serializes rapid mode saves in invocation order", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, "display", true);
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const { ctx } = createMockContext();
		caffeinateModule.default(mock.pi);

		const first = mock.commands.get("caffeinate")?.handler("sleep", ctx);
		const second = mock.commands.get("caffeinate")?.handler("display", ctx);
		await Promise.all([first, second]);

		assert.equal(readSettings(agentDir, NEW_SETTINGS_FILE).mode, "display");
		assert.equal(readSettings(agentDir, NEW_SETTINGS_FILE).quiet, true);
	});
});

test("quiet mode keeps the inhibitor active without lifecycle UI output", async () => {
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
		const lifecycleNotificationCount = notifications.length;

		await mock.commands.get("caffeinate")?.handler("status", ctx);
		const statusMessage = notifications[0]?.message ?? "";
		const statusAfterCommand = statuses.get("caffeinate");
		await mock.events.get("agent_end")?.[0]?.({}, ctx);

		assert.equal(lifecycleNotificationCount, 0);
		assert.equal(activeStatus, undefined);
		assert.match(statusMessage, /pi-caffeinate is active/);
		assert.equal(statusAfterCommand, undefined);
		assert.equal(notifications.length, 1);
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
		await waitFor(() => notifications.length > 0);

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.level, "warning");
		assert.match(notifications[0]?.message ?? "", /exited unexpectedly \(code 7\)/);
		assert.equal(statuses.get("caffeinate"), undefined);
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

test("Linux D-Bus-only display mode reports its missing system-sleep backend", async () => {
	await withLinuxPathCommands([], async () => {
		await withTempAgentDir(async () => {
			const clients: FakeDbusClient[] = [];
			const caffeinateModule = await importFreshCaffeinate();
			const mock = createMockPi();
			const { ctx, notifications, statuses } = createMockContext();

			caffeinateModule.default(mock.pi, { dbusFactory: fakeDbusFactory(clients) });
			await mock.events.get("session_start")?.[0]?.({}, ctx);
			await mock.events.get("agent_start")?.[0]?.({}, ctx);

			assert.equal(clients.length, 1);
			assert.deepEqual(clients[0]?.inhibitCalls, ["Pi agent is running"]);
			assert.equal(statuses.get("caffeinate"), "display-awake");
			assert.equal(notifications[0]?.level, "warning");
			assert.match(notifications[0]?.message ?? "", /partially active/);
			assert.match(notifications[0]?.message ?? "", /system sleep inhibitor/i);

			await mock.events.get("agent_end")?.[0]?.({}, ctx);

			assert.equal(clients[0]?.uninhibitCalls, 1);
			assert.equal(clients[0]?.closeCalls, 1);
			assert.equal(statuses.get("caffeinate"), undefined);
		});
	});
});

test("Linux display mode keeps the sleep blocker when D-Bus is unavailable", async () => {
	await withLinuxPathCommands(["sh", "systemd-inhibit"], async () => {
		await withTempAgentDir(async () => {
			const caffeinateModule = await importFreshCaffeinate();
			const mock = createMockPi();
			const { ctx, notifications, statuses } = createMockContext();

			caffeinateModule.default(mock.pi, {
				dbusFactory: async () => {
					throw new Error("no ScreenSaver service");
				},
			});
			await mock.events.get("session_start")?.[0]?.({}, ctx);
			await mock.events.get("agent_start")?.[0]?.({}, ctx);

			assert.equal(statuses.get("caffeinate"), "display-awake");
			assert.match(notifications.at(-1)?.message ?? "", /partially active/);
			assert.match(notifications.at(-1)?.message ?? "", /no ScreenSaver service/);

			await mock.events.get("agent_end")?.[0]?.({}, ctx);
		});
	});
});

test("agent_end aborts and closes an in-flight D-Bus acquisition before returning", async () => {
	await withLinuxPathCommands([], async () => {
		await withTempAgentDir(async () => {
			const clients: FakeDbusClient[] = [];
			let releaseInhibit: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				releaseInhibit = resolve;
			});
			const caffeinateModule = await importFreshCaffeinate();
			const mock = createMockPi();
			const { ctx, statuses } = createMockContext();

			caffeinateModule.default(mock.pi, {
				dbusFactory: fakeDbusFactory(clients, gate),
			});
			await mock.events.get("session_start")?.[0]?.({}, ctx);
			const startPromise = mock.events.get("agent_start")?.[0]?.({}, ctx);
			await waitFor(() => clients[0]?.inhibitCalls.length === 1);
			try {
				await mock.events.get("agent_end")?.[0]?.({}, ctx);
				assert.equal(clients[0]?.inhibitSignal?.aborted, true);
				assert.equal(clients[0]?.closeCalls, 1);
			} finally {
				releaseInhibit?.();
				await startPromise;
			}

			assert.equal(clients[0]?.uninhibitCalls, 0);
			assert.equal(clients[0]?.closeCalls, 1);
			assert.equal(statuses.get("caffeinate"), undefined);
		});
	});
});

test("session_shutdown aborts and closes an in-flight D-Bus acquisition", async () => {
	await withLinuxPathCommands([], async () => {
		await withTempAgentDir(async () => {
			const clients: FakeDbusClient[] = [];
			let releaseInhibit: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				releaseInhibit = resolve;
			});
			const caffeinateModule = await importFreshCaffeinate();
			const mock = createMockPi();
			const { ctx, statuses } = createMockContext();

			caffeinateModule.default(mock.pi, {
				dbusFactory: fakeDbusFactory(clients, gate),
			});
			await mock.events.get("session_start")?.[0]?.({}, ctx);
			const startPromise = mock.events.get("agent_start")?.[0]?.({}, ctx);
			await waitFor(() => clients[0]?.inhibitCalls.length === 1);
			try {
				await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
				assert.equal(clients[0]?.inhibitSignal?.aborted, true);
				assert.equal(clients[0]?.closeCalls, 1);
				assert.equal(statuses.get("caffeinate"), undefined);
			} finally {
				releaseInhibit?.();
				await startPromise;
			}
		});
	});
});

test("an active child failure after session replacement updates only the current context", async () => {
	await withTempAgentDir(async (agentDir) => {
		const releasePath = path.join(agentDir, "release-inhibitor");
		process.env.PI_CAFFEINATE_COMMAND = customNodeCommand(
			`const fs=require("node:fs");setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)}))process.exit(7)},10)`,
		);
		const caffeinateModule = await importFreshCaffeinate();
		const mock = createMockPi();
		const original = createMockContext();
		const replacement = createMockContext();

		caffeinateModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0];
		await sessionStart?.({ reason: "startup" }, original.ctx);
		await mock.events.get("agent_start")?.[0]?.({}, original.ctx);
		const originalNotificationCount = original.notifications.length;
		assert.equal(original.statuses.get("caffeinate"), "custom");

		await sessionStart?.({ reason: "replacement" }, replacement.ctx);
		writeFileSync(releasePath, "release");
		await waitFor(() => replacement.notifications.length > 0);

		assert.equal(original.notifications.length, originalNotificationCount);
		assert.equal(original.statuses.get("caffeinate"), "custom");
		assert.equal(replacement.notifications.at(-1)?.level, "warning");
		assert.match(replacement.notifications.at(-1)?.message ?? "", /exited unexpectedly \(code 7\)/);
		assert.equal(replacement.statuses.get("caffeinate"), "unavailable");
		await mock.events.get("agent_end")?.[0]?.({}, replacement.ctx);
	});
});

test("an active D-Bus failure after session replacement updates only the current context", async () => {
	await withLinuxPathCommands([], async () => {
		await withTempAgentDir(async () => {
			const clients: FakeDbusClient[] = [];
			const caffeinateModule = await importFreshCaffeinate();
			const mock = createMockPi();
			const original = createMockContext();
			const replacement = createMockContext();

			caffeinateModule.default(mock.pi, { dbusFactory: fakeDbusFactory(clients) });
			const sessionStart = mock.events.get("session_start")?.[0];
			await sessionStart?.({ reason: "startup" }, original.ctx);
			await mock.events.get("agent_start")?.[0]?.({}, original.ctx);
			const originalNotificationCount = original.notifications.length;
			assert.equal(original.statuses.get("caffeinate"), "display-awake");

			await sessionStart?.({ reason: "replacement" }, replacement.ctx);
			clients[0]?.fail(new Error("session bus disconnected"));

			assert.equal(original.notifications.length, originalNotificationCount);
			assert.equal(original.statuses.get("caffeinate"), "display-awake");
			assert.equal(replacement.notifications.at(-1)?.level, "warning");
			assert.match(replacement.notifications.at(-1)?.message ?? "", /session bus disconnected/);
			assert.equal(replacement.statuses.get("caffeinate"), "unavailable");
			await mock.events.get("agent_end")?.[0]?.({}, replacement.ctx);
		});
	});
});

test("an active D-Bus transport failure makes D-Bus-only mode unavailable", async () => {
	await withLinuxPathCommands([], async () => {
		await withTempAgentDir(async () => {
			const clients: FakeDbusClient[] = [];
			const caffeinateModule = await importFreshCaffeinate();
			const mock = createMockPi();
			const { ctx, notifications, statuses } = createMockContext();

			caffeinateModule.default(mock.pi, { dbusFactory: fakeDbusFactory(clients) });
			await mock.events.get("session_start")?.[0]?.({}, ctx);
			await mock.events.get("agent_start")?.[0]?.({}, ctx);
			clients[0]?.fail(new Error("session bus disconnected"));

			assert.equal(statuses.get("caffeinate"), "unavailable");
			assert.equal(notifications.at(-1)?.level, "warning");
			assert.match(notifications.at(-1)?.message ?? "", /session bus disconnected/);
			await mock.commands.get("caffeinate")?.handler("status", ctx);
			assert.match(notifications.at(-1)?.message ?? "", /pi-caffeinate is unavailable/);

			await mock.events.get("agent_end")?.[0]?.({}, ctx);
		});
	});
});

test("an active D-Bus transport failure preserves the system sleep blocker", async () => {
	await withLinuxPathCommands(["sh", "systemd-inhibit"], async () => {
		await withTempAgentDir(async () => {
			const clients: FakeDbusClient[] = [];
			const caffeinateModule = await importFreshCaffeinate();
			const mock = createMockPi();
			const { ctx, notifications, statuses } = createMockContext();

			caffeinateModule.default(mock.pi, { dbusFactory: fakeDbusFactory(clients) });
			await mock.events.get("session_start")?.[0]?.({}, ctx);
			await mock.events.get("agent_start")?.[0]?.({}, ctx);
			clients[0]?.fail(new Error("session bus disconnected"));

			assert.equal(statuses.get("caffeinate"), "display-awake");
			assert.equal(notifications.at(-1)?.level, "warning");
			assert.match(notifications.at(-1)?.message ?? "", /partially active/);
			assert.match(notifications.at(-1)?.message ?? "", /session bus disconnected/);

			await mock.events.get("agent_end")?.[0]?.({}, ctx);
			assert.equal(statuses.get("caffeinate"), undefined);
		});
	});
});

async function importFreshCaffeinate() {
	vi.resetModules();
	return import("../src/caffeinate.js");
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

async function withLinuxPathCommands<T>(commands: string[], fn: () => T | Promise<T>) {
	const previousPath = process.env.PATH;
	const previousCommand = process.env.PI_CAFFEINATE_COMMAND;
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	const binDir = mkdtempSync(path.join(os.tmpdir(), "pi-caffeinate-bin-"));

	try {
		for (const command of commands) {
			const file = path.join(binDir, command);
			if (command === "sh") {
				const shell = process.env.SHELL;
				if (!shell) throw new Error("SHELL is required for inhibitor lifecycle tests");
				symlinkSync(shell, file);
				continue;
			}
			writeFileSync(file, "#!/usr/bin/env sh\nwhile :; do :; done\n");
			chmodSync(file, 0o755);
		}
		Object.defineProperty(process, "platform", { value: "linux" });
		process.env.PATH = binDir;
		delete process.env.PI_CAFFEINATE_COMMAND;
		return await fn();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCommand === undefined) delete process.env.PI_CAFFEINATE_COMMAND;
		else process.env.PI_CAFFEINATE_COMMAND = previousCommand;
		rmSync(binDir, { recursive: true, force: true });
	}
}

class FakeDbusClient implements DbusScreenSaverClient {
	readonly inhibitCalls: string[] = [];
	inhibitSignal?: AbortSignal;
	uninhibitCalls = 0;
	closeCalls = 0;
	private failureHandler?: (error: Error) => void;

	constructor(private readonly inhibitResult: Promise<void> = Promise.resolve()) {}

	setFailureHandler(handler: ((error: Error) => void) | undefined): void {
		this.failureHandler = handler;
	}

	async inhibit(reason: string, signal?: AbortSignal): Promise<void> {
		this.inhibitCalls.push(reason);
		this.inhibitSignal = signal;
		await this.inhibitResult;
	}

	async uninhibit(): Promise<void> {
		this.uninhibitCalls += 1;
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}

	fail(error: Error): void {
		this.failureHandler?.(error);
	}
}

function fakeDbusFactory(
	clients: FakeDbusClient[],
	inhibitResult: Promise<void> = Promise.resolve(),
): DbusScreenSaverFactory {
	return async () => {
		const client = new FakeDbusClient(inhibitResult);
		clients.push(client);
		return client;
	};
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
		future?: unknown;
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
