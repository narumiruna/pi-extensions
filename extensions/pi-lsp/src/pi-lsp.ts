import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadRuntime } from "./adapters.js";
import { commandExists, commandFromEnv } from "./command.js";
import { resolveRoot } from "./files.js";
import { selectDiagnosticRoutes, selectFixRoute } from "./routes.js";
import { DEFAULT_FILE_LIMIT, runDiagnostics, runFix, textResult } from "./runner.js";

const STATUS_KEY = "lsp";

const ServerParameter = Type.Optional(
	Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			"Optional configured LSP server name, or names for diagnostics. Defaults to all servers matching the file extension.",
	}),
);

const DiagnosticsParameters = Type.Object({
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Files or directories to check. Defaults to the workspace root and routes by configured server extensions.",
		}),
	),
	root: Type.Optional(
		Type.String({ description: "Workspace root for language servers. Defaults to cwd." }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum files to open per selected server." })),
	server: ServerParameter,
});

const SingleFileParameters = {
	path: Type.String({
		description: "File to process. The server is selected from configured file extensions.",
	}),
	root: Type.Optional(
		Type.String({ description: "Workspace root for language servers. Defaults to cwd." }),
	),
	write: Type.Optional(
		Type.Boolean({ description: "Write changed text back to the file. Defaults to false." }),
	),
	server: Type.Optional(
		Type.String({
			description: "Optional configured LSP server name. Defaults to extension-based inference.",
		}),
	),
};

const lspDiagnosticsTool = defineTool({
	name: "lsp_diagnostics",
	label: "LSP: Diagnostics",
	description: "Run diagnostics using configured, language-agnostic LSP server routes.",
	promptSnippet: "Get diagnostics from configured LSP servers selected by file extension",
	promptGuidelines: [
		"Use lsp_diagnostics when files need diagnostics from a configured LSP server.",
		"Use the server parameter only when the user asks for a specific configured LSP server or multiple servers match the same extension.",
		"If a configured server command is missing, report the configuration error and suggest installing the command or setting its PI_<SERVER>_LSP_COMMAND environment variable.",
	],
	parameters: DiagnosticsParameters,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const requestedRoot = resolveRoot(params.root);
		const { adapters, timeoutMs } = loadRuntime(requestedRoot);
		const { root, routes } = selectDiagnosticRoutes(
			adapters,
			{ ...params, root: requestedRoot },
			DEFAULT_FILE_LIMIT,
		);
		const results = [];
		for (const route of routes) {
			const result = await runDiagnostics(
				route.adapter,
				{ root, paths: params.paths, limit: params.limit, files: route.files },
				timeoutMs,
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
				server: route.adapter.name,
				backend: route.adapter.name,
				reason: route.reason,
				files: route.files,
				details: result.details,
			})),
		});
	},
});

const lspFixTool = defineTool({
	name: "lsp_fix",
	label: "LSP: Fix",
	description: "Apply source fixes or import organization using configured LSP server routes.",
	promptSnippet: "Apply configured LSP source fixes to a file",
	promptGuidelines: [
		"Use lsp_fix for files handled by a configured LSP code-action server.",
		"Use kind when the server needs a specific source action kind such as source.organizeImports.",
	],
	parameters: Type.Object({
		...SingleFileParameters,
		kind: Type.Optional(
			Type.String({
				description: "Source action kind. Defaults to source.fixAll.",
			}),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const requestedRoot = resolveRoot(params.root);
		const { adapters, timeoutMs } = loadRuntime(requestedRoot);
		const { root, route } = selectFixRoute(adapters, { ...params, root: requestedRoot });
		return runFix(
			route.adapter,
			{ root, path: params.path, kind: params.kind, write: params.write },
			timeoutMs,
			signal,
			ctx,
			STATUS_KEY,
		);
	},
});

export default function lsp(pi: ExtensionAPI) {
	pi.registerTool(lspDiagnosticsTool);
	pi.registerTool(lspFixTool);

	pi.registerCommand("lsp", {
		description: "Show shared LSP extension configuration",
		handler: async (_args, ctx) => {
			const { adapters } = loadRuntime(ctx.cwd);
			ctx.ui.notify(buildStatusMessage(adapters, ctx.cwd), statusLevel(adapters, ctx.cwd));
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

function buildStatusMessage(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
	return adapters
		.flatMap((adapter) => {
			const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
			return [
				`${adapter.name} LSP command: ${command.command} ${command.args.join(" ")}`.trim(),
				`${adapter.name} status: ${commandExists(command.command, cwd) ? "ready" : "command missing"}`,
			];
		})
		.join("\n");
}

function statusLevel(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
	return adapters.every((adapter) => {
		const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
		return commandExists(command.command, cwd);
	})
		? "info"
		: "warning";
}
