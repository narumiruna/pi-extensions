import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEffectivePiImageSettings } from "../src/pi-settings.js";

test("Pi image settings merge trusted project values over global values", async () => {
	await withDirectories(async ({ agentDir, cwd }) => {
		await writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ images: { autoResize: false, blockImages: true } }),
		);
		await mkdir(path.join(cwd, ".pi"));
		await writeFile(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ images: { blockImages: false } }),
		);
		assert.deepEqual(await readEffectivePiImageSettings(cwd, true), {
			autoResize: false,
			blockImages: false,
			warnings: [],
		});
		assert.deepEqual(await readEffectivePiImageSettings(cwd, false), {
			autoResize: false,
			blockImages: true,
			warnings: [],
		});
	});
});

test("Pi image settings default safely and report malformed values", async () => {
	await withDirectories(async ({ agentDir, cwd }) => {
		assert.deepEqual(await readEffectivePiImageSettings(cwd, true), {
			autoResize: true,
			blockImages: false,
			warnings: [],
		});
		await writeFile(path.join(agentDir, "settings.json"), '{"images":{"autoResize":"yes"}}');
		const invalidField = await readEffectivePiImageSettings(cwd, true);
		assert.equal(invalidField.autoResize, true);
		assert.match(invalidField.warnings.join("\n"), /non-boolean images\.autoResize/i);
		await writeFile(path.join(agentDir, "settings.json"), "{");
		const malformed = await readEffectivePiImageSettings(cwd, true);
		assert.deepEqual(
			{ autoResize: malformed.autoResize, blockImages: malformed.blockImages },
			{ autoResize: true, blockImages: false },
		);
		assert.match(malformed.warnings.join("\n"), /could not parse/i);
	});
});

test("Pi image settings are re-read after a mid-session change", async () => {
	await withDirectories(async ({ agentDir, cwd }) => {
		const settingsPath = path.join(agentDir, "settings.json");
		await writeFile(settingsPath, '{"images":{"autoResize":true}}');
		assert.equal((await readEffectivePiImageSettings(cwd, false)).autoResize, true);
		await writeFile(settingsPath, '{"images":{"autoResize":false}}');
		assert.equal((await readEffectivePiImageSettings(cwd, false)).autoResize, false);
	});
});

async function withDirectories(
	run: (paths: { agentDir: string; cwd: string }) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-pi-settings-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run({ agentDir, cwd });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}
