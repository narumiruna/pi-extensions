import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	normalizePlanModeSettings,
	readPlanModeSettings,
	updatePlanModeSettings,
} from "../src/settings.js";

test("implementation preferences validate exact provider/model identity and thinking without changing defaults", () => {
	assert.deepEqual(normalizePlanModeSettings({}), { thinkingLevel: "inherit" });
	for (const implementationModel of [
		null,
		"provider/model",
		{},
		{ provider: "p" },
		{ provider: "", id: "m" },
		{ provider: "p", id: 3 },
		{ provider: "p", id: " " },
	]) {
		assert.equal(normalizePlanModeSettings({ implementationModel }), undefined);
	}
	assert.equal(normalizePlanModeSettings({ implementationThinkingLevel: "auto" }), undefined);
	assert.deepEqual(
		normalizePlanModeSettings({
			implementationModel: { provider: "custom", id: "org/model:variant" },
			implementationThinkingLevel: "max",
		}),
		{
			thinkingLevel: "inherit",
			implementationModel: { provider: "custom", id: "org/model:variant" },
			implementationThinkingLevel: "max",
		},
	);
});

test("implementation settings preserve unknown fields, serialize patches, reset, and protect invalid/failed writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "plan-implementation-settings-"));
	const settingsPath = join(root, "settings.json");
	try {
		assert.deepEqual(await readPlanModeSettings(settingsPath), { kind: "missing" });
		await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
		await writeFile(
			settingsPath,
			JSON.stringify({
				unknown: 42,
				implementationModel: { provider: "old", id: "old", future: true },
			}),
		);
		const first = updatePlanModeSettings(
			{ implementationModel: { provider: "p", id: "m" } },
			{ settingsPath },
		);
		const second = updatePlanModeSettings(
			{ implementationThinkingLevel: "high" },
			{ settingsPath },
		);
		const loaded = await readPlanModeSettings(settingsPath);
		await Promise.all([first, second]);
		assert.equal(loaded.kind, "loaded");
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			unknown: 42,
			implementationModel: { provider: "p", id: "m", future: true },
			implementationThinkingLevel: "high",
		});
		const before = await readFile(settingsPath, "utf8");
		await assert.rejects(
			updatePlanModeSettings(
				{ implementationThinkingLevel: "off" },
				{
					settingsPath,
					beforeRename: async () => {
						throw new Error("publication failed");
					},
				},
			),
			/publication failed/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), before);
		await updatePlanModeSettings(
			{ implementationModel: null, implementationThinkingLevel: "inherit" },
			{ settingsPath },
		);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			unknown: 42,
			implementationThinkingLevel: "inherit",
		});
		await writeFile(settingsPath, "{invalid");
		await assert.rejects(
			updatePlanModeSettings({ implementationModel: { provider: "p", id: "m" } }, { settingsPath }),
			/invalid/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), "{invalid");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
