import assert from "node:assert/strict";
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

test("normalizeCaffeinateSettings accepts only known modes", () => {
	assert.deepEqual(normalizeCaffeinateSettings({ mode: "sleep" }), { mode: "sleep", updatedAt: 0 });
	assert.equal(normalizeCaffeinateSettings({ mode: "display", updatedAt: "now" }), undefined);
	assert.equal(normalizeCaffeinateSettings({ mode: "screen" }), undefined);
});

test("session start warns for deprecated PI_CAFFEINATE_ICON", async (t) => {
	const original = process.env.PI_CAFFEINATE_ICON;
	t.after(() => {
		if (original === undefined) delete process.env.PI_CAFFEINATE_ICON;
		else process.env.PI_CAFFEINATE_ICON = original;
	});
	process.env.PI_CAFFEINATE_ICON = "☕";

	const mock = createMockPi();
	caffeinate(mock.pi);
	const { ctx, notifications } = createMockContext();
	const handler = mock.events.get("session_start")?.[0];

	await handler?.({}, ctx);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /PI_CAFFEINATE_ICON is deprecated/);
	assert.match(notifications[0]?.message ?? "", /still works for now/);
	assert.match(notifications[0]?.message ?? "", /If you use @narumitw\/pi-statusline/);
});

test("windowsInhibitorScript flags and formatMode labels are user-facing", () => {
	assert.match(windowsInhibitorScript("sleep"), /\[uint32\]'0x80000001'/);
	assert.match(windowsInhibitorScript("display"), /\[uint32\]'0x80000003'/);
	assert.match(windowsInhibitorScript("display"), /\[uint32\]'0x80000000'/);
	assert.equal(formatMode("sleep"), "system-awake");
	assert.equal(formatMode("display"), "display-awake");
});
