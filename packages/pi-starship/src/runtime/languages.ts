import { delimiter, dirname, join } from "node:path";
import { styleVariables } from "../format/formatter.js";
import {
  detectEnvironment,
  directMatch,
  formatVersion,
  MAX_METADATA_FILE_BYTES,
  optionBoolean,
  optionString,
  optionStrings,
  pathName,
  runBounded,
  safeMetadata,
} from "./helpers.js";
import { type CollectorContext, type MutableModuleSnapshot, PRIVATE_STYLE_SELECTOR } from "./types.js";
import { goRequirementSatisfied, nodeRequirementSatisfied } from "./version-requirements.js";

const LANGUAGE_NAMES = ["nodejs", "python", "rust", "golang", "bun", "deno"] as const;
type LanguageName = (typeof LANGUAGE_NAMES)[number];

const DEFAULT_DETECTION: Record<LanguageName, { files: string[]; extensions: string[]; folders: string[] }> = {
  nodejs: {
    files: ["package.json", ".node-version", ".nvmrc", "!bun.lock", "!bun.lockb", "!deno.json", "!deno.jsonc"],
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
    if (context.input.signal?.aborted) return {};
    if (!context.needs(name)) continue;
    const defaults = DEFAULT_DETECTION[name];
    const files = optionStrings(context, name, "detect_files");
    const extensions = optionStrings(context, name, "detect_extensions");
    const folders = optionStrings(context, name, "detect_folders");
    const envNames = name === "python" ? optionStrings(context, name, "detect_env_vars") : [];
    const environmentDetected = envNames.length > 0 && detectEnvironment(context.input.environment, envNames);
    if (
      !environmentDetected &&
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
    const checkRequirement = requirementStyleNeeded(context, name);
    let requirement: string | undefined;
    if (name === "nodejs" && (context.needs(name, "engines_version") || checkRequirement)) {
      requirement = await readNodeEngine(context);
      const display = safeMetadata(requirement, 80);
      if (display && context.needs(name, "engines_version")) values.engines_version = display;
    }
    if (name === "golang" && (context.needs(name, "mod_version") || checkRequirement)) {
      requirement = await readGoRequirement(context);
      // Pi keeps requirement variables visible, even when the runtime satisfies them.
      if (requirement && context.needs(name, "mod_version")) values.mod_version = requirement;
    }
    if (context.input.signal?.aborted) return {};
    const needsVersion = context.needs(name, "version");
    const needsNumver = name === "rust" && context.needs(name, "numver");
    if (needsVersion || needsNumver || (checkRequirement && requirement)) {
      const pyenvLabel = name === "python" && optionBoolean(context, name, "pyenv_version_name");
      const version = pyenvLabel ? await pyenvVersion(context) : await runtimeVersion(context, name);
      if (context.input.signal?.aborted) return {};
      if (version) {
        if (needsVersion) {
          values.version = pyenvLabel ? version : formatVersion(version, optionString(context, name, "version_format"));
        }
        if (needsNumver) values.numver = version.replace(/^v/u, "");
      }
      if (
        checkRequirement &&
        !(name === "nodejs"
          ? nodeRequirementSatisfied(version, requirement)
          : goRequirementSatisfied(version, requirement))
      ) {
        values[PRIVATE_STYLE_SELECTOR] = "not_capable";
      }
    }
    result[name] = values;
  }
  return result;
}

function addEnvironmentValues(context: CollectorContext, name: LanguageName, values: Record<string, string>): void {
  const env = context.input.environment;
  if (name === "python") {
    const virtualenv = safeMetadata(env.VIRTUAL_ENV) ?? safeMetadata(env.CONDA_DEFAULT_ENV);
    if (virtualenv && context.needs(name, "virtualenv")) {
      const label = pathName(virtualenv);
      const parent = dirname(virtualenv.replace(/[\\/]+$/u, ""));
      const parentName = pathName(parent);
      values.virtualenv =
        optionStrings(context, name, "generic_venv_names").includes(label) &&
        parentName !== "." &&
        parent !== dirname(parent)
          ? parentName
          : label;
    }
    const pyenv = optionBoolean(context, name, "pyenv_version_name")
      ? optionString(context, name, "pyenv_prefix")
      : safeMetadata(env.PYENV_VERSION);
    // The false branch retains Pi's existing PYENV_VERSION prefix value.
    if (pyenv !== undefined && context.needs(name, "pyenv_prefix")) values.pyenv_prefix = pyenv;
  }
  if (name === "rust") {
    const toolchain = safeMetadata(env.RUSTUP_TOOLCHAIN);
    if (toolchain && context.needs(name, "toolchain")) values.toolchain = toolchain;
  }
}

async function readNodeEngine(context: CollectorContext): Promise<string | undefined> {
  const source = await context.fs.readFile(join(context.input.cwd, "package.json"), MAX_METADATA_FILE_BYTES);
  if (!source) return undefined;
  try {
    const document = JSON.parse(source) as { engines?: { node?: unknown } };
    return typeof document?.engines?.node === "string" ? document.engines.node : undefined;
  } catch {
    return undefined;
  }
}

function requirementStyleNeeded(context: CollectorContext, name: LanguageName): boolean {
  if (name !== "nodejs" && name !== "golang") return false;
  const module = context.input.config.modules[name];
  const style = module.styles.not_capable_style;
  const hasRuntimeValue =
    context.needs(name, "version") || context.needs(name, name === "nodejs" ? "engines_version" : "mod_version");
  return Boolean(
    hasRuntimeValue && style !== undefined && style !== "none" && styleVariables(module.formatAst).has("style"),
  );
}

async function readGoRequirement(context: CollectorContext): Promise<string | undefined> {
  const source = await context.fs.readFile(join(context.input.cwd, "go.mod"), MAX_METADATA_FILE_BYTES);
  if (!source) return undefined;
  return /^[ \t]*go[ \t]+(\d{1,9}\.\d{1,9}(?:\.\d{1,9})?)[ \t]*(?:\/\/[^\r\n]*)?\r?$/mu.exec(source)?.[1];
}

async function pyenvVersion(context: CollectorContext): Promise<string | undefined> {
  const env = context.input.environment.PYENV_VERSION;
  if (env !== undefined) return safeMetadata(env);
  const output = await runBounded(context, "pyenv", ["version-name"]);
  return safeMetadata(output);
}

async function runtimeVersion(context: CollectorContext, name: LanguageName): Promise<string | undefined> {
  if (name === "python") {
    const alternatives = context.options(name).python_binary;
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      for (const alternative of alternatives) {
        if (context.input.signal?.aborted) return undefined;
        const argv = typeof alternative === "string" ? [alternative] : alternative;
        if (!Array.isArray(argv) || typeof argv[0] !== "string") return undefined;
        const output = await runBounded(context, argv[0], [...argv.slice(1), "--version"]);
        // Like upstream, the first successful command owns parsing, even when its output is malformed.
        if (output !== undefined) return parseRuntimeVersion(name, output);
      }
      return undefined;
    }
  }
  const command = await versionCommand(context, name);
  if (!command || context.input.signal?.aborted) return undefined;
  // Go otherwise may download a toolchain selected by go.mod before printing its version.
  const commandContext =
    name === "golang"
      ? { ...context, input: { ...context.input, environment: { ...context.input.environment, GOTOOLCHAIN: "local" } } }
      : context;
  const output = await runBounded(commandContext, command[0], command[1]);
  return output ? parseRuntimeVersion(name, output) : undefined;
}

async function versionCommand(context: CollectorContext, name: LanguageName): Promise<[string, string[]] | undefined> {
  switch (name) {
    case "nodejs":
      return ["node", ["--version"]];
    case "python": {
      const virtualenv = safeMetadata(context.input.environment.VIRTUAL_ENV);
      if (virtualenv) {
        const candidate = join(virtualenv, context.input.platform === "win32" ? "Scripts/python.exe" : "bin/python");
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
      .map((directory) => join(directory, context.input.platform === "win32" ? "rustc.exe" : "rustc")),
  ];
  for (const rawCandidate of candidates) {
    if (context.input.signal?.aborted) return undefined;
    const candidate = safeMetadata(rawCandidate, 1_024);
    if (!candidate || /(?:^|[\\/])\.(?:cargo|rustup)(?:[\\/]|$)/iu.test(candidate)) continue;
    if (await context.fs.fileExists(candidate)) return candidate;
  }
  return undefined;
}

export function parseRuntimeVersion(name: LanguageName, output: string): string | undefined {
  const normalized = output.trim();
  if (!normalized || normalized.includes("\n") || normalized.includes("\r") || normalized.includes("�")) {
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
