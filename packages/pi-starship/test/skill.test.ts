import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	loadSkillsFromDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDirectory = path.join(packageDirectory, "skills");
const skillDirectory = path.join(skillsDirectory, "editing-pi-starship-toml");
const validatorPath = path.join(skillDirectory, "scripts", "validate.mjs");

test("package bundles one narrowly triggered pi-starship editing skill", async () => {
	const manifest = JSON.parse(
		readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
	) as {
		files: string[];
		pi: { extensions: string[]; skills?: string[] };
	};
	assert.deepEqual(manifest.pi.skills, ["./skills"]);
	assert.ok(manifest.files.includes("skills"));

	const result = loadSkillsFromDir({ dir: skillsDirectory, source: "pi-starship-test" });
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.skills.length, 1);
	const skill = result.skills[0];
	assert.equal(skill?.name, "editing-pi-starship-toml");
	assert.match(skill?.description ?? "", /Use only when .*write .*pi-starship\.toml/u);
	for (const excludedTask of [
		"read-only explanation",
		"general TOML work",
		"shell Starship configuration",
		"pi-starship source-code changes",
	]) {
		assert.ok(
			skill?.description.includes(excludedTask),
			`missing trigger exclusion: ${excludedTask}`,
		);
	}

	const agentDir = mkdtempSync(path.join(tmpdir(), "pi-starship-package-skill-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [packageDirectory] }),
			noExtensions: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getSkills();
		assert.deepEqual(loaded.diagnostics, []);
		assert.ok(loaded.skills.some(({ name }) => name === "editing-pi-starship-toml"));
	} finally {
		rmSync(agentDir, { force: true, recursive: true });
	}
});

test("skill instructions preserve user configuration and require honest validation", () => {
	const skill = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
	for (const contract of [
		"Read the existing document before editing it.",
		"Preserve comments, ordering, unknown fields, and unrelated custom settings",
		"make it reachable from the root `format` or `$all`",
		"Do not enable network, command-backed, cloud, deployment, host, or user metadata",
		"run `/reload` and inspect `/starship status`",
		"Do not claim semantic validation or an active-footer update",
	]) {
		assert.ok(skill.includes(contract), `missing editing contract: ${contract}`);
	}
});

test("bundled validator accepts valid TOML and rejects invalid TOML", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "pi-starship-skill-"));
	try {
		const validPath = path.join(directory, "pi-starship.toml");
		writeFileSync(validPath, 'format = "$model$directory"\n[model]\nstyle = "bold blue"\n');
		const valid = spawnSync(process.execPath, [validatorPath, validPath], { encoding: "utf8" });
		assert.equal(valid.status, 0, valid.stderr);
		assert.match(valid.stdout, /Valid TOML/u);

		const invalidPath = path.join(directory, "invalid-pi-starship.toml");
		writeFileSync(invalidPath, "[model\nstyle = 1\n");
		const invalid = spawnSync(process.execPath, [validatorPath, invalidPath], {
			encoding: "utf8",
		});
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /Invalid TOML/u);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
