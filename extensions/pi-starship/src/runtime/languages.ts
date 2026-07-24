import { delimiter, join } from "node:path";
import {
	directMatch,
	formatVersion,
	MAX_METADATA_FILE_BYTES,
	optionString,
	optionStrings,
	pathName,
	runBounded,
	safeMetadata,
} from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

const LANGUAGE_NAMES = ["nodejs", "python", "rust", "golang", "bun", "deno"] as const;
type LanguageName = (typeof LANGUAGE_NAMES)[number];

const DEFAULT_DETECTION: Record<
	LanguageName,
	{ files: string[]; extensions: string[]; folders: string[] }
> = {
	nodejs: {
		files: [
			"package.json",
			".node-version",
			".nvmrc",
			"!bun.lock",
			"!bun.lockb",
			"!deno.json",
			"!deno.jsonc",
		],
		extensions: ["js", "mjs", "cjs", "ts", "mts", "cts"],
		folders: ["node_modules"],
	},
	python: {
		files: ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock", ".python-version"],
		extensions: ["py"],
		folders: [".venv", "venv"],
	},
	rust: { files: ["Cargo.toml"], extensions: ["rs"], folders: [] },
	golang: { files: ["go.mod", "go.sum", "go.work"], extensions: ["go"], folders: [] },
	bun: { files: ["bun.lock", "bun.lockb", "bunfig.toml"], extensions: [], folders: [] },
	deno: { files: ["deno.json", "deno.jsonc", "deno.lock"], extensions: [], folders: [] },
};

export async function collectLanguages(context: CollectorContext): Promise<MutableModuleSnapshot> {
	const result: MutableModuleSnapshot = {};
	if (!LANGUAGE_NAMES.some((name) => context.needs(name))) return result;
	const entries = await context.entries();
	for (const name of LANGUAGE_NAMES) {
		if (!context.needs(name)) continue;
		const defaults = DEFAULT_DETECTION[name];
		const files = optionStrings(context, name, "detect_files");
		const extensions = optionStrings(context, name, "detect_extensions");
		const folders = optionStrings(context, name, "detect_folders");
		if (
			!directMatch(
				entries,
				files.length > 0 ? files : defaults.files,
				extensions.length > 0 ? extensions : defaults.extensions,
				folders.length > 0 ? folders : defaults.folders,
			)
		) {
			continue;
		}
		const values: Record<string, string> = {};
		addEnvironmentValues(context, name, values);
		if (context.needs(name, "engines_version")) {
			const engine = await readNodeEngine(context);
			if (engine) values.engines_version = engine;
		}
		if (context.needs(name, "version")) {
			const command = await versionCommand(context, name);
			if (command) {
				const output = await runBounded(context, command[0], command[1]);
				const version = output ? parseRuntimeVersion(name, output) : undefined;
				if (version) {
					values.version = formatVersion(version, optionString(context, name, "version_format"));
					if (name === "rust") values.numver = version.replace(/^v/u, "");
				}
			}
		}
		result[name] = values;
	}
	return result;
}

function addEnvironmentValues(
	context: CollectorContext,
	name: LanguageName,
	values: Record<string, string>,
): void {
	const env = context.input.environment;
	if (name === "python") {
		const virtualenv = safeMetadata(env.VIRTUAL_ENV ?? env.CONDA_DEFAULT_ENV);
		if (virtualenv && context.needs(name, "virtualenv")) values.virtualenv = pathName(virtualenv);
		const pyenv = safeMetadata(env.PYENV_VERSION);
		if (pyenv && context.needs(name, "pyenv_prefix")) values.pyenv_prefix = pyenv;
	}
	if (name === "rust") {
		const toolchain = safeMetadata(env.RUSTUP_TOOLCHAIN);
		if (toolchain && context.needs(name, "toolchain")) values.toolchain = toolchain;
	}
}

async function readNodeEngine(context: CollectorContext): Promise<string | undefined> {
	const source = await context.fs.readFile(
		join(context.input.cwd, "package.json"),
		MAX_METADATA_FILE_BYTES,
	);
	if (!source) return undefined;
	try {
		const document = JSON.parse(source) as { engines?: { node?: unknown } };
		return safeMetadata(document.engines?.node, 80);
	} catch {
		return undefined;
	}
}

async function versionCommand(
	context: CollectorContext,
	name: LanguageName,
): Promise<[string, string[]] | undefined> {
	switch (name) {
		case "nodejs":
			return ["node", ["--version"]];
		case "python": {
			const virtualenv = safeMetadata(context.input.environment.VIRTUAL_ENV);
			if (virtualenv) {
				const candidate = join(
					virtualenv,
					context.input.platform === "win32" ? "Scripts/python.exe" : "bin/python",
				);
				if (await context.fs.fileExists(candidate)) return [candidate, ["--version"]];
			}
			return ["python", ["--version"]];
		}
		case "rust": {
			const rustc = await safeRustCompiler(context);
			return rustc ? [rustc, ["--version"]] : undefined;
		}
		case "golang":
			return ["go", ["version"]];
		case "bun":
			return ["bun", ["--version"]];
		case "deno":
			return ["deno", ["-V"]];
	}
}

async function safeRustCompiler(context: CollectorContext): Promise<string | undefined> {
	const candidates = [
		context.input.environment.RUSTC,
		...(context.input.environment.PATH ?? "")
			.split(delimiter)
			.filter(Boolean)
			.map((directory) =>
				join(directory, context.input.platform === "win32" ? "rustc.exe" : "rustc"),
			),
	];
	for (const rawCandidate of candidates) {
		const candidate = safeMetadata(rawCandidate, 1_024);
		if (!candidate || /(?:^|[\\/])\.(?:cargo|rustup)(?:[\\/]|$)/iu.test(candidate)) continue;
		if (await context.fs.fileExists(candidate)) return candidate;
	}
	return undefined;
}

export function parseRuntimeVersion(name: LanguageName, output: string): string | undefined {
	const normalized = output.trim();
	if (
		!normalized ||
		normalized.includes("\n") ||
		normalized.includes("\r") ||
		normalized.includes("�")
	) {
		return undefined;
	}
	let match: RegExpExecArray | null;
	switch (name) {
		case "nodejs":
			match = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(normalized);
			break;
		case "python":
			match = /^Python (\d+\.\d+(?:\.\d+)?(?:[0-9A-Za-z.+-]*)?)$/u.exec(normalized);
			break;
		case "rust":
			match = /^rustc (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?: .*)?$/u.exec(normalized);
			break;
		case "golang":
			match = /^go version go(\d+\.\d+(?:\.\d+)?(?:[0-9A-Za-z.+-]*))(?:\s+.*)?$/u.exec(normalized);
			break;
		case "bun":
			match = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(normalized);
			break;
		case "deno":
			match = /^(?:deno\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(normalized);
			break;
	}
	const version = match?.[1];
	return version ? `v${version}` : undefined;
}
