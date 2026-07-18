import assert from "node:assert/strict";
import test from "node:test";
import { BatchStore } from "../src/batch.js";
import imageDrop from "../src/image-drop.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.js";

test("image-drop registers its command and lifecycle", () => {
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

	imageDrop(pi as never);
	assert.ok(commands.has("image-drop"));
	assert.ok(events.has("session_start"));
	assert.ok(events.has("session_shutdown"));
	assert.ok(events.has("input"));
	assert.ok(events.has("message_start"));
});

test("settings expose the agreed defaults", () => {
	assert.deepEqual(DEFAULT_SETTINGS, {
		maxImages: 8,
		maxImageBytes: 10 * 1024 * 1024,
		maxBatchBytes: 40 * 1024 * 1024,
		maxImagePixels: 50_000_000,
	});
	assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
});

test("a new batch starts empty", () => {
	const batch = new BatchStore(DEFAULT_SETTINGS);
	assert.deepEqual(batch.publicState().items, []);
	assert.equal(batch.publicState().phase, "empty");
});
