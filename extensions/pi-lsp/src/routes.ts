import path from "node:path";
import { biomeAdapter, ruffAdapter, tyAdapter } from "./adapters.js";
import { collectSupportedFiles, resolveRoot } from "./files.js";
import type { LspServerAdapter } from "./types.js";

export type LanguageFamily = "web" | "python";
export type DiagnosticChecker = "type" | "lint" | "all";
export type LspAction = "diagnostics" | "format" | "fix";

export interface DiagnosticRoute {
	adapter: LspServerAdapter;
	language: LanguageFamily;
	checker?: DiagnosticChecker;
	reason: string;
	files: string[];
}

export interface SingleFileRoute {
	adapter: LspServerAdapter;
	language: LanguageFamily;
	reason: string;
}

export interface DiagnosticRouteParams {
	root?: string;
	paths?: string[];
	limit?: number;
	language?: LanguageFamily;
	checker?: DiagnosticChecker;
}

export interface SingleFileRouteParams {
	root?: string;
	path: string;
	language?: LanguageFamily;
}

export const SUPPORTED_LANGUAGE_DESCRIPTION =
	"Supported language/file classes: web/config files supported by Biome, and Python .py/.pyi files.";

export function selectDiagnosticRoutes(params: DiagnosticRouteParams, defaultLimit: number) {
	const root = resolveRoot(params.root);
	const checker = params.checker ?? "all";
	const candidates = diagnosticCandidates(params.language, checker);
	const filesByLanguage = new Map<LanguageFamily, string[]>();
	const routes = candidates
		.map((candidate) => {
			let files = filesByLanguage.get(candidate.language);
			if (!files) {
				files = collectSupportedFiles(
					discoveryAdapterFor(candidate.language),
					root,
					params.paths,
					params.limit ?? defaultLimit,
				);
				filesByLanguage.set(candidate.language, files);
			}
			return { ...candidate, files };
		})
		.filter((route) => route.files.length > 0);

	if (routes.length === 0) {
		const scope = params.paths?.length ? ` in requested paths: ${params.paths.join(", ")}` : "";
		throw new Error(`No supported files found${scope}. ${SUPPORTED_LANGUAGE_DESCRIPTION}`);
	}

	return { root, routes };
}

export function selectFormatRoute(params: SingleFileRouteParams) {
	return selectSingleFileRoute("format", params);
}

export function selectFixRoute(params: SingleFileRouteParams) {
	return selectSingleFileRoute("fix", params);
}

function diagnosticCandidates(language: LanguageFamily | undefined, checker: DiagnosticChecker) {
	if (language === "web") {
		return [
			{
				adapter: biomeAdapter,
				language,
				reason: "Biome-supported web/config diagnostics",
			},
		];
	}

	if (language === "python") return pythonDiagnosticCandidates(checker);

	return [
		{
			adapter: biomeAdapter,
			language: "web" as const,
			reason: "Biome-supported web/config diagnostics",
		},
		...pythonDiagnosticCandidates(checker),
	];
}

function discoveryAdapterFor(language: LanguageFamily) {
	if (language === "web") return biomeAdapter;
	return ruffAdapter;
}

function pythonDiagnosticCandidates(checker: DiagnosticChecker) {
	const routes: Array<Omit<DiagnosticRoute, "files">> = [];
	if (checker === "type" || checker === "all") {
		routes.push({
			adapter: tyAdapter,
			language: "python",
			checker: "type",
			reason: "Python type diagnostics through ty",
		});
	}
	if (checker === "lint" || checker === "all") {
		routes.push({
			adapter: ruffAdapter,
			language: "python",
			checker: "lint",
			reason: "Python lint diagnostics through Ruff",
		});
	}
	return routes;
}

function selectSingleFileRoute(action: "format" | "fix", params: SingleFileRouteParams) {
	const root = resolveRoot(params.root);
	const file = path.resolve(root, params.path);
	const webSupported = biomeAdapter.isSupportedFile(file);
	const pythonSupported = ruffAdapter.isSupportedFile(file);

	if (params.language === "web") {
		if (!webSupported) throw unsupportedFileError(action, params.path, params.language);
		return {
			root,
			route: {
				adapter: biomeAdapter,
				language: "web" as const,
				reason: `Biome-supported web/config ${action}`,
			},
		};
	}

	if (params.language === "python") {
		if (!pythonSupported) throw unsupportedFileError(action, params.path, params.language);
		return {
			root,
			route: {
				adapter: ruffAdapter,
				language: "python" as const,
				reason: `Python ${action} through Ruff`,
			},
		};
	}

	if (webSupported) {
		return {
			root,
			route: {
				adapter: biomeAdapter,
				language: "web" as const,
				reason: `Biome-supported web/config ${action}`,
			},
		};
	}

	if (pythonSupported) {
		return {
			root,
			route: {
				adapter: ruffAdapter,
				language: "python" as const,
				reason: `Python ${action} through Ruff`,
			},
		};
	}

	throw unsupportedFileError(action, params.path, params.language);
}

function unsupportedFileError(
	action: LspAction,
	filePath: string,
	language: LanguageFamily | undefined,
) {
	const override = language ? ` for language override '${language}'` : "";
	return new Error(
		`No ${action} route supports ${filePath}${override}. ${SUPPORTED_LANGUAGE_DESCRIPTION}`,
	);
}
