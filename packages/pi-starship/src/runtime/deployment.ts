import { extname, isAbsolute, join, resolve } from "node:path";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { parse as parseYaml } from "yaml";
import { matchPattern, replacePattern } from "../format/bounded-regex.js";
import type { ModuleContextRule } from "../modules/types.js";
import {
  detectEnvironment,
  directMatch,
  exactAlias,
  formatVersion,
  isRecord,
  joinHome,
  MAX_METADATA_FILE_BYTES,
  optionBoolean,
  optionMap,
  optionNumber,
  optionString,
  optionStrings,
  runBounded,
  safeMetadata,
} from "./helpers.js";
import {
  type CollectorContext,
  type MutableModuleSnapshot,
  PRIVATE_STYLE_SELECTOR,
  type WorkspaceEntry,
} from "./types.js";

export async function collectDeployment(context: CollectorContext): Promise<MutableModuleSnapshot> {
  const result: MutableModuleSnapshot = {};
  if (context.input.signal?.aborted) return result;
  if (context.needs("docker_context")) {
    const docker = await collectDocker(context);
    if (docker) result.docker_context = docker;
  }
  if (context.input.signal?.aborted) return result;
  if (context.needs("kubernetes")) {
    const kubernetes = await collectKubernetes(context);
    if (kubernetes) result.kubernetes = kubernetes;
  }
  if (context.input.signal?.aborted) return result;
  if (context.needs("terraform")) {
    const terraform = await collectTerraform(context);
    if (terraform) result.terraform = terraform;
  }
  return result;
}

async function collectDocker(context: CollectorContext): Promise<Record<string, string> | undefined> {
  const entries = await context.entries();
  if (optionBoolean(context, "docker_context", "only_with_files")) {
    const configuredFiles = optionStrings(context, "docker_context", "detect_files");
    if (
      !directMatch(
        entries,
        configuredFiles.length > 0
          ? configuredFiles
          : ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
        optionStrings(context, "docker_context", "detect_extensions"),
        optionStrings(context, "docker_context", "detect_folders"),
      )
    ) {
      return undefined;
    }
  }
  let active = safeMetadata(context.input.environment.DOCKER_CONTEXT);
  if (!active) {
    const configDirectory =
      safeMetadata(context.input.environment.DOCKER_CONFIG, 1_024) ?? joinHome(context.input, ".docker");
    const source = await context.fs.readFile(join(configDirectory, "config.json"), MAX_METADATA_FILE_BYTES);
    if (source) {
      try {
        const document = JSON.parse(source) as unknown;
        active = isRecord(document) ? safeMetadata(document.currentContext) : undefined;
      } catch {
        // Malformed metadata degrades to an empty module.
      }
    }
  }
  return active && active !== "default" ? { context: active } : undefined;
}

