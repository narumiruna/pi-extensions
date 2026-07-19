import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface EffectivePiImageSettings {
	autoResize: boolean;
	blockImages: boolean;
	warnings: string[];
}

interface ImageSettingsPatch {
	autoResize?: boolean;
	blockImages?: boolean;
}

export async function readEffectivePiImageSettings(
	cwd: string,
	projectTrusted: boolean,
): Promise<EffectivePiImageSettings> {
	const warnings: string[] = [];
	const global = await readPatch(join(getAgentDir(), "settings.json"), warnings);
	const project = projectTrusted
		? await readPatch(join(cwd, CONFIG_DIR_NAME, "settings.json"), warnings)
		: undefined;
	return {
		autoResize: project?.autoResize ?? global?.autoResize ?? true,
		blockImages: project?.blockImages ?? global?.blockImages ?? false,
		warnings,
	};
}

async function readPatch(
	path: string,
	warnings: string[],
): Promise<ImageSettingsPatch | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		warnings.push(`Could not read Pi image settings from ${path}: ${formatError(error)}`);
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed)) return undefined;
		const images = parsed.images;
		if (images === undefined) return undefined;
		if (!isRecord(images)) {
			warnings.push(`Ignored invalid Pi images settings in ${path}.`);
			return undefined;
		}
		const patch: ImageSettingsPatch = {};
		if (typeof images.autoResize === "boolean") patch.autoResize = images.autoResize;
		else if (images.autoResize !== undefined) {
			warnings.push(`Ignored non-boolean images.autoResize in ${path}.`);
		}
		if (typeof images.blockImages === "boolean") patch.blockImages = images.blockImages;
		else if (images.blockImages !== undefined) {
			warnings.push(`Ignored non-boolean images.blockImages in ${path}.`);
		}
		return patch;
	} catch (error) {
		warnings.push(`Could not parse Pi image settings from ${path}: ${formatError(error)}`);
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
