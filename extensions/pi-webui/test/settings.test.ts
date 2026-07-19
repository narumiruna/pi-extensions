import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_IMAGE_LIMITS, IMAGE_HARD_LIMITS } from "../src/image-limits.js";
import {
	DEFAULT_SETTINGS,
	initializeSettings,
	loadSettings,
	normalizeSettings,
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

test("image limit normalization preserves defaults and accepts exact hard boundaries", () => {
	assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
	assert.deepEqual(normalizeSettings(IMAGE_HARD_LIMITS), {
		...DEFAULT_SETTINGS,
		...IMAGE_HARD_LIMITS,
	});
	for (const key of Object.keys(DEFAULT_IMAGE_LIMITS)) {
		assert.equal(normalizeSettings({ [key]: 1.5 }), undefined);
		assert.equal(normalizeSettings({ [key]: 0 }), undefined);
		assert.equal(
			normalizeSettings({ [key]: IMAGE_HARD_LIMITS[key as keyof typeof IMAGE_HARD_LIMITS] + 1 }),
			undefined,
		);
	}
	assert.equal(normalizeSettings({ maxImageBytes: 20, maxBatchBytes: 10 }), undefined);
});

test("loaded limits above defaults warn while omitted values and unknown fields remain safe", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-settings-"));
	const settingsPath = path.join(directory, "pi-webui.json");
	try {
		await writeFile(
			settingsPath,
			JSON.stringify({ maxImages: DEFAULT_IMAGE_LIMITS.maxImages + 1, future: "kept" }),
		);
		const loaded = await loadSettings(settingsPath);
		assert.equal(loaded.kind, "loaded");
		assert.equal(loaded.settings.maxImages, 9);
		assert.equal(loaded.settings.maxImageBytes, DEFAULT_IMAGE_LIMITS.maxImageBytes);
		assert.match(loaded.warning ?? "", /above safe defaults.*maxImages/i);
		assert.deepEqual(loaded.document, { maxImages: 9, future: "kept" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
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
			maxImages: 8,
			maxImageBytes: 10 * 1024 * 1024,
			maxBatchBytes: 40 * 1024 * 1024,
			maxImagePixels: 50_000_000,
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
