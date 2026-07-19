import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readEffectivePiImageSettings } from "../src/pi-settings.js";

test("WebUI reports a malformed Pi images settings object", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-webui-pi-settings-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ images: "invalid" }));
		const settings = await readEffectivePiImageSettings(cwd, false);
		assert.equal(settings.autoResize, true);
		assert.equal(settings.blockImages, false);
		assert.match(settings.warnings.join("\n"), /invalid Pi images settings/i);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
