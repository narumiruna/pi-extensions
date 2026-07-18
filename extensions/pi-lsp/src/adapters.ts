import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { InternalLspServer, LspConfig, LspServerAdapter } from "./types.js";

const COMMON_SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".mypy_cache",
	".next",
	".nuxt",
	".output",
	".ruff_cache",
	".svelte-kit",
	".tox",
	".venv",
	"__pycache__",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
	"venv",
]);

const BIOME_EXTENSIONS = [
	".astro",
	".css",
	".cts",
	".cjs",
	".graphql",
	".gql",
	".html",
	".js",
	".json",
	".jsonc",
	".jsx",
	".mjs",
	".mts",
	".svelte",
	".ts",
	".tsx",
	".vue",
];

export const DEFAULT_SERVER_CONFIGS: InternalLspServer[] = [
	{
		name: "biome",
		command: ["biome", "lsp-proxy"],
		extensions: BIOME_EXTENSIONS,
	},
	{
		name: "ty",
		command: ["ty", "server"],
		extensions: [".py", ".pyi"],
	},
	{
		name: "ruff",
		command: ["ruff", "server"],
		extensions: [".py", ".pyi"],
	},
	{
		name: "rust-analyzer",
		command: ["rust-analyzer"],
		extensions: [".rs"],
	},
	{
		name: "gopls",
		command: ["gopls"],
		extensions: [".go"],
	},
	{
		name: "rubocop",
		command: ["rubocop", "--lsp"],
		extensions: [".rb", ".rake", ".gemspec", ".ru"],
	},
	{
		name: "elixir-ls",
		command: ["elixir-ls"],
		extensions: [".ex", ".exs"],
		skipDirectories: ["_build", "deps"],
	},
	{
		name: "zls",
		command: ["zls"],
		extensions: [".zig", ".zon"],
		skipDirectories: [".zig-cache", "zig-out"],
	},
	{
		name: "csharp",
		command: ["roslyn-language-server", "--stdio", "--autoLoadProjects"],
		extensions: [".cs", ".csx"],
		skipDirectories: ["bin", "obj"],
	},
	{
		name: "fsharp",
		command: ["fsautocomplete"],
		extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
		skipDirectories: ["bin", "obj"],
	},
	{
		name: "sourcekit-lsp",
		command: ["sourcekit-lsp"],
		extensions: [".swift", ".m", ".mm"],
		skipDirectories: [".build", "DerivedData"],
	},
	{
		name: "clangd",
		command: ["clangd", "--background-index", "--clang-tidy"],
		extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"],
		skipDirectories: ["build"],
	},
	{
		name: "jdtls",
		command: ["jdtls"],
		extensions: [".java"],
		skipDirectories: [".gradle", "build"],
	},
	{
		name: "kotlin-lsp",
		command: ["kotlin-lsp", "--stdio"],
		extensions: [".kt", ".kts"],
		skipDirectories: [".gradle", "build"],
	},
	{
		name: "yaml-language-server",
		command: ["yaml-language-server", "--stdio"],
		extensions: [".yaml", ".yml"],
	},
	{
		name: "lua-language-server",
		command: ["lua-language-server"],
		extensions: [".lua"],
	},
	{
		name: "intelephense",
		command: ["intelephense", "--stdio"],
		extensions: [".php"],
		initialization: { telemetry: { enabled: false } },
	},
	{
		name: "prisma",
		command: ["prisma", "language-server"],
		extensions: [".prisma"],
	},
	{
		name: "dart",
		command: ["dart", "language-server", "--lsp"],
		extensions: [".dart"],
		skipDirectories: [".dart_tool", "build"],
	},
	{
		name: "ocaml-lsp",
		command: ["ocamllsp"],
		extensions: [".ml", ".mli"],
		skipDirectories: ["_build"],
	},
	{
		name: "bash-language-server",
		command: ["bash-language-server", "start"],
		extensions: [".sh", ".bash", ".zsh", ".ksh"],
	},
	{
		name: "terraform-ls",
		command: ["terraform-ls", "serve"],
		extensions: [".tf", ".tfvars"],
		skipDirectories: [".terraform"],
		initialization: {
			experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true },
		},
	},
	{
		name: "texlab",
		command: ["texlab"],
		extensions: [".tex", ".bib"],
	},
	{
		name: "gleam",
		command: ["gleam", "lsp"],
		extensions: [".gleam"],
		skipDirectories: ["build"],
	},
	{
		name: "clojure-lsp",
		command: ["clojure-lsp", "listen"],
		extensions: [".clj", ".cljs", ".cljc", ".edn"],
		skipDirectories: [".cpcache"],
	},
	{
		name: "nixd",
		command: ["nixd"],
		extensions: [".nix"],
	},
	{
		name: "tinymist",
		command: ["tinymist"],
		extensions: [".typ", ".typc"],
	},
	{
		name: "haskell-language-server",
		command: ["haskell-language-server-wrapper", "--lsp"],
		extensions: [".hs", ".lhs"],
		skipDirectories: [".stack-work", "dist-newstyle"],
	},
	{
		name: "julia-language-server",
		command: [
			"julia",
			"--startup-file=no",
			"--history-file=no",
			"-e",
			"using LanguageServer; runserver()",
		],
		extensions: [".jl"],
	},
];

