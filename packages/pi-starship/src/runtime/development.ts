import { join } from "node:path";
import { parse } from "smol-toml";
import {
  detectEnvironment,
  directMatch,
  formatVersion,
  isRecord,
  MAX_METADATA_FILE_BYTES,
  optionBoolean,
  optionString,
  optionStrings,
  runBounded,
  safeMetadata,
  setString,
} from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

export async function collectDevelopment(context: CollectorContext): Promise<MutableModuleSnapshot> {
  const result: MutableModuleSnapshot = {};
  const directNames = ["mise", "direnv", "pixi"] as const;
  const needsListing = directNames.some((name) => context.needs(name));
  const entries = needsListing ? await context.entries() : [];

  if (context.needs("mise") && detected(context, entries, "mise", ["mise.toml", ".mise.toml", ".tool-versions"])) {
    const values: Record<string, string> = {};
    if (context.needs("mise", "health")) {
      const output = await runBounded(context, "mise", ["doctor"]);
      const health = output ? parseMiseHealth(output) : undefined;
      if (health) {
        values.health =
          optionString(context, "mise", health === "healthy" ? "healthy_symbol" : "unhealthy_symbol") ?? health;
      }
    }
    result.mise = values;
  }

  if (
    context.needs("direnv") &&
    (detected(context, entries, "direnv", [".envrc"]) ||
      (optionStrings(context, "direnv", "detect_env_vars").length > 0 &&
        detectEnvironment(context.input.environment, optionStrings(context, "direnv", "detect_env_vars"))))
  ) {
    const values: Record<string, string> = {};
    if (["rc_path", "allowed", "loaded"].some((variable) => context.needs("direnv", variable))) {
      const output = await runBounded(context, "direnv", ["status", "--json"]);
      if (output) {
        Object.assign(
          values,
          parseDirenvStatus(output, {
            allowed: optionString(context, "direnv", "allowed_msg"),
            notAllowed: optionString(context, "direnv", "not_allowed_msg"),
            denied: optionString(context, "direnv", "denied_msg"),
            loaded: optionString(context, "direnv", "loaded_msg"),
            unloaded: optionString(context, "direnv", "unloaded_msg"),
          }),
        );
      }
    }
    result.direnv = values;
  }

  if (context.input.signal?.aborted) return {};
  const conda = safeMetadata(context.input.environment.CONDA_DEFAULT_ENV);
  if (
    context.needs("conda") &&
    conda &&
    !(optionBoolean(context, "conda", "ignore_base") && conda === "base") &&
    detectEnvironment(context.input.environment, optionStrings(context, "conda", "detect_env_vars"))
  ) {
    result.conda = { environment: conda };
  }

  if (context.needs("pixi") && detected(context, entries, "pixi", ["pixi.toml", "pixi.lock"])) {
    const values: Record<string, string> = {};
    const environment = safeMetadata(context.input.environment.PIXI_ENVIRONMENT_NAME);
    if (environment && (environment !== "default" || optionBoolean(context, "pixi", "show_default_environment"))) {
      values.environment = environment;
    }
    const project = safeMetadata(context.input.environment.PIXI_PROJECT_NAME) ?? (await readPixiProject(context));
    if (project) values.project_name = project;
    if (context.input.signal?.aborted) return {};
    if (context.needs("pixi", "version")) {
      const output = await runBounded(context, "pixi", ["--version"]);
      const version = output ? parsePixiVersion(output) : undefined;
      if (version) values.version = formatVersion(version, optionString(context, "pixi", "version_format"));
    }
    result.pixi = values;
  }

  const nixState = safeMetadata(context.input.environment.IN_NIX_SHELL);
  if (context.needs("nix_shell") && (nixState === "pure" || nixState === "impure")) {
    const values: Record<string, string> = {
      state: optionString(context, "nix_shell", nixState === "pure" ? "pure_msg" : "impure_msg") ?? nixState,
    };
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

interface DirenvMessages {
  allowed?: string;
  notAllowed?: string;
  denied?: string;
  loaded?: string;
  unloaded?: string;
}

export function parseDirenvStatus(output: string, messages: DirenvMessages = {}): Record<string, string> {
  const labels = {
    allowed: messages.allowed ?? "allowed",
    notAllowed: messages.notAllowed ?? "not allowed",
    denied: messages.denied ?? "denied",
    loaded: messages.loaded ?? "loaded",
    unloaded: messages.unloaded ?? "not loaded",
  };
  try {
    const document = JSON.parse(output) as unknown;
    if (!isRecord(document)) return {};
    if (Object.hasOwn(document, "state")) {
      if (!isRecord(document.state)) return {};
      const found = isRecord(document.state.foundRC) ? document.state.foundRC : undefined;
      const loaded = isRecord(document.state.loadedRC) ? document.state.loadedRC : undefined;
      const path = safeMetadata(found?.path);
      const allowed = typeof found?.allowed === "number" ? direnvAllowed(found.allowed) : undefined;
      const loadedAllowed = loaded && typeof loaded.allowed === "number" ? direnvAllowed(loaded.allowed) : undefined;
      if (!found || !path || !allowed || (loaded && !loadedAllowed)) return {};
      return {
        rc_path: path,
        allowed: labels[allowed],
        loaded: loadedAllowed === "allowed" ? labels.loaded : labels.unloaded,
      };
    }
    // Retain Pi's older top-level boolean/0-or-1 snapshot interpretation.
    // Actual direnv JSON nests numeric 0/1/2 statuses under state (handled above).
    const values: Record<string, string> = {};
    const found = isRecord(document.foundRC) ? document.foundRC : undefined;
    const loaded = isRecord(document.loadedRC) ? document.loadedRC : undefined;
    setString(values, "rc_path", found?.path ?? loaded?.path);
    if (found?.allowed === true || found?.allowed === 1) values.allowed = labels.allowed;
    if (found?.allowed === false || found?.allowed === 0) values.allowed = labels.denied;
    if (loaded) values.loaded = labels.loaded;
    else if (found) values.loaded = labels.unloaded;
    return values;
  } catch {
    const path = safeMetadata(/^Found RC path[ \t]+([^\r\n]+)$/mu.exec(output)?.[1]);
    if (!path) return {};
    const values: Record<string, string> = { rc_path: path };
    const allowed = direnvAllowed(/^Found RC allowed[ \t]+([^\r\n]+)$/mu.exec(output)?.[1]);
    if (allowed) {
      values.allowed = labels[allowed];
      values.loaded = output.includes("No .envrc or .env loaded") ? labels.unloaded : labels.loaded;
    }
    return values;
  }
}

function direnvAllowed(value: unknown): "allowed" | "notAllowed" | "denied" | undefined {
  if (value === 0 || value === "0" || value === "true") return "allowed";
  if (value === 1 || value === "1") return "notAllowed";
  if (value === 2 || value === "2" || value === "false") return "denied";
  return undefined;
}

async function readPixiProject(context: CollectorContext): Promise<string | undefined> {
  const source = await context.fs.readFile(join(context.input.cwd, "pixi.toml"), MAX_METADATA_FILE_BYTES);
  if (!source) return undefined;
  try {
    const document = parse(source);
    const project = isRecord(document.project) ? document.project : undefined;
    const workspace = isRecord(document.workspace) ? document.workspace : undefined;
    return safeMetadata(project?.name) ?? safeMetadata(workspace?.name);
  } catch {
    return undefined;
  }
}

function parsePixiVersion(output: string): string | undefined {
  const match = /^(?:pixi\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(output.trim());
  return match?.[1] ? `v${match[1]}` : undefined;
}
