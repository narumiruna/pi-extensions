import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	atomicSaveConfigDocument,
	BUILT_IN_CONFIG,
	BUILT_IN_EXAMPLE,
	CONFIG_FILE_NAME,
	loadOrCreateStarshipConfig,
	loadStarshipConfig,
	MODULE_NAMES,
	settingsFilePath,
	validateConfigDocument,
} from "../src/config.js";

test("config path uses the agent directory and missing settings use built-in defaults", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	try {
		const path = settingsFilePath(root);
		assert.equal(path, join(root, CONFIG_FILE_NAME));
		const loaded = loadStarshipConfig(path);
		assert.equal(loaded.source, "built-in");
		assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
		assert.deepEqual(loaded.diagnostics, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("built-in example uses readable TOML continuations without changing the format", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		assert.match(BUILT_IN_EXAMPLE, /^format = """/mu);
		assert.match(BUILT_IN_EXAMPLE, /\[░▒▓\]\(lead\)\\\n\$brand\\\n\$provider\\\n/u);
		assert.doesNotMatch(BUILT_IN_EXAMPLE, /format = '''/u);
		writeFileSync(path, BUILT_IN_EXAMPLE);
		const loaded = loadStarshipConfig(path);
		assert.equal(
			loaded.config.format,
			[
				"[░▒▓](lead)",
				"$brand",
				"$provider",
				"$model",
				"$thinking",
				"[](fg:header bg:directory)",
				"$directory",
				"[](fg:directory bg:git)",
				"$git_worktree",
				"$git_branch",
				"$git_status",
				"[](fg:git bg:runtime)",
				"$activity",
				"$context",
				"$tokens",
				"[](fg:runtime bg:meter)",
				"$cost",
				"$time",
				"[](fg:meter)",
				"(\n$extension_status)",
			].join(""),
		);
		assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
		assert.deepEqual(loaded.diagnostics, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Git modules use Starship display order", () => {
	const gitModules = MODULE_NAMES.filter((name) => name.startsWith("git_"));
	assert.deepEqual(gitModules, [
		"git_worktree",
		"git_branch",
		"git_commit",
		"git_state",
		"git_metrics",
		"git_status",
	]);
});

test("missing settings are atomically initialized from the readable built-in example", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		const loaded = loadOrCreateStarshipConfig(path);
		assert.equal(loaded.source, "user");
		assert.equal(loaded.rawDocument, BUILT_IN_EXAMPLE);
		assert.equal(readFileSync(path, "utf8"), BUILT_IN_EXAMPLE);
		assert.deepEqual(loaded.diagnostics, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("default initialization never overwrites an existing malformed document", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		const malformed = "format = [\n";
		writeFileSync(path, malformed);
		const loaded = loadOrCreateStarshipConfig(path);
		assert.equal(loaded.source, "built-in");
		assert.equal(loaded.rawDocument, malformed);
		assert.equal(readFileSync(path, "utf8"), malformed);
		assert.match(loaded.diagnostics[0]?.message ?? "", /parse TOML/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("default initialization failures keep built-in settings and report the error", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		const loaded = loadOrCreateStarshipConfig(path, {
			linkSync() {
				throw new Error("publish failed");
			},
		});
		assert.equal(loaded.source, "built-in");
		assert.equal(existsSync(path), false);
		assert.match(loaded.diagnostics[0]?.message ?? "", /create.*publish failed/i);
		assert.deepEqual(readdirSync(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("valid TOML loads root, palette, module, and extension status settings", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(
			path,
			`format = '$model$extension_status'\npalette = 'mine'\n\n[palettes.mine]\nblue = '#010203'\n\n[model]\nformat = '[$model]($style)'\nsymbol = 'M'\nstyle = 'bold blue'\ndisabled = true\n\n[extension_status]\nseparator = ' | '\nmax_statuses = 3\n\n[extension_status.icons]\ngoal = ''\n`,
		);
		const loaded = loadStarshipConfig(path);
		assert.equal(loaded.source, "user");
		assert.equal(loaded.config.format, "$model$extension_status");
		assert.equal(loaded.config.palette, "mine");
		assert.deepEqual(loaded.config.palettes.mine, { blue: "#010203" });
		assert.equal(loaded.config.modules.model.format, "[$model]($style)");
		assert.equal(loaded.config.modules.model.symbol, "M");
		assert.equal(loaded.config.modules.model.style, "bold blue");
		assert.equal(loaded.config.modules.model.disabled, true);
		assert.equal(loaded.config.extensionStatus.separator, " | ");
		assert.equal(loaded.config.extensionStatus.maxStatuses, 3);
		assert.deepEqual(loaded.config.extensionStatus.icons, { goal: "" });
		assert.deepEqual(loaded.diagnostics, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("malformed TOML reports an error and uses the full built-in config", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(path, "format = [");
		const loaded = loadStarshipConfig(path);
		assert.equal(loaded.source, "built-in");
		assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
		assert.equal(loaded.diagnostics[0]?.severity, "error");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid recognized fields fall back independently and unknown fields warn", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(
			path,
			`format = 7\npalette = 'missing'\nfuture = true\n\n[model]\nstyle = 1\ndisabled = 'no'\nfuture = 'keep'\n\n[palettes.bad]\noops = 'not-a-color'\n`,
		);
		const loaded = loadStarshipConfig(path);
		assert.equal(loaded.source, "user");
		assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
		assert.equal(loaded.config.palette, BUILT_IN_CONFIG.palette);
		assert.equal(loaded.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
		assert.equal(loaded.config.modules.model.disabled, false);
		assert.ok(loaded.diagnostics.length >= 6);
		assert.ok(loaded.diagnostics.every((item) => item.severity === "warning"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("palette normalization handles prototype-like names as exact own properties", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(path, "palette = 'toString'\n\n[model]\nstyle = 'toString'\n");
		const inherited = loadStarshipConfig(path);
		assert.equal(inherited.config.palette, BUILT_IN_CONFIG.palette);
		assert.equal(inherited.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
		assert.match(
			inherited.diagnostics.map((item) => item.message).join("\n"),
			/unknown palette.*toString/i,
		);

		writeFileSync(
			path,
			"palette = '__proto__'\n\n[palettes.__proto__]\naccent = 'red'\n\n[model]\nstyle = 'accent'\n",
		);
		const exact = loadStarshipConfig(path);
		assert.equal(exact.config.palette, "__proto__");
		assert.equal(Object.hasOwn(exact.config.palettes, "__proto__"), true);
		assert.deepEqual(Reflect.get(exact.config.palettes, "__proto__"), { accent: "red" });
		assert.equal(exact.config.modules.model.style, "accent");
		assert.deepEqual(exact.diagnostics, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unknown root/module/style variables warn and invalid styles fall back", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(
			path,
			`format = '$model$unknown[ok]($mystyle)'\n\n[model]\nformat = '$symbol$bad[ok]($other)'\nstyle = 'not-a-color'\n`,
		);
		const loaded = loadStarshipConfig(path);
		const messages = loaded.diagnostics.map((item) => item.message).join("\n");
		assert.match(messages, /unknown.*variable/i);
		assert.match(messages, /style variable.*mystyle/i);
		assert.match(messages, /variable.*bad.*model/i);
		assert.match(messages, /style variable.*other/i);
		assert.match(messages, /style.*not-a-color/i);
		assert.equal(loaded.config.modules.model.style, BUILT_IN_CONFIG.modules.model.style);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid root and module formats fall back at the documented scope", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(path, `format = '['\n\n[model]\nformat = '$ '\nsymbol = 'custom'\n`);
		const loaded = loadStarshipConfig(path);
		assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
		assert.equal(loaded.config.modules.model.format, BUILT_IN_CONFIG.modules.model.format);
		assert.equal(loaded.config.modules.model.symbol, "custom");
		assert.equal(loaded.diagnostics.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("draft validation never writes and retains unknown TOML fields", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(path, "format = '$model'\nfuture = 'old'\n");
		const draft = "format = '$provider'\nfuture = 'preserved'\n";
		const validated = validateConfigDocument(path, draft);
		assert.equal(validated.config.format, "$provider");
		assert.equal(validated.rawDocument, draft);
		assert.equal(readFileSync(path, "utf8"), "format = '$model'\nfuture = 'old'\n");
		assert.match(validated.diagnostics.map((item) => item.message).join(" "), /future/u);
		assert.throws(() => validateConfigDocument(path, "format = ["), /parse TOML/iu);
		assert.equal(readFileSync(path, "utf8"), "format = '$model'\nfuture = 'old'\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("atomic saves preserve the raw document and replace the old file", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(path, "format = '$model'\nfuture = 'old'\n");
		const raw = "format = '$provider'\nfuture = 'preserved'\n";
		const loaded = atomicSaveConfigDocument(path, raw);
		assert.equal(readFileSync(path, "utf8"), raw);
		assert.equal(loaded.config.format, "$provider");
		assert.match(loaded.diagnostics.map((item) => item.message).join(" "), /future/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("atomic publish failure keeps the previous file and removes temp files", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const path = join(root, CONFIG_FILE_NAME);
	try {
		writeFileSync(path, "format = '$model'\n");
		assert.throws(() =>
			atomicSaveConfigDocument(path, "format = '$provider'\n", {
				renameSync() {
					throw new Error("publish failed");
				},
			}),
		);
		assert.equal(readFileSync(path, "utf8"), "format = '$model'\n");
		assert.equal(existsSync(root) && readFileSync(path, "utf8").includes("provider"), false);
		assert.deepEqual(
			requireDirectory(root).filter((name) => name.endsWith(".tmp")),
			[],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy pi-statusline files and preset environment never affect config", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-starship-config-"));
	const previous = process.env.PI_STATUSLINE_PRESET;
	try {
		process.env.PI_STATUSLINE_PRESET = "classic";
		writeFileSync(join(root, "pi-statusline.json"), JSON.stringify({ format: "$model" }));
		const loaded = loadStarshipConfig(join(root, CONFIG_FILE_NAME));
		assert.equal(loaded.source, "built-in");
		assert.equal(loaded.config.format, BUILT_IN_CONFIG.format);
	} finally {
		if (previous === undefined) delete process.env.PI_STATUSLINE_PRESET;
		else process.env.PI_STATUSLINE_PRESET = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

function requireDirectory(path: string): string[] {
	return readdirSync(path);
}
