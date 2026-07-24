import { join } from "node:path";
import { parse } from "smol-toml";
import {
	formatVersion,
	isRecord,
	MAX_METADATA_FILE_BYTES,
	optionString,
	parentDirectories,
	safeMetadata,
} from "./helpers.js";
import type { CollectorContext } from "./types.js";

export async function collectPackage(
	context: CollectorContext,
): Promise<Record<string, string> | undefined> {
	if (!context.needs("package")) return undefined;
	const versionFormat = optionString(context, "package", "version_format");
	for (const reader of [readPackageJson, readCargo, readPyproject]) {
		const result = await reader(context);
		if (!result) continue;
		return {
			source: result.source,
			version: formatVersion(result.version, versionFormat),
		};
	}
	return undefined;
}

interface PackageVersion {
	version: string;
	source: string;
}

async function readPackageJson(context: CollectorContext): Promise<PackageVersion | undefined> {
	const source = await context.fs.readFile(
		join(context.input.cwd, "package.json"),
		MAX_METADATA_FILE_BYTES,
	);
	if (!source) return undefined;
	try {
		const document = JSON.parse(source) as unknown;
		const version = isRecord(document) ? safeVersion(document.version) : undefined;
		return version ? { version, source: "package.json" } : undefined;
	} catch {
		return undefined;
	}
}

async function readCargo(context: CollectorContext): Promise<PackageVersion | undefined> {
	const path = join(context.input.cwd, "Cargo.toml");
	const source = await context.fs.readFile(path, MAX_METADATA_FILE_BYTES);
	if (!source) return undefined;
	try {
		const document = parse(source);
		const packageTable = isRecord(document.package) ? document.package : undefined;
		const direct = safeVersion(packageTable?.version);
		if (direct) return { version: direct, source: "Cargo.toml" };
		const inherited = isRecord(packageTable?.version) && packageTable.version.workspace === true;
		if (!inherited) return undefined;
		for (const parent of parentDirectories(context.input.cwd, 8)) {
			const parentSource = await context.fs.readFile(
				join(parent, "Cargo.toml"),
				MAX_METADATA_FILE_BYTES,
			);
			if (!parentSource) continue;
			const parentDocument = parse(parentSource);
			const workspace = isRecord(parentDocument.workspace) ? parentDocument.workspace : undefined;
			const workspacePackage = isRecord(workspace?.package) ? workspace.package : undefined;
			const version = safeVersion(workspacePackage?.version);
			if (version) return { version, source: "Cargo.toml workspace" };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function readPyproject(context: CollectorContext): Promise<PackageVersion | undefined> {
	const source = await context.fs.readFile(
		join(context.input.cwd, "pyproject.toml"),
		MAX_METADATA_FILE_BYTES,
	);
	if (!source) return undefined;
	try {
		const document = parse(source);
		const project = isRecord(document.project) ? document.project : undefined;
		if (Array.isArray(project?.dynamic) && project.dynamic.includes("version")) return undefined;
		const pepVersion = safeVersion(project?.version);
		if (pepVersion) return { version: pepVersion, source: "pyproject.toml (PEP 621)" };
		const tool = isRecord(document.tool) ? document.tool : undefined;
		const poetry = isRecord(tool?.poetry) ? tool.poetry : undefined;
		const poetryVersion = safeVersion(poetry?.version);
		return poetryVersion
			? { version: poetryVersion, source: "pyproject.toml (Poetry)" }
			: undefined;
	} catch {
		return undefined;
	}
}

function safeVersion(value: unknown): string | undefined {
	const version = safeMetadata(value, 80);
	return version && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u.test(version) ? version : undefined;
}
