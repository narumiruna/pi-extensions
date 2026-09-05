import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	createUsageSettingsRuntime,
	DEFAULT_USAGE_SETTINGS,
	loadUsageSettings,
	normalizeUsageSettings,
} from "../src/settings.js";

const temporaryDirectories: string[] = [];

async function tempSettingsPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-usage-settings-test-"));
	temporaryDirectories.push(directory);
	return join(directory, "pi-usage.json");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("normalizes owned settings and ignores the retired xAI field", () => {
	assert.deepEqual(normalizeUsageSettings({}), DEFAULT_USAGE_SETTINGS);
	assert.deepEqual(normalizeUsageSettings({ openaiServiceTier: "priority" }), {
		openaiServiceTier: "priority",
		codexStatusResetCountdown: true,
		selectedTargets: {},
	});
	assert.deepEqual(normalizeUsageSettings({ codexFastMode: true }), {
		openaiServiceTier: "priority",
		codexStatusResetCountdown: true,
		selectedTargets: {},
	});
	assert.deepEqual(normalizeUsageSettings({ fireworksAccountId: "acme-prod" }), {
		openaiServiceTier: "default",
		codexStatusResetCountdown: true,
		selectedTargets: { fireworks: "acme-prod" },
	});
	assert.deepEqual(
		normalizeUsageSettings({
			fireworksAccountId: "legacy",
			selectedTargets: { fireworks: "current", custom: "project-1" },
		}),
		{
			openaiServiceTier: "default",
			codexStatusResetCountdown: true,
			selectedTargets: { fireworks: "current", custom: "project-1" },
		},
	);
	assert.deepEqual(normalizeUsageSettings({ xaiUsage: false }), DEFAULT_USAGE_SETTINGS);
	assert.deepEqual(normalizeUsageSettings({ xaiUsage: "retired" }), DEFAULT_USAGE_SETTINGS);
	assert.equal(normalizeUsageSettings({ codexFastMode: "true" }), undefined);
	assert.equal(normalizeUsageSettings({ fireworksAccountId: "../other" }), undefined);
	assert.equal(normalizeUsageSettings({ fireworksAccountId: "" }), undefined);
	assert.equal(normalizeUsageSettings({ selectedTargets: [] }), undefined);
	assert.equal(normalizeUsageSettings({ selectedTargets: { provider: "" } }), undefined);
	assert.equal(
		normalizeUsageSettings({ selectedTargets: { provider: "x".repeat(257) } }),
		undefined,
	);
	assert.equal(normalizeUsageSettings([]), undefined);
});

test("missing loads are side-effect free and valid loads preserve unknown fields", async () => {
	const path = await tempSettingsPath();
	const missing = await loadUsageSettings(path);
	assert.equal(missing.kind, "missing");
	assert.equal((await readdir(join(path, ".."))).length, 0);

	await writeFile(
		path,
		'{"codexFastMode":true,"fireworksAccountId":"acme","xaiUsage":false,"future":"kept"}\n',
	);
	const loaded = await loadUsageSettings(path);
	assert.equal(loaded.kind, "loaded");
	assert.equal(loaded.settings.openaiServiceTier, "priority");
	assert.equal(loaded.settings.selectedTargets.fireworks, "acme");
	assert.equal(loaded.document?.xaiUsage, false);
	assert.equal(loaded.document?.future, "kept");
});

