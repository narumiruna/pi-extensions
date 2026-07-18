import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import { consumeLspConfigNotice, loadConfig, loadRuntime } from "../src/adapters.js";
import { commandExists, commandFromEnv, splitCommand } from "../src/command.js";
import { collectSupportedFiles, directoryUri, resolveSupportedFile } from "../src/files.js";
import { resolveSpawnCommand } from "../src/lsp-client.js";
import lsp from "../src/pi-lsp.js";
import { selectDiagnosticRoutes, selectFixRoute } from "../src/routes.js";
import {
	applyTextEdits,
	collectWorkspaceEdits,
	hasOverlappingTextEdits,
	positionAt,
} from "../src/text-edits.js";
import type { LspServerAdapter } from "../src/types.js";

test("lsp registers diagnostics/fix tools, command, and status hooks", () => {
	const mock = createMockPi();
	lsp(mock.pi);

	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["lsp_diagnostics", "lsp_fix"],
	);
	assert.ok(mock.commands.has("lsp"));
	assert.deepEqual([...mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
});

test("default catalog routes common languages and skips generated trees", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-defaults-"));
	const agentDir = path.join(root, "agent");
	const project = path.join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(path.join(project, "src"), { recursive: true });
	mkdirSync(path.join(project, "target"));
	mkdirSync(path.join(project, "vendor"));
	writeFileSync(path.join(project, "src", "main.rs"), "fn main() {}\n");
	writeFileSync(path.join(project, "src", "main.go"), "package main\n");
	writeFileSync(path.join(project, "target", "generated.rs"), "fn generated() {}\n");
	writeFileSync(path.join(project, "vendor", "dependency.go"), "package dependency\n");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousConfig = process.env.PI_LSP_CONFIG;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_LSP_CONFIG;

	try {
		const { adapters } = loadRuntime(project);
		const rustAnalyzer = adapters.find((adapter) => adapter.name === "rust-analyzer");
		const gopls = adapters.find((adapter) => adapter.name === "gopls");
		assert.ok(rustAnalyzer);
		assert.ok(gopls);
		assert.deepEqual(rustAnalyzer.defaultCommand, { command: "rust-analyzer", args: [] });
		assert.deepEqual(rustAnalyzer.extensions, [".rs"]);
		assert.equal(rustAnalyzer.languageIdFor("src/main.rs"), "rust");
		assert.deepEqual(collectSupportedFiles(rustAnalyzer, project, undefined, 50), [
			path.join(project, "src", "main.rs"),
		]);
		assert.deepEqual(collectSupportedFiles(rustAnalyzer, project, ["target"], 50), [
			path.join(project, "target", "generated.rs"),
		]);
		assert.deepEqual(gopls.defaultCommand, { command: "gopls", args: [] });
		assert.deepEqual(gopls.extensions, [".go"]);
		assert.equal(gopls.languageIdFor("main.go"), "go");
		assert.deepEqual(collectSupportedFiles(gopls, project, undefined, 50), [
			path.join(project, "src", "main.go"),
		]);
		assert.deepEqual(collectSupportedFiles(gopls, project, ["vendor"], 50), [
			path.join(project, "vendor", "dependency.go"),
		]);

		const catalog: Array<{
			name: string;
			command: string[];
			extensions: string[];
			sample: string;
			languageId: string;
			skipDirectories?: string[];
			initialization?: Record<string, unknown>;
		}> = [
			{
				name: "rubocop",
				command: ["rubocop", "--lsp"],
				extensions: [".rb", ".rake", ".gemspec", ".ru"],
				sample: "Rakefile.rake",
				languageId: "ruby",
			},
			{
				name: "elixir-ls",
				command: [process.platform === "win32" ? "language_server.bat" : "language_server.sh"],
				extensions: [".ex", ".exs"],
				sample: "lib/app.exs",
				languageId: "elixir",
				skipDirectories: ["_build", "deps"],
			},
			{
				name: "zls",
				command: ["zls"],
				extensions: [".zig", ".zon"],
				sample: "build.zig.zon",
				languageId: "zig",
				skipDirectories: [".zig-cache", "zig-out"],
			},
			{
				name: "csharp",
				command: ["roslyn-language-server", "--stdio", "--autoLoadProjects"],
				extensions: [".cs", ".csx"],
				sample: "Program.csx",
				languageId: "csharp",
				skipDirectories: ["bin", "obj"],
			},
			{
				name: "fsharp",
				command: ["fsautocomplete"],
				extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
				sample: "Program.fsx",
				languageId: "fsharp",
				skipDirectories: ["bin", "obj"],
				initialization: { AutomaticWorkspaceInit: true },
			},
			{
				name: "sourcekit-lsp",
				command: ["sourcekit-lsp"],
				extensions: [".swift", ".mm"],
				sample: "Sources/App.swift",
				languageId: "swift",
				skipDirectories: [".build", "DerivedData"],
			},
			{
				name: "clangd",
				command: ["clangd", "--background-index", "--clang-tidy"],
				extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
				sample: "include/app.hpp",
				languageId: "cpp",
				skipDirectories: ["build"],
			},
			{
				name: "jdtls",
				command: ["jdtls"],
				extensions: [".java"],
				sample: "src/App.java",
				languageId: "java",
				skipDirectories: [".gradle", "build"],
			},
			{
				name: "kotlin-lsp",
				command: ["kotlin-lsp", "--stdio"],
				extensions: [".kt", ".kts"],
				sample: "src/App.kts",
				languageId: "kotlin",
				skipDirectories: [".gradle", "build"],
			},
			{
				name: "yaml-language-server",
				command: ["yaml-language-server", "--stdio"],
				extensions: [".yaml", ".yml"],
				sample: "config.yml",
				languageId: "yaml",
			},
			{
				name: "lua-language-server",
				command: ["lua-language-server"],
				extensions: [".lua"],
				sample: "init.lua",
				languageId: "lua",
			},
			{
				name: "intelephense",
				command: ["intelephense", "--stdio"],
				extensions: [".php"],
				sample: "index.php",
				languageId: "php",
				initialization: { telemetry: { enabled: false } },
			},
			{
				name: "prisma",
				command: ["prisma-language-server", "--stdio"],
				extensions: [".prisma"],
				sample: "schema.prisma",
				languageId: "prisma",
			},
			{
				name: "dart",
				command: ["dart", "language-server"],
				extensions: [".dart"],
				sample: "lib/main.dart",
				languageId: "dart",
				skipDirectories: [".dart_tool", "build"],
			},
			{
				name: "ocaml-lsp",
				command: ["ocamllsp"],
				extensions: [".ml", ".mli"],
				sample: "lib/app.mli",
				languageId: "ocaml",
				skipDirectories: ["_build", "_opam"],
			},
			{
				name: "bash-language-server",
				command: ["bash-language-server", "start"],
				extensions: [".sh", ".bash"],
				sample: "scripts/build.zsh",
				languageId: "shellscript",
			},
			{
				name: "terraform-ls",
				command: ["terraform-ls", "serve"],
				extensions: [".tf", ".tfvars"],
				sample: "prod.tfvars",
				languageId: "terraform-vars",
				skipDirectories: [".terraform"],
				initialization: {
					experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true },
				},
			},
			{
				name: "texlab",
				command: ["texlab"],
				extensions: [".tex", ".bib"],
				sample: "references.bib",
				languageId: "bibtex",
			},
			{
				name: "gleam",
				command: ["gleam", "lsp"],
				extensions: [".gleam"],
				sample: "src/app.gleam",
				languageId: "gleam",
				skipDirectories: ["build"],
			},
			{
				name: "clojure-lsp",
				command: ["clojure-lsp", "listen"],
				extensions: [".clj", ".cljs", ".cljc", ".edn"],
				sample: "deps.edn",
				languageId: "clojure",
				skipDirectories: [".cpcache"],
			},
			{
				name: "nixd",
				command: ["nixd"],
				extensions: [".nix"],
				sample: "flake.nix",
				languageId: "nix",
			},
			{
				name: "tinymist",
				command: ["tinymist"],
				extensions: [".typ", ".typc"],
				sample: "main.typc",
				languageId: "typst-code",
			},
			{
				name: "haskell-language-server",
				command: ["haskell-language-server-wrapper", "--lsp"],
				extensions: [".hs", ".lhs"],
				sample: "src/Main.lhs",
				languageId: "haskell",
				skipDirectories: [".stack-work", "dist-newstyle"],
			},
		];
		assert.equal(
			adapters.some((adapter) => adapter.name === "julia-language-server"),
			false,
		);

		for (const expected of catalog) {
			const adapter = adapters.find((candidate) => candidate.name === expected.name);
			assert.ok(adapter, `missing default adapter: ${expected.name}`);
			assert.equal(adapter.isDefault, true);
			assert.deepEqual(adapter.defaultCommand, {
				command: expected.command[0],
				args: expected.command.slice(1),
			});
			assert.deepEqual(adapter.extensions, expected.extensions);
			assert.equal(adapter.languageIdFor(expected.sample), expected.languageId);
			assert.deepEqual(adapter.initialization, expected.initialization);
			for (const directory of expected.skipDirectories ?? []) {
				assert.equal(
					adapter.skipDirectories.has(directory),
					true,
					`${expected.name} skips ${directory}`,
				);
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousConfig === undefined) delete process.env.PI_LSP_CONFIG;
		else process.env.PI_LSP_CONFIG = previousConfig;
		rmSync(root, { recursive: true, force: true });
	}
});