async function collectKubernetes(context: CollectorContext): Promise<Record<string, string> | undefined> {
  if (!(await kubernetesDetected(context)) || context.input.signal?.aborted) return undefined;
  const selected = safeMetadata(context.input.environment.KUBECONFIG, 4_096);
  const candidates = selected
    ? selected.split(context.input.platform === "win32" ? ";" : ":").filter(Boolean)
    : [joinHome(context.input, ".kube", "config")];
  const limit = optionNumber(context, "kubernetes", "max_config_files") ?? 8;
  const contexts = new Map<string, Record<string, unknown>>();
  const clusters = new Set<string>();
  const users = new Set<string>();
  let currentContext: string | undefined;
  for (const path of candidates.slice(0, limit)) {
    if (context.input.signal?.aborted) return undefined;
    const source = await context.fs.readFile(path, MAX_METADATA_FILE_BYTES);
    if (context.input.signal?.aborted) return undefined;
    if (!source) continue;
    try {
      const document = parseYaml(source) as unknown;
      if (!isRecord(document)) continue;
      currentContext ??= safeMetadata(document["current-context"]);
      for (const item of arrayRecords(document.contexts)) {
        const name = safeMetadata(item.name);
        if (name && !contexts.has(name) && isRecord(item.context)) contexts.set(name, item.context);
      }
      for (const item of arrayRecords(document.clusters)) {
        const name = safeMetadata(item.name);
        if (name) clusters.add(name);
      }
      for (const item of arrayRecords(document.users)) {
        const name = safeMetadata(item.name);
        if (name) users.add(name);
      }
    } catch {
      // Ignore malformed files independently.
    }
  }
  if (!currentContext) return undefined;
  const selectedContext = contexts.get(currentContext);
  const cluster = safeMetadata(selectedContext?.cluster);
  const user = safeMetadata(selectedContext?.user);
  const namespace = safeMetadata(selectedContext?.namespace) ?? "default";
  const matched = matchKubernetesRule(context.options("kubernetes").contexts, currentContext, user);
  const displayContext = matched?.context ?? currentContext;
  const displayUser = matched?.user ?? user;
  const values: Record<string, string> = {
    context: exactAlias(displayContext, optionMap(context, "kubernetes", "context_aliases")) ?? displayContext,
    namespace: exactAlias(namespace, optionMap(context, "kubernetes", "namespace_aliases")) ?? namespace,
  };
  if (cluster && clusters.has(cluster)) {
    values.cluster = exactAlias(cluster, optionMap(context, "kubernetes", "cluster_aliases")) ?? cluster;
  }
  // Preserve Pi's existing named-user requirement unless a rule supplies a label.
  if (displayUser !== undefined && ((user && users.has(user)) || matched?.rule.user_alias !== undefined)) {
    values.user = exactAlias(displayUser, optionMap(context, "kubernetes", "user_aliases")) ?? displayUser;
  }
  if (matched?.rule.symbol !== undefined) values.symbol = matched.rule.symbol;
  if (matched?.rule.style !== undefined) values[PRIVATE_STYLE_SELECTOR] = matched.rule.style;
  return values;
}

async function kubernetesDetected(context: CollectorContext): Promise<boolean> {
  const files = optionStrings(context, "kubernetes", "detect_files");
  const extensions = optionStrings(context, "kubernetes", "detect_extensions");
  const folders = optionStrings(context, "kubernetes", "detect_folders");
  // Upstream gives a configured directory scan precedence over environment checks.
  if (files.length + extensions.length + folders.length > 0) {
    const entries = await context.entries();
    return !context.input.signal?.aborted && kubernetesDirectoryMatch(entries, files, extensions, folders);
  }
  return detectEnvironment(context.input.environment, optionStrings(context, "kubernetes", "detect_env_vars"));
}

function kubernetesDirectoryMatch(
  entries: readonly WorkspaceEntry[],
  files: readonly string[],
  extensions: readonly string[],
  folders: readonly string[],
): boolean {
  // Unlike the shared legacy detector, upstream ignores hidden-file extensions
  // and recognizes both the last suffix and a complete compound suffix.
  // Use only regular entries from the bounded listing; do not follow symlinks.
  const foundFiles = new Set<string>();
  const foundFolders = new Set<string>();
  const foundExtensions = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory) foundFolders.add(entry.name);
    if (!entry.isFile) continue;
    foundFiles.add(entry.name);
    if (entry.name.startsWith(".")) continue;
    const firstDot = entry.name.indexOf(".");
    if (firstDot < 0) continue;
    foundExtensions.add(entry.name.slice(firstDot + 1));
    foundExtensions.add(entry.name.slice(entry.name.lastIndexOf(".") + 1));
  }
  const criteria = [
    [files, foundFiles],
    [extensions, foundExtensions],
    [folders, foundFolders],
  ] as const;
  return (
    criteria.every(([patterns, found]) => !patterns.some((name) => name.startsWith("!") && found.has(name.slice(1)))) &&
    criteria.some(([patterns, found]) => patterns.some((name) => !name.startsWith("!") && found.has(name)))
  );
}

interface MatchedKubernetesRule {
  rule: ModuleContextRule;
  context: string;
  user?: string;
}

