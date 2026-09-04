import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(packageDirectory, "skills", "setting-up-pi-sync", "SKILL.md");

test("package declares and publishes the pi-sync setup skill", async () => {
	const manifest = JSON.parse(
		await readFile(path.join(packageDirectory, "package.json"), "utf8"),
	) as {
		files: string[];
		pi: { extensions: string[]; skills: string[] };
	};
	const rootManifest = JSON.parse(
		await readFile(path.join(packageDirectory, "..", "..", "package.json"), "utf8"),
	) as { pi: { skills: string[] } };

	assert.deepEqual(manifest.pi.extensions, ["./dist/index.ts"]);
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.ok(manifest.files.includes("skills"));
	assert.ok(rootManifest.pi.skills.includes("./packages/pi-sync/skills"));
});

test("Pi validates the bundled setup skill without diagnostics", async () => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "pi-sync-skill-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageDirectory] }),
			additionalSkillPaths: [skillPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const skills = loader.getSkills();
		assert.deepEqual(skills.diagnostics, []);
		assert.deepEqual(
			skills.skills.map(({ name }) => name),
			["setting-up-pi-sync"],
		);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("setup guidance protects secrets and requires a verified first transfer", async () => {
	const skill = await readFile(skillPath, "utf8");

	assert.match(skill, /^name: setting-up-pi-sync$/mu);
	assert.match(skill, /^description: .+first-time pi-sync setup\.$/mu);
	for (const requirement of [
		"Never ask the user to paste access keys",
		"Do not read or print `pi-sync.json`",
		"Keep sessions excluded",
		"/sync doctor",
		"Git diagnostics contact the remote",
		"WebDAV diagnostics contact the server",
		"S3 and R2 diagnostics are local-only",
		"do not validate the endpoint, bucket, credentials, permissions, or connectivity",
		"/sync push",
		"/sync pull",
		"without `--yes` or `--force`",
		"Report setup as complete only when",
	]) {
		assert.ok(skill.includes(requirement), `missing setup requirement: ${requirement}`);
	}
	assert.ok(!skill.includes("contacts the configured backend"));
});