export function loadRuntime(cwd = process.cwd()) {
	const config = loadConfig(cwd);
	return {
		adapters: config.servers.map(configToAdapter),
		timeoutMs: config.timeout ?? 20_000,
	};
}

export function loadConfig(cwd = process.cwd()): LspConfig {
	const configured = loadConfiguredConfig(cwd);
	return configured ?? { servers: DEFAULT_SERVER_CONFIGS };
}

let pendingConfigNotice: string | undefined;

function loadConfiguredConfig(cwd: string): LspConfig | undefined {
	pendingConfigNotice = undefined;
	const rawConfig = process.env.PI_LSP_CONFIG?.trim();
	if (rawConfig) return parseConfigSource(rawConfig, cwd, "PI_LSP_CONFIG");

	const projectConfig = path.join(cwd, ".pi", "pi-lsp.json");
	const legacyProjectConfig = path.join(cwd, ".pi", "lsp.json");
	if (existsSync(projectConfig)) {
		if (existsSync(legacyProjectConfig)) {
			pendingConfigNotice = ".pi/lsp.json ignored because .pi/pi-lsp.json takes precedence.";
		}
		return parseConfigFile(projectConfig);
	}
	if (existsSync(legacyProjectConfig)) {
		pendingConfigNotice =
			"Using legacy .pi/lsp.json. Rename it to .pi/pi-lsp.json; the repository file was not modified automatically.";
		return parseConfigFile(legacyProjectConfig);
	}

	const userConfig = path.join(getAgentDir(), "pi-lsp.json");
	const legacyUserConfig = path.join(getAgentDir(), "lsp.json");
	if (existsSync(userConfig)) {
		if (existsSync(legacyUserConfig)) {
			pendingConfigNotice = "lsp.json ignored because pi-lsp.json takes precedence.";
		}
		return parseConfigFile(userConfig);
	}
	if (!existsSync(legacyUserConfig)) return undefined;

	const legacyContents = readFileSync(legacyUserConfig, "utf8");
	const legacy = normalizeConfig(JSON.parse(legacyContents), legacyUserConfig);
	let installedIdentity: FileIdentity;
	try {
		installedIdentity = installFileExclusively(
			userConfig,
			legacyContents,
			statSync(legacyUserConfig).mode & 0o777,
		);
	} catch (error) {
		if (existsSync(userConfig)) {
			pendingConfigNotice = "lsp.json ignored because pi-lsp.json was created concurrently.";
			return parseConfigFile(userConfig);
		}
		pendingConfigNotice = `LSP config migration failed: ${formatError(error)}. The legacy file was used for this session.`;
		return legacy;
	}
	if (!fileContentsEqual(legacyUserConfig, legacyContents)) {
		if (removeFileIfIdentityMatches(userConfig, installedIdentity, legacyContents)) {
			pendingConfigNotice =
				"lsp.json changed during migration; the stale pi-lsp.json snapshot was removed and the legacy file was used for this session.";
		} else {
			pendingConfigNotice =
				"lsp.json changed during migration, but pi-lsp.json was replaced concurrently and takes precedence on the next load.";
		}
		return legacy;
	}
	try {
		rmSync(legacyUserConfig);
		pendingConfigNotice = "LSP config migrated from lsp.json to pi-lsp.json.";
	} catch (error) {
		pendingConfigNotice = `LSP config migrated to pi-lsp.json, but lsp.json could not be removed: ${formatError(error)}.`;
	}
	return legacy;
}

