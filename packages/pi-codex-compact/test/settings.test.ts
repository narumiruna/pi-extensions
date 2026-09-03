import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	createCodexCompactSettingsRuntime,
	DEFAULT_CODEX_COMPACT_SETTINGS,
	loadCodexCompactSettings,
	normalizeCodexCompactSettings,
} from "../src/settings.js";

const temporaryDirectories: string[] = [];

async function tempSettingsPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-compact-test-"));
	temporaryDirectories.push(directory);
	return join(directory, "pi-codex-compact.json");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("normalizes defaults and bounded user settings", () => {
	assert.deepEqual(normalizeCodexCompactSettings({}), DEFAULT_CODEX_COMPACT_SETTINGS);
	assert.deepEqual(
		normalizeCodexCompactSettings({
			enabled: false,
			protocol: "responses-compact",
			maxRetries: 0,
		}),
		{
			...DEFAULT_CODEX_COMPACT_SETTINGS,
			enabled: false,
			protocol: "responses-compact",
			maxRetries: 0,
		},
	);
	assert.equal(normalizeCodexCompactSettings({ protocol: "unknown" }), undefined);
	assert.equal(normalizeCodexCompactSettings({ maxRetries: 3 }), undefined);
	assert.equal(normalizeCodexCompactSettings({ requestTimeoutMs: 10 }), undefined);
	assert.equal(normalizeCodexCompactSettings({ replacementTokenBudget: 1_000_000 }), undefined);
});

test("loads missing and valid files without consulting real user settings", async () => {
	const path = await tempSettingsPath();
	assert.equal((await loadCodexCompactSettings(path)).kind, "missing");
	await writeFile(path, '{"enabled":false,"futureField":"kept"}\n');
	const loaded = await loadCodexCompactSettings(path);
	assert.equal(loaded.kind, "loaded");
	assert.equal(loaded.settings.enabled, false);
	assert.equal(loaded.document?.futureField, "kept");
});

test("rejects invalid, oversized, and symbolic-link settings without overwriting", async () => {
	const path = await tempSettingsPath();
	await writeFile(path, "{invalid");
	assert.equal((await loadCodexCompactSettings(path)).kind, "invalid");
	const runtime = createCodexCompactSettingsRuntime(path);
	await runtime.reload();
	await assert.rejects(runtime.update({ enabled: false }), /Cannot overwrite an invalid/);
	assert.equal(await readFile(path, "utf8"), "{invalid");

	const oversized = await tempSettingsPath();
	await writeFile(oversized, JSON.stringify({ padding: "x".repeat(70 * 1024) }));
	assert.match((await loadCodexCompactSettings(oversized)).issue ?? "", /64 KiB/);

	const target = await tempSettingsPath();
	const link = await tempSettingsPath();
	await writeFile(target, "{}");
	await symlink(target, link);
	assert.match((await loadCodexCompactSettings(link)).issue ?? "", /symbolic links/);
});

test("first explicit save creates a private settings file", async () => {
	const path = await tempSettingsPath();
	const runtime = createCodexCompactSettingsRuntime(path);
	await runtime.update({ enabled: false });
	assert.equal(JSON.parse(await readFile(path, "utf8")).enabled, false);
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("serialized updates reread latest content, preserve unknown fields, and publish atomically", async () => {
	const path = await tempSettingsPath();
	await writeFile(path, '{"enabled":true,"external":"first"}\n');
	const runtime = createCodexCompactSettingsRuntime(path);
	await runtime.reload();
	await writeFile(path, '{"enabled":true,"external":"newer"}\n');
	await Promise.all([runtime.update({ enabled: false }), runtime.update({ maxRetries: 0 })]);
	await runtime.flush();
	const document = JSON.parse(await readFile(path, "utf8"));
	assert.equal(document.enabled, false);
	assert.equal(document.maxRetries, 0);
	assert.equal(document.external, "newer");
	assert.deepEqual(
		(await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("aborted settings operations do not publish", async () => {
	const path = await tempSettingsPath();
	const runtime = createCodexCompactSettingsRuntime(path);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(runtime.update({ enabled: false }, controller.signal), /aborted/i);
	assert.equal((await loadCodexCompactSettings(path)).kind, "missing");
});
