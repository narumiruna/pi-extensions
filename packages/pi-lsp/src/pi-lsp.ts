import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { consumeLspConfigNotice, loadRuntime } from "./adapters.js";
import { commandExists, commandPathValue } from "./command.js";
import { resolveRoot } from "./files.js";
import { selectDiagnosticRoutes, selectFixRoute } from "./routes.js";
import { clearStatus, DEFAULT_FILE_LIMIT, runDiagnostics, runFix, textResult } from "./runner.js";
import { LspSessionScope } from "./session-lifecycle.js";

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
		"If a configured server command is missing, report the configuration error and suggest installing it or updating the server's command in pi-lsp.json.",
	],
	parameters: DiagnosticsParameters,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const requestedRoot = resolveRoot(params.root);
		const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const { root, routes, skipped } = selectDiagnosticRoutes(
			adapters,
			{ ...params, root: requestedRoot },
			DEFAULT_FILE_LIMIT,
		);
		const results = [];
		for (const route of routes) {
			signal?.throwIfAborted();
			const result = await runDiagnostics(
				route.adapter,
				{ root, paths: params.paths, limit: params.limit, files: route.files },
				timeoutMs,
				signal,
				ctx,
				STATUS_KEY,
			);
			signal?.throwIfAborted();
			results.push({ route, result });
		}

		const sections = results.map(
			({ route, result }) => `${route.reason}\n\n${textFromResult(result)}`,
		);
		if (skipped.length) {
			sections.push(
				`Skipped unavailable default LSP server(s): ${skipped
					.map((route) => route.adapter.name)
					.join(", ")}.`,
			);
		}
		return textResult(sections.join("\n\n---\n\n"), {
			root,
			skipped: skipped.map((route) => ({
				server: route.adapter.name,
				reason: route.reason,
				files: route.files,
			})),
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
		const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
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
	const sessions = new WeakMap<object, { scope: LspSessionScope; generation: number }>();
	const sessionFor = (key: object) => {
		let session = sessions.get(key);
		if (!session) {
			session = { scope: new LspSessionScope(), generation: 0 };
			sessions.set(key, session);
		}
		return session;
	};

	pi.registerTool({
		...lspDiagnosticsTool,
		execute(id, params, signal, onUpdate, ctx) {
			const { scope } = sessionFor(ctx.sessionManager);
			return scope.run(signal, (ownedSignal) =>
				lspDiagnosticsTool.execute(id, params, ownedSignal, onUpdate, scope.context(ctx)),
			);
		},
	});
	pi.registerTool({
		...lspFixTool,
		execute(id, params, signal, onUpdate, ctx) {
			const { scope } = sessionFor(ctx.sessionManager);
			return scope.run(signal, (ownedSignal) =>
				lspFixTool.execute(id, params, ownedSignal, onUpdate, scope.context(ctx)),
			);
		},
	});

	pi.registerCommand("lsp", {
		description: "Show shared LSP extension configuration",
		handler: async (_args, ctx) => {
			try {
				const { adapters } = loadRuntime(ctx.cwd, {
					projectTrusted: ctx.isProjectTrusted(),
				});
				const notice = consumeLspConfigNotice();
				if (notice) ctx.ui.notify(notice, "warning");
				ctx.ui.notify(buildStatusMessage(adapters, ctx.cwd), statusLevel(adapters, ctx.cwd));
			} catch (error) {
				ctx.ui.notify(`LSP config ignored: ${formatError(error)}`, "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const session = sessionFor(ctx.sessionManager);
		const generation = ++session.generation;
		await session.scope.close();
		if (generation !== session.generation) return;
		session.scope = new LspSessionScope();
		clearStatus(ctx, STATUS_KEY);
		try {
			loadRuntime(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
			const notice = consumeLspConfigNotice();
			if (notice) ctx.ui.notify(notice, "warning");
		} catch (error) {
			ctx.ui.notify(`LSP config ignored: ${formatError(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const session = sessionFor(ctx.sessionManager);
		session.generation++;
		const drained = session.scope.close();
		clearStatus(ctx, STATUS_KEY);
		await drained;
	});
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function textFromResult(result: { content?: Array<{ type?: string; text?: string }> }) {
	return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function buildStatusMessage(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
	return adapters
		.flatMap((adapter) => {
			const command = adapter.defaultCommand;
			return [
				`${adapter.name} LSP command: ${command.command} ${command.args.join(" ")}`.trim(),
				`${adapter.name} status: ${
					commandExists(command.command, cwd, commandPathValue(adapter.env))
						? "ready"
						: "command missing"
				}`,
			];
		})
		.join("\n");
}

function statusLevel(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
	return adapters.every((adapter) => {
		const command = adapter.defaultCommand;
		return commandExists(command.command, cwd, commandPathValue(adapter.env));
	})
		? "info"
		: "warning";
}