test("command helpers split shell-like strings and honor environment overrides", () => {
	assert.deepEqual(
		resolveSpawnCommand(
			{ command: "language_server.bat", args: [] },
			"win32",
			"C:\\Windows\\System32\\cmd.exe",
		),
		{
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "language_server.bat"],
		},
	);
	assert.deepEqual(resolveSpawnCommand({ command: "language_server.sh", args: [] }, "linux"), {
		command: "language_server.sh",
		args: [],
	});
	assert.deepEqual(splitCommand("cmd --flag 'two words' a\\ b"), [
		"cmd",
		"--flag",
		"two words",
		"a b",
	]);
	process.env.PI_TEST_LSP_COMMAND = "custom --stdio";
	try {
		assert.deepEqual(commandFromEnv("PI_TEST_LSP_COMMAND", { command: "fallback", args: [] }), {
			command: "custom",
			args: ["--stdio"],
		});
	} finally {
		delete process.env.PI_TEST_LSP_COMMAND;
	}

	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-command-"));
	const executable = path.join(root, "tool");
	writeFileSync(executable, "#!/bin/sh\nexit 0\n");
	chmodSync(executable, 0o755);
	assert.equal(commandExists("./tool", root), true);
});

test("LSP config uses canonical paths while preserving project legacy files", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-config-"));
	const agentDir = path.join(root, "agent");
	const project = path.join(root, "project");
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const config = (name: string) => ({
		servers: { [name]: { command: [name], extensions: [`.${name}`] } },
	});
	try {
		const userLegacy = path.join(agentDir, "lsp.json");
		writeFileSync(userLegacy, JSON.stringify(config("user")));
		chmodSync(userLegacy, 0o600);
		assert.equal(loadConfig(project).servers[0]?.name, "user");
		assert.equal(existsSync(path.join(agentDir, "pi-lsp.json")), true);
		assert.equal(statSync(path.join(agentDir, "pi-lsp.json")).mode & 0o777, 0o600);
		assert.equal(existsSync(userLegacy), false);

		const projectLegacy = path.join(project, ".pi", "lsp.json");
		writeFileSync(projectLegacy, JSON.stringify(config("legacy-project")));
		assert.equal(loadConfig(project).servers[0]?.name, "legacy-project");
		assert.equal(existsSync(projectLegacy), true);
		assert.equal(existsSync(path.join(project, ".pi", "pi-lsp.json")), false);

		const projectCanonical = path.join(project, ".pi", "pi-lsp.json");
		writeFileSync(projectCanonical, JSON.stringify(config("project")));
		assert.equal(loadConfig(project).servers[0]?.name, "project");

		writeFileSync(projectCanonical, "invalid");
		assert.throws(() => loadConfig(project));
		assert.equal(existsSync(projectLegacy), true);
		unlinkSync(projectCanonical);
		unlinkSync(projectLegacy);

		writeFileSync(userLegacy, JSON.stringify(config("fallback")));
		unlinkSync(path.join(agentDir, "pi-lsp.json"));
		symlinkSync("missing-target", path.join(agentDir, "pi-lsp.json"));
		assert.equal(loadConfig(project).servers[0]?.name, "fallback");
		assert.equal(existsSync(userLegacy), true);

		process.env.PI_LSP_CONFIG = JSON.stringify(config("explicit"));
		assert.equal(loadConfig(project).servers[0]?.name, "explicit");
		assert.equal(consumeLspConfigNotice(), undefined);
	} finally {
		delete process.env.PI_LSP_CONFIG;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("LSP config applies safe server-specific skip directories", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-skip-directories-"));
	const agentDir = path.join(root, "agent");
	const project = path.join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(path.join(project, "src"), { recursive: true });
	mkdirSync(path.join(project, "generated"));
	writeFileSync(path.join(project, "src", "main.foo"), "source\n");
	writeFileSync(path.join(project, "generated", "output.foo"), "generated\n");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousConfig = process.env.PI_LSP_CONFIG;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		process.env.PI_LSP_CONFIG = JSON.stringify({
			servers: {
				custom: {
					command: ["custom-lsp"],
					extensions: [".foo"],
					skipDirectories: ["generated"],
				},
			},
		});
		const adapter = loadRuntime(project).adapters[0];
		assert.ok(adapter);
		assert.equal(adapter.isDefault, false);
		assert.deepEqual(collectSupportedFiles(adapter, project, undefined, 50), [
			path.join(project, "src", "main.foo"),
		]);
		assert.deepEqual(collectSupportedFiles(adapter, project, ["generated"], 50), [
			path.join(project, "generated", "output.foo"),
		]);

		process.env.PI_LSP_CONFIG = JSON.stringify({
			servers: {
				custom: {
					command: ["custom-lsp"],
					extensions: [".foo"],
					skipDirectories: ["../generated"],
				},
			},
		});
		assert.throws(() => loadConfig(project), /skipDirectories.*directory names/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousConfig === undefined) delete process.env.PI_LSP_CONFIG;
		else process.env.PI_LSP_CONFIG = previousConfig;
		rmSync(root, { recursive: true, force: true });
	}
});

