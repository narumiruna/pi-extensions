import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import { commandExists, commandFromEnv, splitCommand } from "../src/command.js";
import { collectSupportedFiles, directoryUri, resolveSupportedFile } from "../src/files.js";
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

test("command helpers split shell-like strings and honor environment overrides", () => {
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

function testAdapter(name: string, extensions: string[]): LspServerAdapter {
	return {
		name,
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
