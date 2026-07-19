import assert from "node:assert/strict";
import test from "node:test";
import webUI from "../src/webui.js";

test("webui registers /webui and session lifecycle events", () => {
	const commands = new Map<string, unknown>();
	const events = new Map<string, unknown[]>();
	const pi = {
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		on(name: string, handler: unknown) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
	};

	webUI(pi as never);
	assert.ok(commands.has("webui"));
	for (const event of [
		"session_start",
		"session_shutdown",
		"session_tree",
		"session_info_changed",
		"message_start",
		"message_update",
		"message_end",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
		"agent_start",
		"agent_settled",
	]) {
		assert.ok(events.has(event), `missing ${event}`);
	}
});
