import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	buildExtensionStatusIconAliases,
	type ExtensionStatusIconAliasMap,
} from "./modules/index.js";

export interface InstalledPackage {
	packageName: string;
	source: string;
}

export interface InstalledPackageInfo {
	packages: InstalledPackage[];
	aliases: ExtensionStatusIconAliasMap;
	hasStatuslineConflict: boolean;
}

export function readInstalledPackageInfo(
	agentDir: string,
	cwd: string,
	projectTrusted: boolean,
): InstalledPackageInfo {
	const settingsPaths = [
		join(agentDir, "settings.json"),
		...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, "settings.json")] : []),
	];
	const packages = settingsPaths.flatMap(readPackagesFromSettings);
	return {
		packages,
		aliases: buildExtensionStatusIconAliases(packages),
		hasStatuslineConflict: packages.some(
			(item) =>
				item.packageName === "@narumitw/pi-statusline" || item.packageName === "pi-statusline",
		),
	};
}

function readPackagesFromSettings(settingsPath: string): InstalledPackage[] {
	if (!existsSync(settingsPath)) return [];
	let entries: unknown[];
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
		entries = Array.isArray(parsed.packages) ? parsed.packages : [];
	} catch {
		return [];
	}
	const baseDirectory = dirname(settingsPath);
	return entries.flatMap((entry) => {
		const source =
			typeof entry === "string"
				? entry
				: entry &&
						typeof entry === "object" &&
						typeof (entry as { source?: unknown }).source === "string"
					? (entry as { source: string }).source
					: undefined;
		if (!source) return [];
		const packageName = packageNameForSource(source, baseDirectory);
		return packageName ? [{ packageName, source }] : [];
	});
}

function packageNameForSource(source: string, baseDirectory: string): string | undefined {
	if (source.startsWith("npm:")) return npmPackageName(source);
	const packageJson = join(resolveSourcePath(source, baseDirectory), "package.json");
	try {
		const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
		return typeof parsed.name === "string" ? parsed.name : undefined;
	} catch {
		return undefined;
	}
}

function npmPackageName(source: string): string {
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@").replace(/^@/u, "@");
	return spec.split("@")[0] ?? spec;
}

function resolveSourcePath(source: string, baseDirectory: string): string {
	return isAbsolute(source) ? source : resolve(baseDirectory, source);
}
