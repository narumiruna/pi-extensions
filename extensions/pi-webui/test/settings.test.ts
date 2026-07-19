import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_SETTINGS,
	initializeSettings,
	loadSettings,
	RETENTION_HARD_LIMITS,
	saveSettings,
} from "../src/settings.js";

test("sent-image retention uses conservative opt-in defaults and finite hard ceilings", () => {
	assert.deepEqual(
		{
			retainSentImages: DEFAULT_SETTINGS.retainSentImages,
			maxRetainedImages: DEFAULT_SETTINGS.maxRetainedImages,
			maxRetainedBytes: DEFAULT_SETTINGS.maxRetainedBytes,
		},
		{ retainSentImages: false, maxRetainedImages: 32, maxRetainedBytes: 128 * 1024 * 1024 },
	);
	assert.deepEqual(RETENTION_HARD_LIMITS, {
		maxRetainedImages: 128,
		maxRetainedBytes: 512 * 1024 * 1024,
	});
});

test("settings loading distinguishes missing, valid, malformed, and invalid files", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-settings-"));
	const settingsPath = path.join(directory, "pi-webui.json");
	try {
		const missing = await loadSettings(settingsPath);
		assert.equal(missing.kind, "missing");
		assert.deepEqual(missing.settings, DEFAULT_SETTINGS);
		assert.equal(missing.source, "defaults");

		await writeFile(settingsPath, '{"startOnSessionStart":true,"future":"kept"}\n');
		const loaded = await loadSettings(settingsPath);
		assert.equal(loaded.kind, "loaded");
		assert.deepEqual(loaded.settings, { ...DEFAULT_SETTINGS, startOnSessionStart: true });
		assert.deepEqual(loaded.document, { startOnSessionStart: true, future: "kept" });
		assert.equal(loaded.source, "settings file");

		await writeFile(settingsPath, "{broken\n");
		const malformed = await loadSettings(settingsPath);
		assert.equal(malformed.kind, "invalid");
		assert.deepEqual(malformed.settings, DEFAULT_SETTINGS);
		assert.match(malformed.warning ?? "", /ignored.*using defaults/i);

		await writeFile(settingsPath, '{"startOnSessionStart":"yes"}\n');
		const invalid = await loadSettings(settingsPath);
		assert.equal(invalid.kind, "invalid");
		assert.deepEqual(invalid.settings, DEFAULT_SETTINGS);
		assert.match(invalid.warning ?? "", /invalid type or limit/i);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("saving is atomic and preserves unknown fields", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-settings-"));
	const settingsPath = path.join(directory, "pi-webui.json");
	try {
		await writeFile(settingsPath, '{"future":{"enabled":true},"startOnSessionStart":false}\n');
		const loaded = await loadSettings(settingsPath);
		assert.equal(loaded.kind, "loaded");
		await saveSettings(
			{ ...DEFAULT_SETTINGS, startOnSessionStart: true },
			loaded.document ?? {},
			settingsPath,
		);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			future: { enabled: true },
			startOnSessionStart: true,
			retainSentImages: false,
			maxRetainedImages: 32,
			maxRetainedBytes: 128 * 1024 * 1024,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed atomic publish keeps the previous settings file", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-settings-"));
	const settingsPath = path.join(directory, "pi-webui.json");
	const original = '{"startOnSessionStart":false,"future":1}\n';
	try {
		await writeFile(settingsPath, original);
		await assert.rejects(
			() =>
				saveSettings(
					{ ...DEFAULT_SETTINGS, startOnSessionStart: true },
					{ future: 1 },
					settingsPath,
					{
						rename: async () => {
							throw new Error("publish failed");
						},
					},
				),
			/publish failed/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), original);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed temporary write leaves the previous settings file untouched", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-settings-"));
	const settingsPath = path.join(directory, "pi-webui.json");
	const original = '{"startOnSessionStart":false}\n';
	try {
		await writeFile(settingsPath, original);
		await assert.rejects(
			() =>
				saveSettings({ ...DEFAULT_SETTINGS, startOnSessionStart: true }, {}, settingsPath, {
					write: async () => {
						throw new Error("write failed");
					},
				}),
			/write failed/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), original);
		assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(directory)), [
			"pi-webui.json",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("init creates formatted defaults once and never overwrites existing content", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-settings-"));
	const settingsPath = path.join(directory, "pi-webui.json");
	try {
		assert.equal(await initializeSettings(settingsPath), "created");
		assert.equal(
			await readFile(settingsPath, "utf8"),
			`${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`,
		);
		await writeFile(settingsPath, "{invalid but owned}\n");
		assert.equal(await initializeSettings(settingsPath), "exists");
		assert.equal(await readFile(settingsPath, "utf8"), "{invalid but owned}\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed init publish leaves no canonical or temporary file", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-settings-"));
	const settingsPath = path.join(directory, "pi-webui.json");
	try {
		await assert.rejects(
			() =>
				initializeSettings(settingsPath, {
					link: async () => {
						throw new Error("publish failed");
					},
				}),
			/publish failed/,
		);
		await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
		assert.deepEqual(
			await import("node:fs/promises").then(({ readdir }) => readdir(directory)),
			[],
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
