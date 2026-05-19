import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { adapters } from "./adapters.js";
import { commandExists, commandFromEnv } from "./command.js";
import { selectDiagnosticRoutes, selectFixRoute, selectFormatRoute } from "./routes.js";
import { DEFAULT_FILE_LIMIT, runDiagnostics, runFix, runFormat, textResult } from "./runner.js";

const STATUS_KEY = "lsp";

const LanguageParameter = Type.Optional(
	Type.Union([Type.Literal("web"), Type.Literal("python")], {
		description:
			"Optional language/file class override. Defaults to file-extension inference. Use 'web' for Biome-supported web/config files or 'python' for .py/.pyi files.",
	}),
);

const DiagnosticsParameters = Type.Object({
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Files or directories to check. Defaults to the workspace root and routes by supported file extensions.",
		}),
	),
	root: Type.Optional(
		Type.String({ description: "Workspace root for language servers. Defaults to cwd." }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum files to open per selected route." })),
	language: LanguageParameter,
	checker: Type.Optional(
		Type.Union([Type.Literal("type"), Type.Literal("lint"), Type.Literal("all")], {
			description:
				"Python diagnostics checker: 'type' uses ty, 'lint' uses Ruff, and 'all' runs both. Defaults to 'all'. Ignored for web/config diagnostics.",
		}),
	),
});

const SingleFileParameters = {
	path: Type.String({
		description: "File to process. The route is selected from the file extension.",
	}),
	root: Type.Optional(
		Type.String({ description: "Workspace root for language servers. Defaults to cwd." }),
	),
	write: Type.Optional(
		Type.Boolean({ description: "Write changed text back to the file. Defaults to false." }),
	),
	language: LanguageParameter,
};

const lspDiagnosticsTool = defineTool({
	name: "lsp_diagnostics",
	label: "LSP: Diagnostics",
	description:
		"Run diagnostics using language/file-extension routing: Biome for supported web/config files, ty for Python type diagnostics, and Ruff for Python lint diagnostics.",
	promptSnippet: "Get language-routed LSP diagnostics for web/config or Python files",
	promptGuidelines: [
		"Use lsp_diagnostics when JavaScript, TypeScript, JSON, CSS, GraphQL, HTML, Vue, Astro, Svelte, or Python files need LSP diagnostics.",
		"For Python diagnostics, use checker='type' for ty, checker='lint' for Ruff, or checker='all' when both type and lint diagnostics are useful.",
		"If a routed backend is missing, report the configuration error and suggest installing the backend or setting its PI_*_LSP_COMMAND environment variable.",
	],
	parameters: DiagnosticsParameters,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const { root, routes } = selectDiagnosticRoutes(params, DEFAULT_FILE_LIMIT);
		const results = [];
		for (const route of routes) {
			const result = await runDiagnostics(
				route.adapter,
				{ root, paths: params.paths, limit: params.limit, files: route.files },
				signal,
				ctx,
				STATUS_KEY,
			);
			results.push({ route, result });
		}

		const text = results
			.map(({ route, result }) => `${route.reason}\n\n${textFromResult(result)}`)
			.join("\n\n---\n\n");
		return textResult(text, {
			root,
			routes: results.map(({ route, result }) => ({
				language: route.language,
				checker: route.checker,
				backend: route.adapter.label,
				reason: route.reason,
				files: route.files,
				details: result.details,
			})),
		});
	},
});

const lspFormatTool = defineTool({
	name: "lsp_format",
	label: "LSP: Format",
	description:
		"Format one file using language/file-extension routing: Biome for supported web/config files and Ruff for Python files.",
	promptSnippet: "Format a file through the routed LSP formatter",
	promptGuidelines: [
		"Use lsp_format for Biome-supported web/config files or Python .py/.pyi files.",
		"Do not request ty for formatting; Python formatting routes to Ruff.",
	],
	parameters: Type.Object(SingleFileParameters),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const { root, route } = selectFormatRoute(params);
		return runFormat(
			route.adapter,
			{ root, path: params.path, write: params.write },
			signal,
			ctx,
			STATUS_KEY,
		);
	},
});

const lspFixTool = defineTool({
	name: "lsp_fix",
	label: "LSP: Fix",
	description:
		"Apply source fixes or import organization using language/file-extension routing: Biome for supported web/config files and Ruff for Python files.",
	promptSnippet: "Apply routed LSP source fixes to a file",
	promptGuidelines: [
		"Use lsp_fix for Biome-supported web/config files or Python .py/.pyi files.",
		"Use kind='source.organizeImports.biome' for Biome import organization or kind='source.organizeImports.ruff' for Python import organization when needed.",
		"Do not request ty for fixes; Python fixes route to Ruff.",
	],
	parameters: Type.Object({
		...SingleFileParameters,
		kind: Type.Optional(
			Type.String({
				description:
					"Source action kind. Defaults to the routed backend's fix-all action. Common values: source.organizeImports.biome or source.organizeImports.ruff.",
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const { root, route } = selectFixRoute(params);
		return runFix(
			route.adapter,
			{ root, path: params.path, kind: params.kind, write: params.write },
			signal,
			ctx,
			STATUS_KEY,
		);
	},
});

export default function lsp(pi: ExtensionAPI) {
	pi.registerTool(lspDiagnosticsTool);
	pi.registerTool(lspFormatTool);
	pi.registerTool(lspFixTool);

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

function textFromResult(result: { content?: Array<{ type?: string; text?: string }> }) {
	return result.content?.find((item) => item.type === "text")?.text ?? "";
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