test("malformed, invalid, oversized, and symbolic-link settings stay read-only", async () => {
	const malformedPath = await tempSettingsPath();
	await writeFile(malformedPath, "{invalid");
	const malformed = await loadUsageSettings(malformedPath);
	assert.equal(malformed.kind, "invalid");
	const runtime = createUsageSettingsRuntime(malformedPath);
	await runtime.reload();
	await assert.rejects(
		runtime.update({ openaiServiceTier: "priority" }),
		/Cannot overwrite an invalid/,
	);
	assert.equal(await readFile(malformedPath, "utf8"), "{invalid");

	const invalidPath = await tempSettingsPath();
	await writeFile(invalidPath, '{"codexFastMode":"yes"}\n');
	assert.equal((await loadUsageSettings(invalidPath)).kind, "invalid");

	const oversizedPath = await tempSettingsPath();
	await writeFile(oversizedPath, JSON.stringify({ padding: "x".repeat(70 * 1024) }));
	assert.match((await loadUsageSettings(oversizedPath)).issue ?? "", /64 KiB/);

	const target = await tempSettingsPath();
	const link = await tempSettingsPath();
	await writeFile(target, "{}");
	await symlink(target, link);
	assert.match((await loadUsageSettings(link)).issue ?? "", /symbolic links/);
});

test("the first explicit save creates a private file and preserves unknown fields", async () => {
	const path = await tempSettingsPath();
	const runtime = createUsageSettingsRuntime(path);
	await runtime.update({ openaiServiceTier: "priority" });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		openaiServiceTier: "priority",
	});
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

	await writeFile(path, '{"codexFastMode":true,"xaiUsage":false,"future":"kept"}\n');
	if (process.platform !== "win32") await chmod(path, 0o644);
	await runtime.update({ openaiServiceTier: "default" });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		openaiServiceTier: "default",
		xaiUsage: false,
		future: "kept",
	});
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("an explicit Fireworks selection atomically migrates the legacy field", async () => {
	const path = await tempSettingsPath();
	await writeFile(path, '{"fireworksAccountId":"acme","future":"kept"}\n');
	const runtime = createUsageSettingsRuntime(path);
	await runtime.reload();
	assert.equal(runtime.get().settings.selectedTargets.fireworks, "acme");
	assert.equal(JSON.parse(await readFile(path, "utf8")).fireworksAccountId, "acme");

	await runtime.updateSelectedTarget("fireworks", "beta");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		selectedTargets: { fireworks: "beta" },
		future: "kept",
	});
	assert.equal(runtime.get().settings.selectedTargets.fireworks, "beta");
});

test("target saves preserve unknown fields and legacy Fireworks data for other providers", async () => {
	const path = await tempSettingsPath();
	await writeFile(
		path,
		'{"fireworksAccountId":"acme","selectedTargets":{"other":"old"},"future":"kept"}\n',
	);
	const runtime = createUsageSettingsRuntime(path);
	await runtime.reload();
	await runtime.updateSelectedTarget("other", "new");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		fireworksAccountId: "acme",
		selectedTargets: { other: "new" },
		future: "kept",
	});
});

test("failed post-publication target checks restore the exact prior settings state", async () => {
	const path = await tempSettingsPath();
	await writeFile(path, '{"fireworksAccountId":"acme","future":"kept"}\n');
	const runtime = createUsageSettingsRuntime(path);
	await runtime.reload();
	let observedPublishedDocument: unknown;

	await assert.rejects(
		runtime.updateSelectedTarget("fireworks", "beta", undefined, async () => {
			observedPublishedDocument = JSON.parse(await readFile(path, "utf8"));
			throw new Error("credential rotated");
		}),
		/credential rotated/,
	);

	assert.deepEqual(observedPublishedDocument, {
		selectedTargets: { fireworks: "beta" },
		future: "kept",
	});
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		fireworksAccountId: "acme",
		future: "kept",
	});
	assert.equal(runtime.get().settings.selectedTargets.fireworks, "acme");
	assert.deepEqual(
		(await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
		[],
	);

	const missingPath = await tempSettingsPath();
	const missingRuntime = createUsageSettingsRuntime(missingPath);
	await assert.rejects(
		missingRuntime.updateSelectedTarget("fireworks", "beta", undefined, async () => {
			assert.equal(
				(await loadUsageSettings(missingPath)).settings.selectedTargets.fireworks,
				"beta",
			);
			throw new Error("membership changed");
		}),
		/membership changed/,
	);
	assert.equal((await loadUsageSettings(missingPath)).kind, "missing");
	assert.equal(missingRuntime.get().kind, "missing");
});