function matchKubernetesRule(
  rules: unknown,
  context: string,
  user: string | undefined,
): MatchedKubernetesRule | undefined {
  if (!Array.isArray(rules)) return undefined;
  for (const rule of rules.slice(0, 64)) {
    if (!isKubernetesRule(rule)) continue;
    const contextAlias = kubernetesRuleAlias(rule.context_pattern, context, rule.context_alias);
    if (contextAlias === undefined) continue;
    const userAlias = kubernetesRuleAlias(rule.user_pattern, user, rule.user_alias);
    if (rule.user_pattern !== undefined && userAlias === undefined) continue;
    return { rule, context: contextAlias, user: userAlias };
  }
  return undefined;
}

function isKubernetesRule(rule: unknown): rule is ModuleContextRule {
  return (
    isRecord(rule) &&
    typeof rule.context_pattern === "string" &&
    ["user_pattern", "symbol", "style", "context_alias", "user_alias"].every(
      (key) => rule[key] === undefined || typeof rule[key] === "string",
    )
  );
}

function kubernetesRuleAlias(
  pattern: string | undefined,
  value: string | undefined,
  alias: string | undefined,
): string | undefined {
  const replacement = alias ?? value;
  if (replacement === undefined) return undefined;
  if (pattern === undefined || value === pattern) {
    return alias === undefined ? replacement : (safeMetadata(sanitizeTerminalText(replacement)) ?? "");
  }
  if (value === undefined || !matchPattern(pattern, value)) return undefined;
  if (alias === undefined) return value;
  // Grouped anchors keep replacements whole-label even with alternation.
  const replaced = replacePattern(`^(?:${pattern})$`, value, alias);
  return replaced === undefined ? undefined : (safeMetadata(sanitizeTerminalText(replaced)) ?? "");
}

async function collectTerraform(context: CollectorContext): Promise<Record<string, string> | undefined> {
  const entries = await context.entries();
  const configuredFiles = optionStrings(context, "terraform", "detect_files");
  const configuredExtensions = optionStrings(context, "terraform", "detect_extensions");
  const configuredFolders = optionStrings(context, "terraform", "detect_folders");
  const detected =
    configuredFiles.length + configuredExtensions.length + configuredFolders.length > 0
      ? directMatch(entries, configuredFiles, configuredExtensions, configuredFolders)
      : entries.some(
          (entry) =>
            (entry.isFile && [".tf", ".tfplan", ".tfstate"].includes(extname(entry.name))) ||
            (entry.isDirectory && entry.name === ".terraform"),
        );
  if (!detected) return undefined;
  const values: Record<string, string> = {};
  const workspace = await terraformWorkspace(context);
  if (workspace) values.workspace = workspace;
  if (context.needs("terraform", "version")) {
    for (const command of ["terraform", "tofu"]) {
      const output = await runBounded(context, command, ["version"]);
      const parsed = output ? parseTerraformVersion(output, command) : undefined;
      if (parsed) {
        values.version = formatVersion(parsed, optionString(context, "terraform", "version_format"));
        break;
      }
    }
  }
  return values;
}

async function terraformWorkspace(context: CollectorContext): Promise<string | undefined> {
  const direct = safeMetadata(context.input.environment.TF_WORKSPACE);
  if (direct) return direct;
  const dataDirectory = safeMetadata(context.input.environment.TF_DATA_DIR, 1_024);
  const candidate = dataDirectory
    ? join(isAbsolute(dataDirectory) ? dataDirectory : resolve(context.input.cwd, dataDirectory), "environment")
    : join(context.input.cwd, ".terraform", "environment");
  return safeMetadata(await context.fs.readFile(candidate, 1_024));
}

export function parseTerraformVersion(output: string, command: "terraform" | "tofu" | string): string | undefined {
  const escaped = command === "tofu" ? "OpenTofu" : "Terraform";
  const match = new RegExp(`^${escaped} v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)$`, "u").exec(
    output.trim().split(/\r?\n/u)[0] ?? "",
  );
  return match?.[1] ? `v${match[1]}` : undefined;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
