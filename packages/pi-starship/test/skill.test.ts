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
import { BUILT_IN_CONFIG } from "../src/config.js";
import { MODULE_DEFINITIONS, MODULE_NAMES } from "../src/modules/catalog.js";

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
		"[the complete module catalog](references/module-catalog.md)",
		"[module behavior](references/modules.md)",
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
			"## Configuration schema and validation",
			"### Diagnostic and fallback behavior",
			"## 🧩 Format grammar",
			"## 🎨 Styles and palettes",
		],
		"module-catalog.md": ["## Shared module fields", "## Catalog order", "## Module schemas"],
		"modules.md": [
			"## 🧱 Modules",
			"## Reachability and collection rules",
			"## Exact language defaults",
			"## Exact environment and deployment defaults",
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

test("complete module catalog covers every public module schema", () => {
	const catalog = readFileSync(path.join(referencesDirectory, "module-catalog.md"), "utf8");
	assert.deepEqual(
		[...catalog.matchAll(/^### `([^`]+)`$/gmu)].map((match) => match[1]),
		MODULE_NAMES,
	);
	assert.ok(catalog.includes(MODULE_NAMES.map((name) => `\`${name}\``).join(" → ")));

	for (const [index, definition] of MODULE_DEFINITIONS.entries()) {
		const heading = `### \`${definition.name}\``;
		const start = catalog.indexOf(heading);
		const nextName = MODULE_DEFINITIONS[index + 1]?.name;
		const end = nextName ? catalog.indexOf(`### \`${nextName}\``, start) : catalog.length;
		const section = catalog.slice(start, end);
		assert.ok(start >= 0 && end > start, `missing schema for ${definition.name}`);
		assert.ok(section.includes(definition.description));
		assert.ok(
			section.includes(
				`Format variables: ${definition.variables.map((name) => `\`$${name}\``).join(", ")}`,
			),
		);
		const styleVariables = definition.styleVariables ?? ["style"];
		assert.ok(
			section.includes(
				`Style variables in \`format\`: ${styleVariables.map((name) => `\`$${name}\``).join(", ")}`,
			),
		);
		assert.ok(section.includes(`Default \`format\`: ${markdownCode(definition.defaults.format)}`));
		assert.ok(section.includes(`Default \`symbol\`: ${markdownCode(definition.defaults.symbol)}`));
		assert.ok(
			section.includes(`Default \`disabled\`: ${markdownCode(definition.defaults.disabled)}`),
		);
		if (definition.layout) {
			assert.ok(section.includes(`Layout role: ${markdownCode(definition.layout)}`));
		}

		const styleFields = definition.styleDefaults
			? [
					...(definition.fallbackStyle ? ([["style", definition.defaults.style]] as const) : []),
					...Object.entries(definition.styleDefaults),
				]
			: definition.displayDefaults
				? []
				: [["style", definition.defaults.style]];
		for (const [name, value] of styleFields) {
			assert.ok(section.includes(`| \`${name}\` | ${markdownCode(value)} |`));
		}
		if (definition.displayDefaults) {
			assert.ok(
				section.includes(`Default \`display\`: ${markdownCode(definition.displayDefaults)}`),
			);
		}

		for (const [name, schema] of Object.entries(definition.options ?? {})) {
			const row = section.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
			assert.ok(row, `${definition.name}.${name} is missing`);
			assert.ok(row.includes(optionType(schema.kind)));
			assert.ok(row.includes(markdownCode(schema.default)));
			if (schema.kind === "integer") {
				assert.ok(section.includes(`Inclusive range ${schema.minimum} through ${schema.maximum}.`));
			}
			if (schema.kind === "string-enum") {
				for (const value of schema.values) assert.ok(section.includes(`\`${value}\``));
			}
		}
	}

	const extensionStatus = catalog.slice(catalog.indexOf("### `extension_status`"));
	for (const [field, value] of Object.entries({
		separator: BUILT_IN_CONFIG.extensionStatus.separator,
		max_statuses: BUILT_IN_CONFIG.extensionStatus.maxStatuses,
		icons: BUILT_IN_CONFIG.extensionStatus.icons,
	})) {
		const row = extensionStatus.split("\n").find((line) => line.startsWith(`| \`${field}\` |`));
		assert.ok(row, `extension_status.${field} is missing`);
		assert.ok(row.includes(markdownCode(value)));
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

function markdownCode(value: unknown): string {
	return `\`${JSON.stringify(value).replaceAll("|", "\\|")}\``;
}

function optionType(kind: string): string {
	return {
		boolean: "boolean",
		integer: "integer",
		string: "string",
		"string-array": "string array",
		"string-enum": "string enum",
		"string-map": "string-to-string table",
	}[kind] as string;
}
