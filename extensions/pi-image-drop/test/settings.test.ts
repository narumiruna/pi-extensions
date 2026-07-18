import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, HARD_LIMITS, loadSettings, normalizeSettings } from "../src/settings.js";

test("settings normalize partial values and reject unknown, inconsistent, and unsafe values", () => {
	assert.deepEqual(normalizeSettings({ maxImages: 4 }), { ...DEFAULT_SETTINGS, maxImages: 4 });
	assert.equal(normalizeSettings({ unknown: 1 }), undefined);
	assert.equal(normalizeSettings({ maxImages: 0 }), undefined);
	assert.equal(normalizeSettings({ maxImages: HARD_LIMITS.maxImages + 1 }), undefined);
	assert.equal(normalizeSettings({ maxImageBytes: DEFAULT_SETTINGS.maxBatchBytes + 1 }), undefined);
	assert.equal(normalizeSettings([]), undefined);
});

test("settings loading distinguishes missing, valid, warned, and invalid files", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	try {
		assert.deepEqual(await loadSettings(settingsPath), {
			kind: "missing",
			settings: { ...DEFAULT_SETTINGS },
		});
		await writeFile(settingsPath, '{"maxImages":4}\n');
		assert.deepEqual(await loadSettings(settingsPath), {
			kind: "loaded",
			settings: { ...DEFAULT_SETTINGS, maxImages: 4 },
			warning: undefined,
		});
		await writeFile(settingsPath, '{"maxImages":16}\n');
		const warned = await loadSettings(settingsPath);
		assert.equal(warned.kind, "loaded");
		assert.match("warning" in warned ? (warned.warning ?? "") : "", /raises maxImages/i);
		await writeFile(settingsPath, '{"maxImages":"many"}\n');
		const invalid = await loadSettings(settingsPath);
		assert.equal(invalid.kind, "invalid");
		assert.deepEqual(invalid.settings, DEFAULT_SETTINGS);
		assert.match("warning" in invalid ? invalid.warning : "", /using safe defaults/i);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("unreadable and symlink settings do not escape whole-file fallback", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-"));
	const target = path.join(directory, "target.json");
	const settingsPath = path.join(directory, "pi-image-drop.json");
	try {
		await writeFile(target, '{"maxImages":3}\n');
		await symlink(target, settingsPath);
		const linked = await loadSettings(settingsPath);
		assert.equal(linked.kind, "invalid");
		assert.match("warning" in linked ? linked.warning : "", /symbolic link/i);
		await rm(settingsPath);
		await writeFile(settingsPath, '{"maxImages":3}\n');
		if (process.platform === "win32" || process.getuid?.() === 0) {
			t.diagnostic("permission-denied read is not meaningful on this platform/user");
			return;
		}
		await chmod(settingsPath, 0);
		const unreadable = await loadSettings(settingsPath);
		assert.equal(unreadable.kind, "invalid");
	} finally {
		await chmod(settingsPath, 0o600).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});
