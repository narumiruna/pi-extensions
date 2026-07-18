import path from "node:path";
import { commandExists, commandFromEnv, commandPathValue } from "./command.js";
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
	const skipped: DiagnosticRoute[] = [];
	const runnableCandidates = params.server
		? candidates
		: candidates.filter((adapter) => {
				if (!adapter.isDefault) return true;
				const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
				if (commandExists(command.command, root, commandPathValue(adapter.env))) return true;
				skipped.push({ adapter, reason: `${adapter.name} command missing`, files: [] });
				return false;
			});

	if (runnableCandidates.length === 0 && skipped.length > 0) {
		const names = skipped.map((route) => route.adapter.name).join(", ");
		throw new Error(
			`No available default LSP commands: ${names}. ` +
				"Install a matching server command or explicitly select a configured server.",
		);
	}

	const filesByPolicy = new Map<string, string[]>();
	const routes = runnableCandidates
		.map((adapter) => {
			const key = diagnosticFilePolicyKey(adapter);
			let files = filesByPolicy.get(key);
			if (!files) {
				files = collectSupportedFiles(adapter, root, params.paths, params.limit ?? defaultLimit);
				filesByPolicy.set(key, files);
			}
			return { adapter, reason: `${adapter.name} diagnostics`, files };
		})
		.filter((route) => route.files.length > 0);

	if (routes.length === 0) {
		const scope = params.paths?.length ? ` in requested paths: ${params.paths.join(", ")}` : "";
		if (skipped.length > 0) {
			const names = skipped.map((route) => route.adapter.name).join(", ");
			throw new Error(
				`No supported files found for available LSP commands${scope}. ` +
					`Skipped unavailable default LSP commands: ${names}. ` +
					"Install a matching server command or explicitly select a configured server.",
			);
		}
		throw new Error(`No supported files found${scope}. ${SUPPORTED_SERVER_DESCRIPTION}`);
	}

	return { root, routes, skipped };
}

export function selectFixRoute(adapters: LspServerAdapter[], params: SingleFileRouteParams) {
	const root = resolveRoot(params.root);
	const file = path.resolve(root, params.path);
	const candidates = filterAdapters(adapters, params.server).filter((adapter) =>
		adapter.isSupportedFile(file),
	);
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

function diagnosticFilePolicyKey(adapter: LspServerAdapter) {
	return JSON.stringify([
		adapter.extensions,
		[...adapter.skipDirectories].sort((left, right) => left.localeCompare(right)),
	]);
}

function filterAdapters(adapters: LspServerAdapter[], selected: string | string[] | undefined) {
	if (!selected) return adapters;
	const names = [
		...new Set((Array.isArray(selected) ? selected : [selected]).map((name) => name.trim())),
	].filter((name) => name.length > 0);
	if (names.length === 0) throw new Error("LSP server parameter must not be blank.");
	const matched = adapters.filter((adapter) => names.includes(adapter.name));
	const missing = names.filter((name) => !adapters.some((adapter) => adapter.name === name));
	if (missing.length) throw new Error(`Unknown LSP server(s): ${missing.join(", ")}.`);
	return matched;
}

function unsupportedFileError(action: LspAction, filePath: string, server: string | undefined) {
	const override = server ? ` for server '${server}'` : "";
	return new Error(
		`No ${action} route supports ${filePath}${override}. ${SUPPORTED_SERVER_DESCRIPTION}`,
	);
}
