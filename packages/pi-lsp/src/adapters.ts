import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
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
    // rust-analyzer can return an empty pull result before its initial analysis
    // publishes the real diagnostics.
    pullDiagnosticsGraceMs: 5_000,
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
    command: [process.platform === "win32" ? "language_server.bat" : "language_server.sh"],
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
    initialization: { AutomaticWorkspaceInit: true },
  },
  {
    name: "sourcekit-lsp",
    command: ["sourcekit-lsp"],
    extensions: [".swift", ".mm"],
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
    // LuaLS does not publish an empty diagnostic set for a clean document.
    pushDiagnosticsGraceMs: 3_000,
  },
  {
    name: "intelephense",
    command: ["intelephense", "--stdio"],
    extensions: [".php"],
    initialization: { intelephense: { telemetry: { enabled: false } } },
    // Publishes empty on didOpen, then real diagnostics ~0.2-3s later.
    diagnosticsSettleMs: 4000,
  },
  {
    name: "prisma",
    command: ["prisma-language-server", "--stdio"],
    extensions: [".prisma"],
  },
  {
    name: "dart",
    command: ["dart", "language-server"],
    extensions: [".dart"],
    skipDirectories: [".dart_tool", "build"],
    // The analysis server can remain silent when a document is clean.
    pushDiagnosticsGraceMs: 2_000,
  },
  {
    name: "ocaml-lsp",
    command: ["ocamllsp"],
    extensions: [".ml", ".mli"],
    skipDirectories: ["_build", "_opam"],
  },
  {
    name: "bash-language-server",
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash"],
  },
  {
    name: "terraform-ls",
    command: ["terraform-ls", "serve"],
    extensions: [".tf", ".tfvars"],
    skipDirectories: [".terraform"],
    pushDiagnosticsGraceMs: 2_000,
    initialization: {
      experimentalFeatures: { prefillRequiredFields: true },
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
    pushDiagnosticsGraceMs: 2_000,
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
    pushDiagnosticsGraceMs: 2_000,
  },
  {
    name: "haskell-language-server",
    command: ["haskell-language-server-wrapper", "--lsp"],
    extensions: [".hs", ".lhs"],
    skipDirectories: [".stack-work", "dist-newstyle"],
    pushDiagnosticsGraceMs: 3_000,
  },
];

export interface LspConfigLoadOptions {
  projectTrusted?: boolean;
}

export function loadRuntime(cwd = process.cwd(), options: LspConfigLoadOptions = {}) {
  const config = loadConfig(cwd, options);
  return {
    adapters: config.servers.map(configToAdapter),
    timeoutMs: config.timeout ?? 20_000,
  };
}

export function loadConfig(cwd = process.cwd(), options: LspConfigLoadOptions = {}): LspConfig {
  const configured = loadConfiguredConfig(cwd, options.projectTrusted === true);
  return (
    configured ?? {
      servers: DEFAULT_SERVER_CONFIGS.map((server) => ({ ...server, isDefault: true })),
    }
  );
}

let pendingConfigNotice: string | undefined;

function loadConfiguredConfig(cwd: string, projectTrusted: boolean): LspConfig | undefined {
  pendingConfigNotice = undefined;

  if (projectTrusted) {
    const projectConfig = path.join(cwd, CONFIG_DIR_NAME, "pi-lsp.json");
    const legacyProjectConfig = path.join(cwd, CONFIG_DIR_NAME, "lsp.json");
    const canonical = parseConfigFileIfPresent(projectConfig);
    if (canonical) {
      if (existsSync(legacyProjectConfig)) {
        pendingConfigNotice = `${CONFIG_DIR_NAME}/lsp.json ignored because ${CONFIG_DIR_NAME}/pi-lsp.json takes precedence.`;
      }
      return canonical;
    }
    const legacy = parseLegacyConfigWithCanonicalRecheck(projectConfig, legacyProjectConfig);
    if (legacy) {
      pendingConfigNotice = legacy.canonicalCreated
        ? `${CONFIG_DIR_NAME}/lsp.json ignored because ${CONFIG_DIR_NAME}/pi-lsp.json was created concurrently.`
        : `Using legacy ${CONFIG_DIR_NAME}/lsp.json. Rename it to ${CONFIG_DIR_NAME}/pi-lsp.json; the repository file was not modified automatically.`;
      return legacy.config;
    }
  }

  const userConfig = path.join(getAgentDir(), "pi-lsp.json");
  const legacyUserConfig = path.join(getAgentDir(), "lsp.json");
  const canonical = parseConfigFileIfPresent(userConfig);
  if (canonical) {
    if (existsSync(legacyUserConfig)) {
      pendingConfigNotice = "lsp.json ignored because pi-lsp.json takes precedence.";
    }
    return canonical;
  }

  const legacy = parseLegacyConfigWithCanonicalRecheck(userConfig, legacyUserConfig);
  if (!legacy) return undefined;
  pendingConfigNotice = legacy.canonicalCreated
    ? "lsp.json ignored because pi-lsp.json was created concurrently."
    : "Using legacy lsp.json; rename it to pi-lsp.json. Future settings use pi-lsp.json without modifying the legacy file.";
  return legacy.config;
}