test("text edit helpers apply reverse-sorted edits and detect overlaps", () => {
	const text = "one\ntwo\nthree";
	assert.deepEqual(positionAt(text, 5), { line: 1, character: 1 });
	assert.equal(
		applyTextEdits(text, [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
				newText: "ONE",
			},
			{ range: { start: { line: 2, character: 5 }, end: { line: 2, character: 5 } }, newText: "!" },
		]),
		"ONE\ntwo\nthree!",
	);
	assert.equal(
		hasOverlappingTextEdits(text, [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "" },
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "" },
		]),
		true,
	);
	assert.deepEqual(
		collectWorkspaceEdits(
			{
				changes: {
					"file:///a.ts": [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
							newText: "x",
						},
					],
				},
			},
			"file:///a.ts",
		),
		[{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }],
	);
});

test("file helpers collect supported files and reject root escapes", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-files-"));
	mkdirSync(path.join(root, "src"));
	writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");
	writeFileSync(path.join(root, "src", "b.txt"), "ignore\n");
	const adapter = testAdapter("ts", [".ts"]);

	assert.equal(directoryUri(root).startsWith("file://"), true);
	assert.deepEqual(collectSupportedFiles(adapter, root, ["src"], 10), [
		path.join(root, "src", "a.ts"),
	]);
	assert.equal(resolveSupportedFile(adapter, root, "src/a.ts"), path.join(root, "src", "a.ts"));
	assert.throws(
		() => collectSupportedFiles(adapter, root, ["../outside"], 10),
		/escapes workspace root/,
	);
});

