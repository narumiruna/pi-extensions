import path from "node:path";
import type { LspServerAdapter } from "./types.js";

const BIOME_SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	"coverage",
	"dist",
	"node_modules",
	"out",
]);
const BIOME_SUPPORTED_EXTENSIONS = new Set([
	".astro",
	".css",
	".cts",
	".cjs",
	".graphql",
	".gql",
	".html",
	".js",
	".json",
	".jsonc",
	".jsx",
	".mjs",
	".mts",
	".svelte",
	".ts",
	".tsx",
	".vue",
]);

const PYTHON_SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".venv",
	"__pycache__",
	"node_modules",
	"venv",
]);

export const biomeAdapter: LspServerAdapter = {
	label: "Biome",
	statusPrefix: "🧬",
	defaultCommand: { command: "biome", args: ["lsp-proxy"] },
	commandEnvVar: "PI_BIOME_LSP_COMMAND",
	timeoutEnvVar: "PI_BIOME_LSP_TIMEOUT_MS",
	missingCommandHint: "Install @biomejs/biome or set PI_BIOME_LSP_COMMAND.",
	skipDirectories: BIOME_SKIP_DIRECTORIES,
	isSupportedFile: (filePath) => BIOME_SUPPORTED_EXTENSIONS.has(path.extname(filePath)),
	languageIdFor: biomeLanguageIdFor,
	formattingOptions: { tabSize: 2, insertSpaces: false },
	initialize: {
		codeAction: true,
		diagnosticDynamicRegistration: true,
		formattingDynamicRegistration: true,
		codeActionDynamicRegistration: true,
		didChangeConfigurationDynamicRegistration: true,
		didSaveDynamicRegistration: true,
	},
	fallbackToPublishDiagnostics: true,
	resolveUnsupportedCodeActions: true,
	serverRequestWorkspaceFolders: true,
	emptyDiagnosticsMessage: "Biome LSP found no supported files to check.",
	formatDiagnosticsHeader: (summary) =>
		`Biome LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`,
	editSummaryLabel: "Biome",
	defaultFixKind: "source.fixAll.biome",
};

export const tyAdapter: LspServerAdapter = {
	label: "ty",
	statusPrefix: "🐍 ty",
	defaultCommand: { command: "ty", args: ["server"] },
	commandEnvVar: "PI_TY_LSP_COMMAND",
	timeoutEnvVar: "PI_TY_LSP_TIMEOUT_MS",
	missingCommandHint: "Install ty or set PI_TY_LSP_COMMAND.",
	skipDirectories: PYTHON_SKIP_DIRECTORIES,
	isSupportedFile: isPythonFile,
	languageIdFor: () => "python",
	formattingOptions: { tabSize: 4, insertSpaces: true },
	initialize: {
		codeAction: false,
		diagnosticDynamicRegistration: false,
	},
	fallbackToPublishDiagnostics: false,
	resolveUnsupportedCodeActions: false,
	serverRequestWorkspaceFolders: false,
	emptyDiagnosticsMessage: "ty LSP found no Python files to check.",
	formatDiagnosticsHeader: (summary) =>
		`ty LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`,
	editSummaryLabel: "ty",
};

export const ruffAdapter: LspServerAdapter = {
	label: "Ruff",
	statusPrefix: "🐍 ruff",
	defaultCommand: { command: "ruff", args: ["server"] },
	commandEnvVar: "PI_RUFF_LSP_COMMAND",
	timeoutEnvVar: "PI_RUFF_LSP_TIMEOUT_MS",
	missingCommandHint: "Install ruff or set PI_RUFF_LSP_COMMAND.",
	skipDirectories: PYTHON_SKIP_DIRECTORIES,
	isSupportedFile: isPythonFile,
	languageIdFor: () => "python",
	formattingOptions: { tabSize: 4, insertSpaces: true },
	initialize: {
		codeAction: true,
		diagnosticDynamicRegistration: false,
	},
	fallbackToPublishDiagnostics: false,
	resolveUnsupportedCodeActions: false,
	serverRequestWorkspaceFolders: false,
	emptyDiagnosticsMessage: "Ruff LSP found no Python files to check.",
	formatDiagnosticsHeader: (summary) =>
		`Ruff LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`,
	editSummaryLabel: "Ruff",
	defaultFixKind: "source.fixAll.ruff",
};

export const adapters = [biomeAdapter, tyAdapter, ruffAdapter] as const;

function biomeLanguageIdFor(filePath: string) {
	const extension = path.extname(filePath);
	if (extension === ".js" || extension === ".cjs" || extension === ".mjs") return "javascript";
	if (extension === ".jsx") return "javascriptreact";
	if (extension === ".ts" || extension === ".cts" || extension === ".mts") return "typescript";
	if (extension === ".tsx") return "typescriptreact";
	if (extension === ".gql") return "graphql";
	if (extension === ".jsonc") return "jsonc";
	return extension.slice(1);
}

function isPythonFile(filePath: string) {
	return filePath.endsWith(".py") || filePath.endsWith(".pyi");
}