type FileIdentity = { dev: number; ino: number };

function installFileExclusively(filePath: string, contents: string, mode: number): FileIdentity {
	const tempFile = path.join(path.dirname(filePath), `.pi-lsp.json.${randomUUID()}.tmp`);
	try {
		writeFileSync(tempFile, contents, { encoding: "utf8", flag: "wx", mode });
		chmodSync(tempFile, mode);
		const identity = lstatSync(tempFile);
		linkSync(tempFile, filePath);
		return { dev: identity.dev, ino: identity.ino };
	} finally {
		try {
			rmSync(tempFile, { force: true });
		} catch {
			// Preserve the migration result if best-effort temp cleanup fails.
		}
	}
}

function removeFileIfIdentityMatches(
	filePath: string,
	expected: FileIdentity,
	expectedContents: string,
) {
	try {
		const current = lstatSync(filePath);
		if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
		if (readFileSync(filePath, "utf8") !== expectedContents) return false;
		rmSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function fileContentsEqual(filePath: string, expected: string) {
	try {
		return readFileSync(filePath, "utf8") === expected;
	} catch {
		return false;
	}
}

export function consumeLspConfigNotice() {
	const notice = pendingConfigNotice;
	pendingConfigNotice = undefined;
	return notice;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function parseConfigSource(source: string, cwd: string, label: string): LspConfig {
	if (source.startsWith("{")) return normalizeConfig(JSON.parse(source), label);
	const expandedSource = expandHome(source);
	const filePath = path.isAbsolute(expandedSource)
		? expandedSource
		: path.resolve(cwd, expandedSource);
	return parseConfigFile(filePath);
}

function parseConfigFile(filePath: string): LspConfig {
	return normalizeConfig(JSON.parse(readFileSync(filePath, "utf8")), filePath);
}

function normalizeConfig(value: unknown, label: string): LspConfig {
	if (!isRecord(value) || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object mapping server names to LSP server config.`);
	}

	if ("servers" in value) {
		if (isServerEntry(value.servers)) {
			throw new Error(
				`${label} uses reserved top-level key 'servers'. Use the wrapper shape ` +
					`{ "servers": { "<name>": { "command": [...], "extensions": [...] } } }` +
					" or choose a different server name.",
			);
		}
		const timeout = normalizeTimeout(value.timeout, label);
		const servers = value.servers;
		if (!isRecord(servers) || Array.isArray(servers)) {
			throw new Error(
				`${label}.servers must be a JSON object mapping server names to LSP server config.`,
			);
		}
		return { timeout, servers: normalizeServerMap(servers, `${label}.servers`) };
	}

	if ("timeout" in value) {
		throw new Error(`${label}.timeout requires the wrapper shape with a servers object.`);
	}

	return { servers: normalizeServerMap(value, label) };
}

function normalizeServerMap(value: Record<string, unknown>, label: string) {
	return Object.entries(value).map(([name, server]) =>
		normalizeServer(name, server, `${label}.${name}`),
	);
}

function isServerEntry(value: unknown) {
	return isRecord(value) && (Array.isArray(value.command) || Array.isArray(value.extensions));
}

function normalizeServer(name: string, value: unknown, label: string): InternalLspServer {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	const command = stringArrayField(value, "command", label);
	const extensions = stringArrayField(value, "extensions", label).map(normalizeExtension);
	return {
		name,
		command,
		extensions,
		env: optionalStringRecordField(value, "env", label),
		initialization: optionalRecordField(value, "initialization", label),
		skipDirectories: optionalDirectoryNamesField(value, "skipDirectories", label),
	};
}

function normalizeTimeout(value: unknown, label: string) {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label}.timeout must be a positive number.`);
	}
	return value;
}

function configToAdapter(config: InternalLspServer): LspServerAdapter {
	const extensionSet = new Set(config.extensions.map(normalizeExtension));
	const [command, ...args] = config.command;
	if (!command) throw new Error(`${config.name}.command must contain at least one string.`);
	return {
		name: config.name,
		defaultCommand: { command, args },
		commandEnvVar: envName(config.name, "COMMAND"),
		missingCommandHint: `Install ${config.name} or set ${envName(config.name, "COMMAND")}.`,
		extensions: config.extensions,
		env: config.env,
		initialization: config.initialization,
		skipDirectories: new Set([...COMMON_SKIP_DIRECTORIES, ...(config.skipDirectories ?? [])]),
		isSupportedFile: (filePath) => extensionSet.has(path.extname(filePath)),
		languageIdFor: (filePath) => languageIdFor(config, filePath),
	};
}

function languageIdFor(_config: InternalLspServer, filePath: string) {
	const extension = path.extname(filePath);
	return LANGUAGE_IDS[extension] ?? extension.slice(1);
}

const LANGUAGE_IDS: Record<string, string> = {
	".bash": "shellscript",
	".bib": "bibtex",
	".c": "c",
	".c++": "cpp",
	".cc": "cpp",
	".cjs": "javascript",
	".clj": "clojure",
	".cljc": "clojure",
	".cljs": "clojure",
	".cpp": "cpp",
	".cs": "csharp",
	".csx": "csharp",
	".cts": "typescript",
	".cxx": "cpp",
	".dart": "dart",
	".edn": "clojure",
	".ex": "elixir",
	".exs": "elixir",
	".fs": "fsharp",
	".fsi": "fsharp",
	".fsscript": "fsharp",
	".fsx": "fsharp",
	".gemspec": "ruby",
	".go": "go",
	".gql": "graphql",
	".h": "c",
	".h++": "cpp",
	".hh": "cpp",
	".hpp": "cpp",
	".hs": "haskell",
	".hxx": "cpp",
	".jl": "julia",
	".js": "javascript",
	".jsx": "javascriptreact",
	".jsonc": "jsonc",
	".ksh": "shellscript",
	".kt": "kotlin",
	".kts": "kotlin",
	".lhs": "haskell",
	".m": "objective-c",
	".mjs": "javascript",
	".ml": "ocaml",
	".mli": "ocaml",
	".mm": "objective-cpp",
	".mts": "typescript",
	".nix": "nix",
	".php": "php",
	".py": "python",
	".pyi": "python",
	".rake": "ruby",
	".rb": "ruby",
	".rs": "rust",
	".ru": "ruby",
	".sh": "shellscript",
	".swift": "swift",
	".tex": "latex",
	".tf": "terraform",
	".tfvars": "terraform-vars",
	".ts": "typescript",
	".tsx": "typescriptreact",
	".typ": "typst",
	".typc": "typst",
	".yaml": "yaml",
	".yml": "yaml",
	".zig": "zig",
	".zon": "zig",
	".zsh": "shellscript",
};

function commandFromEnvName(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
}

function envName(name: string, suffix: "COMMAND") {
	return `PI_${commandFromEnvName(name)}_LSP_${suffix}`;
}

function normalizeExtension(extension: string) {
	return extension.startsWith(".") ? extension : `.${extension}`;
}

function stringArrayField(value: Record<string, unknown>, field: string, label: string) {
	const fieldValue = value[field];
	if (!Array.isArray(fieldValue) || !fieldValue.every((item) => typeof item === "string")) {
		throw new Error(`${label}.${field} must be an array of strings.`);
	}
	return fieldValue;
}

function optionalStringRecordField(value: Record<string, unknown>, field: string, label: string) {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (!isRecord(fieldValue) || Array.isArray(fieldValue)) {
		throw new Error(`${label}.${field} must be an object with string values.`);
	}
	if (!Object.values(fieldValue).every((item) => typeof item === "string")) {
		throw new Error(`${label}.${field} must be an object with string values.`);
	}
	return fieldValue as Record<string, string>;
}

function optionalRecordField(value: Record<string, unknown>, field: string, label: string) {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (!isRecord(fieldValue) || Array.isArray(fieldValue)) {
		throw new Error(`${label}.${field} must be an object.`);
	}
	return fieldValue;
}

function optionalDirectoryNamesField(value: Record<string, unknown>, field: string, label: string) {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (!Array.isArray(fieldValue) || !fieldValue.every((item) => typeof item === "string")) {
		throw new Error(`${label}.${field} must be an array of directory names.`);
	}
	const names = fieldValue.map((item) => item.trim());
	if (
		names.some(
			(name) => !name || name === "." || name === ".." || name.includes("/") || name.includes("\\"),
		)
	) {
		throw new Error(
			`${label}.${field} must contain non-empty directory names without path separators.`,
		);
	}
	return [...new Set(names)];
}

function expandHome(filePath: string) {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