test("route selection handles server filters and ambiguous fix routes", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-routes-"));
	writeFileSync(path.join(root, "a.ts"), "const a = 1;\n");
	const ts = testAdapter("ts", [".ts"]);
	const alsoTs = testAdapter("also-ts", [".ts"]);

	const diagnostic = selectDiagnosticRoutes([ts, alsoTs], { root, server: ["ts"] }, 50);
	assert.deepEqual(
		diagnostic.routes.map((route) => route.adapter.name),
		["ts"],
	);
	assert.throws(() => selectFixRoute([ts, alsoTs], { root, path: "a.ts" }), /Multiple LSP servers/);
	assert.equal(
		selectFixRoute([ts, alsoTs], { root, path: "a.ts", server: "also-ts" }).route.adapter.name,
		"also-ts",
	);
	assert.throws(
		() => selectDiagnosticRoutes([ts], { root, server: "missing" }, 50),
		/Unknown LSP server/,
	);
});

test("diagnostic route caches keep per-server skip policies isolated", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-route-cache-"));
	mkdirSync(path.join(root, "generated"));
	mkdirSync(path.join(root, "src"));
	writeFileSync(path.join(root, "generated", "output.foo"), "generated\n");
	writeFileSync(path.join(root, "src", "main.foo"), "source\n");
	const skipGenerated = testAdapter("skip-generated", [".foo"]);
	const includeGenerated = testAdapter("include-generated", [".foo"]);
	skipGenerated.skipDirectories.add("generated");

	try {
		const selection = selectDiagnosticRoutes([skipGenerated, includeGenerated], { root }, 50);
		const routes = new Map(selection.routes.map((route) => [route.adapter.name, route.files]));
		assert.deepEqual(routes.get("skip-generated"), [path.join(root, "src", "main.foo")]);
		assert.deepEqual(routes.get("include-generated"), [
			path.join(root, "generated", "output.foo"),
			path.join(root, "src", "main.foo"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("diagnostic routes skip missing defaults but preserve explicit selection", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-route-availability-"));
	writeFileSync(path.join(root, "main.foo"), "source\n");
	const executable = path.join(root, "available-lsp");
	writeFileSync(executable, "#!/bin/sh\nexit 0\n");
	chmodSync(executable, 0o755);
	const available = testAdapter("available", [".foo"]);
	available.defaultCommand = { command: "./available-lsp", args: [] };
	available.isDefault = true;
	const missing = testAdapter("missing", [".foo"]);
	missing.defaultCommand = { command: "./missing-lsp", args: [] };
	missing.isDefault = true;
	let missingFileChecks = 0;
	missing.isSupportedFile = (filePath) => {
		missingFileChecks += 1;
		return filePath.endsWith(".foo");
	};

	try {
		const selection = selectDiagnosticRoutes([available, missing], { root }, 50) as ReturnType<
			typeof selectDiagnosticRoutes
		> & { skipped?: Array<{ adapter: LspServerAdapter }> };
		assert.deepEqual(
			selection.routes.map((route) => route.adapter.name),
			["available"],
		);
		assert.deepEqual(
			selection.skipped?.map((route) => route.adapter.name),
			["missing"],
		);
		assert.equal(missingFileChecks, 0);
		assert.deepEqual(
			selectDiagnosticRoutes([missing], { root, server: "missing" }, 50).routes.map(
				(route) => route.adapter.name,
			),
			["missing"],
		);
		assert.equal(missingFileChecks > 0, true);
		missingFileChecks = 0;
		const unrelated = testAdapter("unrelated", [".bar"]);
		unrelated.defaultCommand = { command: "./available-lsp", args: [] };
		unrelated.isDefault = true;
		assert.throws(
			() => selectDiagnosticRoutes([unrelated, missing], { root }, 50),
			/No supported files found for available LSP commands.*Skipped unavailable.*missing/,
		);
		assert.equal(missingFileChecks, 0);
		assert.throws(
			() => selectDiagnosticRoutes([missing], { root }, 50),
			/No available default LSP commands.*missing/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function testAdapter(name: string, extensions: string[]): LspServerAdapter {
	return {
		name,
		isDefault: false,
		extensions,
		skipDirectories: new Set(["node_modules"]),
		commandEnvVar: `PI_${name.toUpperCase()}_COMMAND`,
		defaultCommand: { command: name, args: [] },
		missingCommandHint: `install ${name}`,
		languageIdFor() {
			return name;
		},
		isSupportedFile(filePath: string) {
			return extensions.some((extension) => filePath.endsWith(extension));
		},
	};
}
