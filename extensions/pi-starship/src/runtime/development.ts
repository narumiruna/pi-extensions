import { join } from "node:path";
import { parse } from "smol-toml";
import {
	directMatch,
	formatVersion,
	isRecord,
	MAX_METADATA_FILE_BYTES,
	optionBoolean,
	optionString,
	optionStrings,
	pathName,
	runBounded,
	safeMetadata,
	setString,
} from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

export async function collectDevelopment(
	context: CollectorContext,
): Promise<MutableModuleSnapshot> {
	const result: MutableModuleSnapshot = {};
	const directNames = ["mise", "direnv", "pixi"] as const;
	const needsListing = directNames.some((name) => context.needs(name));
	const entries = needsListing ? await context.entries() : [];

	if (
		context.needs("mise") &&
		detected(context, entries, "mise", ["mise.toml", ".mise.toml", ".tool-versions"])
	) {
		const values: Record<string, string> = {};
		if (context.needs("mise", "health")) {
			const output = await runBounded(context, "mise", ["doctor"]);
			const health = output ? parseMiseHealth(output) : undefined;
			if (health) values.health = health;
		}
		result.mise = values;
	}

	if (context.needs("direnv") && detected(context, entries, "direnv", [".envrc"])) {
		const values: Record<string, string> = {};
		if (["rc_path", "allowed", "loaded"].some((variable) => context.needs("direnv", variable))) {
			const output = await runBounded(context, "direnv", ["status", "--json"]);
			if (output) Object.assign(values, parseDirenvStatus(output));
		}
		result.direnv = values;
	}

	const conda = safeMetadata(context.input.environment.CONDA_DEFAULT_ENV);
	if (
		context.needs("conda") &&
		conda &&
		!(optionBoolean(context, "conda", "ignore_base") && conda === "base")
	) {
		result.conda = { environment: pathName(conda) };
	}

	if (context.needs("pixi") && detected(context, entries, "pixi", ["pixi.toml", "pixi.lock"])) {
		const values: Record<string, string> = {};
		const environment = safeMetadata(context.input.environment.PIXI_ENVIRONMENT_NAME);
		if (
			environment &&
			(environment !== "default" || optionBoolean(context, "pixi", "show_default_environment"))
		) {
			values.environment = environment;
		}
		const project =
			safeMetadata(context.input.environment.PIXI_PROJECT_NAME) ?? (await readPixiProject(context));
		if (project) values.project_name = project;
		if (context.needs("pixi", "version")) {
			const output = await runBounded(context, "pixi", ["--version"]);
			const version = output ? parsePixiVersion(output) : undefined;
			if (version)
				values.version = formatVersion(version, optionString(context, "pixi", "version_format"));
		}
		result.pixi = values;
	}

	const nixState = safeMetadata(context.input.environment.IN_NIX_SHELL);
	if (context.needs("nix_shell") && (nixState === "pure" || nixState === "impure")) {
		const values: Record<string, string> = { state: nixState };
		setString(values, "name", context.input.environment.NIX_SHELL_NAME);
		setString(values, "level", context.input.environment.NIX_SHELL_LEVEL);
		result.nix_shell = values;
	}

	if (context.needs("guix_shell") && safeMetadata(context.input.environment.GUIX_ENVIRONMENT)) {
		result.guix_shell = { state: "active" };
	}
	return result;
}

function detected(
	context: CollectorContext,
	entries: Awaited<ReturnType<CollectorContext["entries"]>>,
	name: "mise" | "direnv" | "pixi",
	defaultFiles: string[],
): boolean {
	const files = optionStrings(context, name, "detect_files");
	return directMatch(
		entries,
		files.length > 0 ? files : defaultFiles,
		optionStrings(context, name, "detect_extensions"),
		optionStrings(context, name, "detect_folders"),
	);
}

export function parseMiseHealth(output: string): string | undefined {
	const text = safeMetadata(output, 8_192)?.toLowerCase();
	if (!text) return undefined;
	if (/\b(?:healthy|no problems found|all checks passed)\b/u.test(text)) return "healthy";
	if (/\b(?:error|unhealthy|problem|warning)\b/u.test(text)) return "issues";
	return undefined;
}

export function parseDirenvStatus(output: string): Record<string, string> {
	try {
		const document = JSON.parse(output) as unknown;
		if (!isRecord(document)) return {};
		const values: Record<string, string> = {};
		const found = isRecord(document.foundRC) ? document.foundRC : undefined;
		const loaded = isRecord(document.loadedRC) ? document.loadedRC : undefined;
		setString(values, "rc_path", found?.path ?? loaded?.path);
		if (typeof found?.allowed === "number" || typeof found?.allowed === "boolean") {
			values.allowed = found.allowed ? "allowed" : "denied";
		}
		if (loaded) values.loaded = "loaded";
		else if (found) values.loaded = "not loaded";
		return values;
	} catch {
		const path = /^Found RC path ([^\r\n]+)$/mu.exec(output)?.[1];
		return path ? { rc_path: safeMetadata(path) ?? "" } : {};
	}
}

async function readPixiProject(context: CollectorContext): Promise<string | undefined> {
	const source = await context.fs.readFile(
		join(context.input.cwd, "pixi.toml"),
		MAX_METADATA_FILE_BYTES,
	);
	if (!source) return undefined;
	try {
		const document = parse(source);
		const project = isRecord(document.project) ? document.project : undefined;
		const workspace = isRecord(document.workspace) ? document.workspace : undefined;
		return safeMetadata(project?.name ?? workspace?.name);
	} catch {
		return undefined;
	}
}

function parsePixiVersion(output: string): string | undefined {
	const match = /^(?:pixi\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(output.trim());
	return match?.[1] ? `v${match[1]}` : undefined;
}