test("serialized updates reread the latest document and leave no temporary files", async () => {
	const path = await tempSettingsPath();
	await writeFile(path, '{"codexFastMode":false,"external":"first"}\n');
	const runtime = createUsageSettingsRuntime(path);
	await runtime.reload();
	await writeFile(path, '{"codexFastMode":false,"external":"newer"}\n');
	await Promise.all([
		runtime.update({ openaiServiceTier: "priority" }),
		runtime.update({ openaiServiceTier: "default" }),
	]);
	await runtime.flush();
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		openaiServiceTier: "default",
		external: "newer",
	});
	assert.deepEqual(
		(await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("reload waits for queued writes and observes the latest durable Codex value", async () => {
	const path = await tempSettingsPath();
	const runtime = createUsageSettingsRuntime(path);
	const update = runtime.update({ openaiServiceTier: "priority" });
	const reload = runtime.reload();
	await update;
	const reloaded = await reload;
	assert.equal(reloaded.settings.openaiServiceTier, "priority");
	assert.equal(JSON.parse(await readFile(path, "utf8")).openaiServiceTier, "priority");
});

test("aborted saves retain prior runtime state", async () => {
	const abortedPath = await tempSettingsPath();
	const abortedRuntime = createUsageSettingsRuntime(abortedPath);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		abortedRuntime.update({ openaiServiceTier: "priority" }, controller.signal),
		/aborted/i,
	);
	assert.equal(abortedRuntime.get().settings.openaiServiceTier, "default");
	assert.equal((await loadUsageSettings(abortedPath)).kind, "missing");
});

test("failed saves retain prior runtime state, clean up, and do not poison retries", async () => {
	const path = await tempSettingsPath();
	let rejectRename = true;
	const runtime = createUsageSettingsRuntime({
		path,
		operations: {
			rename: async (source, destination) => {
				if (rejectRename) throw new Error("rename rejected");
				await rename(source, destination);
			},
		},
	});
	await assert.rejects(runtime.update({ openaiServiceTier: "priority" }), /rename rejected/);
	assert.equal(runtime.get().settings.openaiServiceTier, "default");
	assert.equal((await loadUsageSettings(path)).kind, "missing");
	assert.deepEqual(
		(await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
		[],
	);

	rejectRename = false;
	await runtime.update({ openaiServiceTier: "priority" });
	assert.equal(runtime.get().settings.openaiServiceTier, "priority");
});

test("failed explicit target migration keeps legacy data and allows a retry", async () => {
	const path = await tempSettingsPath();
	await writeFile(path, '{"fireworksAccountId":"acme","future":"kept"}\n');
	let rejectRename = true;
	const runtime = createUsageSettingsRuntime({
		path,
		operations: {
			rename: async (source, destination) => {
				if (rejectRename) throw new Error("rename rejected");
				await rename(source, destination);
			},
		},
	});
	await runtime.reload();
	await assert.rejects(runtime.updateSelectedTarget("fireworks", "beta"), /rename rejected/);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		fireworksAccountId: "acme",
		future: "kept",
	});
	assert.equal(runtime.get().settings.selectedTargets.fireworks, "acme");

	rejectRename = false;
	await runtime.updateSelectedTarget("fireworks", "beta");
	assert.equal(runtime.get().settings.selectedTargets.fireworks, "beta");
});

test("normalizes the Codex reset countdown status preference", () => {
	assert.deepEqual(normalizeUsageSettings({ codexStatusResetCountdown: false }), {
		openaiServiceTier: "default",
		codexStatusResetCountdown: false,
		selectedTargets: {},
	});
	assert.equal(normalizeUsageSettings({ codexStatusResetCountdown: "false" }), undefined);
});