export function consumeLspConfigNotice() {
  const notice = pendingConfigNotice;
  pendingConfigNotice = undefined;
  return notice;
}

function parseConfigFile(filePath: string): LspConfig {
  return normalizeConfig(JSON.parse(readFileSync(filePath, "utf8")), filePath);
}

function parseConfigFileIfPresent(filePath: string) {
  if (!existsSync(filePath)) return undefined;
  try {
    return parseConfigFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function parseLegacyConfigWithCanonicalRecheck(
  canonicalPath: string,
  legacyPath: string,
): { config: LspConfig; canonicalCreated: boolean } | undefined {
  const canonicalIfPresent = () => {
    const config = parseConfigFileIfPresent(canonicalPath);
    return config ? { config, canonicalCreated: true } : undefined;
  };
  const beforeRead = canonicalIfPresent();
  if (beforeRead) return beforeRead;
  if (!existsSync(legacyPath)) return canonicalIfPresent();

  let legacyContents: string;
  try {
    legacyContents = readFileSync(legacyPath, "utf8");
  } catch (error) {
    const afterReadFailure = canonicalIfPresent();
    if (afterReadFailure) return afterReadFailure;
    if (isMissingFileError(error)) return undefined;
    throw error;
  }

  const beforeParse = canonicalIfPresent();
  if (beforeParse) return beforeParse;
  try {
    const legacy = normalizeConfig(JSON.parse(legacyContents), legacyPath);
    return canonicalIfPresent() ?? { config: legacy, canonicalCreated: false };
  } catch (error) {
    const afterFailure = canonicalIfPresent();
    if (afterFailure) return afterFailure;
    throw error;
  }
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
      throw new Error(`${label}.servers must be a JSON object mapping server names to LSP server config.`);
    }
    return { timeout, servers: normalizeServerMap(servers, `${label}.servers`) };
  }

  if ("timeout" in value) {
    throw new Error(`${label}.timeout requires the wrapper shape with a servers object.`);
  }

  return { servers: normalizeServerMap(value, label) };
}

function normalizeServerMap(value: Record<string, unknown>, label: string) {
  return Object.entries(value).map(([name, server]) => normalizeServer(name, server, `${label}.${name}`));
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
    diagnosticsSettleMs: optionalPositiveNumberField(value, "diagnosticsSettleMs", label),
    pushDiagnosticsGraceMs: optionalPositiveNumberField(value, "pushDiagnosticsGraceMs", label),
    pullDiagnosticsGraceMs: optionalPositiveNumberField(value, "pullDiagnosticsGraceMs", label),
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
    isDefault: config.isDefault ?? false,
    defaultCommand: { command, args },
    missingCommandHint: `Install ${config.name} or update its command in pi-lsp.json.`,
    extensions: config.extensions,
    env: config.env,
    initialization: config.initialization,
    skipDirectories: new Set([...COMMON_SKIP_DIRECTORIES, ...(config.skipDirectories ?? [])]),
    diagnosticsSettleMs: config.diagnosticsSettleMs,
    pushDiagnosticsGraceMs: config.pushDiagnosticsGraceMs,
    pullDiagnosticsGraceMs: config.pullDiagnosticsGraceMs,
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
  ".lhs": "lhaskell",
  ".m": "objective-c",
  ".mjs": "javascript",
  ".ml": "ocaml",
  ".mli": "ocaml.interface",
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
  ".typc": "typst-code",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
  ".zon": "zig",
  ".zsh": "shellscript",
};

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

function optionalPositiveNumberField(value: Record<string, unknown>, field: string, label: string) {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue <= 0) {
    throw new Error(`${label}.${field} must be a positive number.`);
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
  if (names.some((name) => !name || name === "." || name === ".." || name.includes("/") || name.includes("\\"))) {
    throw new Error(`${label}.${field} must contain non-empty directory names without path separators.`);
  }
  return [...new Set(names)];
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
