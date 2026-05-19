import path from "node:path";
import { collectSupportedFiles, resolveRoot } from "./files.js";
import type { LspServerAdapter } from "./types.js";

export type LspAction = "diagnostics" | "fix";

export interface DiagnosticRoute {
	adapter: LspServerAdapter;
	reason: string;
	files: string[];
}

export interface SingleFileRoute {
	adapter: LspServerAdapter;
	reason: string;
}

export interface DiagnosticRouteParams {
	root?: string;
	paths?: string[];
	limit?: number;
	server?: string | string[];
}

export interface SingleFileRouteParams {
	root?: string;
	path: string;
	server?: string;
}

export const SUPPORTED_SERVER_DESCRIPTION =
	"Supported LSP servers are defined by pi-lsp config and selected by file extension.";

export function selectDiagnosticRoutes(
	adapters: LspServerAdapter[],
	params: DiagnosticRouteParams,
	defaultLimit: number,
) {
	const root = resolveRoot(params.root);
	const candidates = filterAdapters(adapters, params.server);
	const filesByExtensions = new Map<string, string[]>();
	const routes = candidates
		.map((adapter) => {
			const key = adapter.extensions.join("\0");
			let files = filesByExtensions.get(key);
			if (!files) {
				files = collectSupportedFiles(adapter, root, params.paths, params.limit ?? defaultLimit);
				filesByExtensions.set(key, files);
			}
			return { adapter, reason: `${adapter.name} diagnostics`, files };
		})
		.filter((route) => route.files.length > 0);

	if (routes.length === 0) {
		const scope = params.paths?.length ? ` in requested paths: ${params.paths.join(", ")}` : "";
		throw new Error(`No supported files found${scope}. ${SUPPORTED_SERVER_DESCRIPTION}`);
	}

	return { root, routes };
}

export function selectFixRoute(adapters: LspServerAdapter[], params: SingleFileRouteParams) {
	const root = resolveRoot(params.root);
	const file = path.resolve(root, params.path);
	const candidates = filterAdapters(adapters, params.server).filter((adapter) => adapter.isSupportedFile(file));
	if (candidates.length === 0) throw unsupportedFileError("fix", params.path, params.server);
	if (!params.server && candidates.length > 1) {
		throw new Error(
			`Multiple LSP servers support ${params.path}: ${candidates.map((adapter) => adapter.name).join(", ")}. ` +
				"Specify the server parameter for lsp_fix.",
		);
	}
	const adapter = candidates[0];
	return {
		root,
		route: {
			adapter,
			reason: `${adapter.name} fix`,
		},
	};
}

function filterAdapters(adapters: LspServerAdapter[], selected: string | string[] | undefined) {
	if (!selected) return adapters;
	const names = [...new Set((Array.isArray(selected) ? selected : [selected]).map((name) => name.trim()))].filter(
		(name) => name.length > 0,
	);
	if (names.length === 0) throw new Error("LSP server parameter must not be blank.");
	const matched = adapters.filter((adapter) => names.includes(adapter.name));
	const missing = names.filter((name) => !adapters.some((adapter) => adapter.name === name));
	if (missing.length) throw new Error(`Unknown LSP server(s): ${missing.join(", ")}.`);
	return matched;
}

function unsupportedFileError(action: LspAction, filePath: string, server: string | undefined) {
	const override = server ? ` for server '${server}'` : "";
	return new Error(`No ${action} route supports ${filePath}${override}. ${SUPPORTED_SERVER_DESCRIPTION}`);
}
