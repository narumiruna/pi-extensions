import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { adapters, biomeAdapter, ruffAdapter, tyAdapter } from "./adapters.js";
import { commandExists, commandFromEnv } from "./command.js";
import { runDiagnostics, runFix, runFormat } from "./runner.js";

const STATUS_KEY = "lsp";

const BiomePathsParameters = {
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Biome-supported files or directories to check. Defaults to the project root.",
		}),
	),
	root: Type.Optional(
		Type.String({ description: "Workspace root for the Biome language server. Defaults to cwd." }),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum files to open when directories are provided." }),
	),
};

const PythonPathsParameters = {
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Python files or directories to check. Defaults to the project root.",
		}),
	),
	root: Type.Optional(
		Type.String({ description: "Workspace root for the language server. Defaults to cwd." }),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum Python files to open when directories are provided." }),
	),
};

const biomeDiagnosticsTool = defineTool({
	name: "biome_lsp_diagnostics",
	label: "Biome LSP: Diagnostics",
	description: "Run Biome's language server and return diagnostics for supported files.",
	promptSnippet: "Get Biome diagnostics through the Biome language server",
	promptGuidelines: [
		"Use biome_lsp_diagnostics when JavaScript, TypeScript, JSON, CSS, GraphQL, or framework files need Biome lint/format diagnostics.",
		"If Biome is missing, report the configuration error and suggest installing @biomejs/biome or setting PI_BIOME_LSP_COMMAND.",
	],
	parameters: Type.Object(BiomePathsParameters),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runDiagnostics(biomeAdapter, params, signal, ctx, STATUS_KEY);
	},
});

const biomeFormatTool = defineTool({
	name: "biome_lsp_format",
	label: "Biome LSP: Format",
	description: "Format a Biome-supported file through Biome's language server.",
	promptSnippet: "Format a file through Biome LSP",
	parameters: Type.Object({
		path: Type.String({ description: "File to format." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the Biome language server. Defaults to cwd." }),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write formatted text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runFormat(biomeAdapter, params, signal, ctx, STATUS_KEY);
	},
});

const biomeFixTool = defineTool({
	name: "biome_lsp_fix",
	label: "Biome LSP: Fix",
	description: "Apply Biome LSP source fixes or import organization to a file.",
	promptSnippet: "Apply Biome LSP fixes to a file",
	parameters: Type.Object({
		path: Type.String({ description: "File to fix." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the Biome language server. Defaults to cwd." }),
		),
		kind: Type.Optional(
			Type.String({
				description:
					"Biome source action kind. Defaults to source.fixAll.biome. Common value: source.organizeImports.biome.",
			}),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write fixed text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runFix(biomeAdapter, params, signal, ctx, STATUS_KEY);
	},
});

const tyDiagnosticsTool = defineTool({
	name: "ty_lsp_diagnostics",
	label: "Python LSP: ty Diagnostics",
	description: "Run ty's language server and return Python type diagnostics for files.",
	promptSnippet: "Get Python type diagnostics from ty's language server",
	promptGuidelines: [
		"Use ty_lsp_diagnostics when Python changes need type-checking through ty's language server.",
		"If ty is missing, report the configuration error and suggest installing ty or setting PI_TY_LSP_COMMAND.",
	],
	parameters: Type.Object(PythonPathsParameters),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runDiagnostics(tyAdapter, params, signal, ctx, STATUS_KEY);
	},
});

const ruffDiagnosticsTool = defineTool({
	name: "ruff_lsp_diagnostics",
	label: "Python LSP: Ruff Diagnostics",
	description: "Run Ruff's language server and return Python lint diagnostics for files.",
	promptSnippet: "Get Python lint diagnostics from Ruff's language server",
	promptGuidelines: [
		"Use ruff_lsp_diagnostics when Python changes need Ruff lint checks through the language server.",
		"If ruff is missing, report the configuration error and suggest installing ruff or setting PI_RUFF_LSP_COMMAND.",
	],
	parameters: Type.Object(PythonPathsParameters),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runDiagnostics(ruffAdapter, params, signal, ctx, STATUS_KEY);
	},
});

const ruffFormatTool = defineTool({
	name: "ruff_lsp_format",
	label: "Python LSP: Ruff Format",
	description: "Format a Python file through Ruff's language server.",
	promptSnippet: "Format a Python file through Ruff LSP",
	parameters: Type.Object({
		path: Type.String({ description: "Python file to format." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the language server. Defaults to cwd." }),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write formatted text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runFormat(ruffAdapter, params, signal, ctx, STATUS_KEY);
	},
});

const ruffFixTool = defineTool({
	name: "ruff_lsp_fix",
	label: "Python LSP: Ruff Fix",
	description: "Apply Ruff LSP source fixes or import organization to a Python file.",
	promptSnippet: "Apply Ruff LSP fixes to a Python file",
	parameters: Type.Object({
		path: Type.String({ description: "Python file to fix." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the language server. Defaults to cwd." }),
		),
		kind: Type.Optional(
			Type.String({
				description:
					"Ruff source action kind. Defaults to source.fixAll.ruff. Common value: source.organizeImports.ruff.",
			}),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write fixed text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runFix(ruffAdapter, params, signal, ctx, STATUS_KEY);
	},
});

export default function lsp(pi: ExtensionAPI) {
	pi.registerTool(biomeDiagnosticsTool);
	pi.registerTool(biomeFormatTool);
	pi.registerTool(biomeFixTool);
	pi.registerTool(tyDiagnosticsTool);
	pi.registerTool(ruffDiagnosticsTool);
	pi.registerTool(ruffFormatTool);
	pi.registerTool(ruffFixTool);

	pi.registerCommand("lsp", {
		description: "Show shared LSP extension configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildStatusMessage(), statusLevel());
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

function buildStatusMessage() {
	return adapters
		.flatMap((adapter) => {
			const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
			return [
				`${adapter.label} LSP command: ${command.command} ${command.args.join(" ")}`.trim(),
				`${adapter.label} status: ${commandExists(command.command) ? "ready" : "command missing"}`,
			];
		})
		.join("\n");
}

function statusLevel() {
	return adapters.every((adapter) => {
		const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
		return commandExists(command.command);
	})
		? "info"
		: "warning";
}
