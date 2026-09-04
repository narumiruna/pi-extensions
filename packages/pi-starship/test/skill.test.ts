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
const skillDirectory = path.join(skillsDirectory, "configuring-pi-starship");
const referencesDirectory = path.join(skillDirectory, "references");
const validatorPath = path.join(skillDirectory, "scripts", "validate.mjs");

test("package bundles one focused pi-starship configuration skill", async () => {
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
	assert.equal(skill?.name, "configuring-pi-starship");
	assert.match(skill?.description ?? "", /Configure .* answer questions .*pi-starship\.toml/u);
	for (const excludedTask of [
		"generic TOML",
		"shell Starship configuration",
		"pi-starship source-code development",
		"unrelated footer work",
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
		assert.ok(loaded.skills.some(({ name }) => name === "configuring-pi-starship"));
	} finally {
		rmSync(agentDir, { force: true, recursive: true });
	}
});

test("skill answers from references or source and edits configuration safely", () => {
	const skill = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
	for (const contract of [
		"For a configuration question, load only the smallest relevant reference",
		"Do not read or modify the user's settings file for a question",
		"../../src/config.ts",
		"../../src/modules/catalog.ts",
		"../../src/presets/",
		"[configuration and format](references/configuration.md)",
		"[modules](references/modules.md)",
		"[runtime and security](references/runtime-and-security.md)",
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

test("skill references own the detailed public configuration guidance", () => {
	const expectedCoverage = {
		"configuration.md": [
			"## ⚙️ Settings",
			"### 🎛️ Presets",
			"## 🧩 Format grammar",
			"## 🎨 Styles and palettes",
		],
		"modules.md": [
			"## 🧱 Modules",
			"### Usage semantics",
			"### Directory, Git, and environment contraction",
			"### Model and provider aliases and model truncation",
		],
		"runtime-and-security.md": [
			"## 🔒 Security and privacy",
			"### 📦 Package and language modules",
			"### 🚢 Deployment and cloud context",
			"## 📐 Layout and lifecycle",
			"## 🚧 Limitations",
		],
	} as const;

	for (const [file, headings] of Object.entries(expectedCoverage)) {
		const content = readFileSync(path.join(referencesDirectory, file), "utf8");
		assert.match(content, /authoritative public reference/u);
		for (const heading of headings)
			assert.ok(content.includes(heading), `${file} lacks ${heading}`);
	}

	const readme = readFileSync(path.join(packageDirectory, "README.md"), "utf8");
	for (const file of Object.keys(expectedCoverage)) {
		assert.ok(readme.includes(`./skills/configuring-pi-starship/references/${file}`));
	}
	for (const movedHeading of [
		"## 🧩 Format grammar",
		"## 🎨 Styles and palettes",
		"## 🧱 Modules",
		"## 📐 Layout and lifecycle",
	]) {
		assert.equal(
			readme.includes(movedHeading),
			false,
			`${movedHeading} must live in skill references`,
		);
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
