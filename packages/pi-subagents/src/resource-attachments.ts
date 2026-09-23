import { type Dirent, existsSync, realpathSync, type Stats, statSync } from "node:fs";
import {
  opendir as opendirAsync,
  readFile as readFileAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import * as path from "node:path";
import { DefaultPackageManager, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import ignore from "ignore";
import { CHILD_COMMUNICATION_TOOL_NAMES } from "./child-communication-tools.js";
import { sanitizeTerminalText } from "./message-broker.js";
import { CHILD_CORE_TOOL_NAMES } from "./types.js";

export const MAX_ATTACHED_SKILLS = 16;
export const MAX_ATTACHED_EXTENSIONS = 16;
export const MAX_SELECTED_TOOLS = 64;
export const MAX_RESOURCE_PATH_BYTES = 4 * 1024;
export const MAX_EXTENSION_TOOL_NAME_LENGTH = 128;
export const MAX_SKILL_SCAN_DEPTH = 32;
export const MAX_SKILL_SCAN_ENTRIES = 4_096;
export const MAX_SKILL_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_IGNORE_BYTES = 1024 * 1024;
export const MAX_EXTENSION_SCAN_DEPTH = 32;
export const MAX_EXTENSION_SCAN_ENTRIES = 4_096;
export const MAX_EXTENSION_METADATA_BYTES = 1024 * 1024;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const RESERVED_CHILD_TOOL_NAMES = new Set<string>([...CHILD_CORE_TOOL_NAMES, ...CHILD_COMMUNICATION_TOOL_NAMES]);

type IgnoreMatcher = ReturnType<typeof ignore>;

export interface ExtensionAttachment {
  path: string;
  tools: string[];
}

export interface ResourceAttachments {
  skills: string[];
  extensions: ExtensionAttachment[];
}

export interface ResolvedResourceAttachments extends ResourceAttachments {
  effectiveTools: string[];
}

export interface ResourceAttachmentInput {
  skills?: unknown;
  extensions?: unknown;
}

export interface ResolveResourceAttachmentOptions {
  cwd: string;
  projectTrusted: boolean;
  coreTools: readonly string[];
  signal?: AbortSignal;
}

export async function resolveResourceAttachments(
  input: ResourceAttachmentInput,
  options: ResolveResourceAttachmentOptions,
): Promise<ResolvedResourceAttachments> {
  const cwd = path.resolve(options.cwd);
  const canonicalCwd = realpath(cwd, "Subagent working directory");
  const skillInputs = optionalArray(input.skills, "skills", MAX_ATTACHED_SKILLS);
  const extensionInputs = optionalArray(input.extensions, "extensions", MAX_ATTACHED_EXTENSIONS);
  const skills: string[] = [];
  const seenSkills = new Set<string>();
  for (const candidate of skillInputs) {
    const resolved = resolveResourcePath(candidate, "skill", cwd, canonicalCwd, options.projectTrusted);
    if (!seenSkills.has(resolved)) {
      seenSkills.add(resolved);
      skills.push(resolved);
    }
  }
  await assertLoadableSkills(skills, cwd, canonicalCwd, options.projectTrusted, options.signal);

  const extensions: ExtensionAttachment[] = [];
  const extensionsByPath = new Map<string, ExtensionAttachment>();
  for (const candidate of extensionInputs) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => key !== "path" && key !== "tools")) {
      throw new Error("Each subagent extension must contain only path and tools.");
    }
    const resolved = resolveResourcePath(candidate.path, "extension", cwd, canonicalCwd, options.projectTrusted);
    const toolInputs = optionalArray(candidate.tools, "extension tools", MAX_SELECTED_TOOLS, false);
    const tools = toolInputs.map(resolveExtensionToolName);
    for (const tool of tools) {
      if (RESERVED_CHILD_TOOL_NAMES.has(tool)) {
        throw new Error(`Subagent extension tool name conflicts with the built-in ${tool} tool.`);
      }
    }
    let attachment = extensionsByPath.get(resolved);
    if (!attachment) {
      await assertResolvableExtensionAttachment(resolved, cwd, canonicalCwd, options.projectTrusted, options.signal);
      attachment = { path: resolved, tools: [] };
      extensionsByPath.set(resolved, attachment);
      extensions.push(attachment);
    }
    for (const tool of tools) {
      if (!attachment.tools.includes(tool)) attachment.tools.push(tool);
    }
  }

  const effectiveTools = [...new Set([...options.coreTools, ...extensions.flatMap((extension) => extension.tools)])];
  if (effectiveTools.length > MAX_SELECTED_TOOLS) {
    throw new Error(`Subagent jobs may select at most ${MAX_SELECTED_TOOLS} total tools.`);
  }
  return { skills, extensions, effectiveTools };
}

function optionalArray(value: unknown, field: string, maxItems: number, optional = true): unknown[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw new Error(`Subagent ${field} must be an array.`);
  if (value.length > maxItems) throw new Error(`Subagent ${field} may contain at most ${maxItems} entries.`);
  return value;
}

function resolveResourcePath(
  value: unknown,
  kind: "skill" | "extension",
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent ${kind} path is required.`);
  const resourcePath = value.trim();
  if (hasControlCharacter(resourcePath)) throw new Error(`Subagent ${kind} path must not contain control characters.`);
  if (Buffer.byteLength(resourcePath, "utf8") > MAX_RESOURCE_PATH_BYTES) {
    throw new Error(`Subagent ${kind} path must be at most ${MAX_RESOURCE_PATH_BYTES} UTF-8 bytes.`);
  }
  if (!isLocalPath(resourcePath)) throw new Error(`Subagent ${kind} must use a local path.`);
  const lexicalPath = path.resolve(cwd, resourcePath);
  const canonicalPath = realpath(lexicalPath, `Subagent ${kind}`);
  const stats = statSync(canonicalPath);
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error(`Subagent ${kind} path must reference a file or directory.`);
  }
  if (!projectTrusted && (isWithin(cwd, lexicalPath) || isWithin(canonicalCwd, canonicalPath))) {
    throw new Error(`Subagent ${kind} cannot load a project path because the project is not trusted.`);
  }
  return canonicalPath;
}

async function assertLoadableSkills(
  skillPaths: string[],
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const scanState: SkillScanState = {
    entries: 0,
    skillBytes: 0,
    ignoreBytes: 0,
    ancestors: new Set<string>(),
    signal,
  };
  for (const skillPath of skillPaths) {
    throwIfAttachmentAborted(signal);
    const candidates = await collectBoundedSkillCandidates(skillPath, scanState);
    throwIfAttachmentAborted(signal);
    const result = loadExplicitSkills([skillPath], cwd);
    if (result.skills.length === 0) {
      throw new Error("Subagent skill path must contain at least one loadable Pi skill.");
    }
    assertNoUntrustedProjectSkills(result, cwd, canonicalCwd, projectTrusted);
    assertNoOmittedSkillDiagnostics(result);
    assertNoSkillNameCollisions(result.diagnostics);
    await assertNoSilentlyOmittedSkills(skillPath, cwd, result, canonicalCwd, projectTrusted, candidates, signal);
  }
  if (skillPaths.length > 1) {
    throwIfAttachmentAborted(signal);
    const result = loadExplicitSkills(skillPaths, cwd);
    assertNoUntrustedProjectSkills(result, cwd, canonicalCwd, projectTrusted);
    assertNoSkillNameCollisions(result.diagnostics);
  }
}

function loadExplicitSkills(skillPaths: string[], cwd: string): ReturnType<typeof loadSkills> {
  return loadSkills({ cwd, agentDir: cwd, skillPaths, includeDefaults: false });
}

function assertNoOmittedSkillDiagnostics(result: ReturnType<typeof loadSkills>): void {
  const loadedPaths = new Set(result.skills.map((skill) => skill.filePath));
  const omitted = result.diagnostics.some(
    (diagnostic) =>
      diagnostic.type === "error" ||
      (diagnostic.type === "warning" && (!diagnostic.path || !loadedPaths.has(diagnostic.path))),
  );
  if (omitted) {
    throw new Error("Subagent skill attachment must not contain an invalid or unreadable declared skill.");
  }
}

function assertNoSkillNameCollisions(diagnostics: ReturnType<typeof loadSkills>["diagnostics"]): void {
  if (
    diagnostics.some((diagnostic) => diagnostic.type === "collision" && diagnostic.collision?.resourceType === "skill")
  ) {
    throw new Error("Subagent skill attachments must not contain duplicate skill names.");
  }
}

function assertNoUntrustedProjectSkills(
  result: ReturnType<typeof loadSkills>,
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
): void {
  if (projectTrusted) return;
  for (const skill of result.skills) {
    const lexicalPath = path.resolve(skill.filePath);
    const canonicalPath = realpath(skill.filePath, "Loaded subagent skill");
    if (isWithin(cwd, lexicalPath) || isWithin(canonicalCwd, canonicalPath)) {
      throw new Error("Subagent skill cannot load a project path because the project is not trusted.");
    }
  }
}

async function assertNoSilentlyOmittedSkills(
  skillPath: string,
  cwd: string,
  result: ReturnType<typeof loadSkills>,
  canonicalCwd: string,
  projectTrusted: boolean,
  candidates: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (!statSync(skillPath).isDirectory()) return;
  const loadedPaths = new Set(result.skills.map((skill) => realpath(skill.filePath, "Loaded subagent skill")));
  for (const [index, candidate] of candidates.entries()) {
    if (index > 0 && index % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfAttachmentAborted(signal);
    const candidateResult = loadExplicitSkills([candidate], cwd);
    assertNoUntrustedProjectSkills(candidateResult, cwd, canonicalCwd, projectTrusted);
    if (candidateResult.skills.length === 0) {
      if (path.basename(candidate) === "SKILL.md") throwInvalidDeclaredSkill();
      continue;
    }
    const loaded = candidateResult.skills.some((skill) =>
      loadedPaths.has(realpath(skill.filePath, "Loaded subagent skill")),
    );
    if (!loaded) throwInvalidDeclaredSkill();
  }
}

interface SkillScanState {
  entries: number;
  skillBytes: number;
  ignoreBytes: number;
  ancestors: Set<string>;
  signal?: AbortSignal;
}

async function collectBoundedSkillCandidates(skillPath: string, state: SkillScanState): Promise<string[]> {
  throwIfAttachmentAborted(state.signal);
  const stats = await statAsync(skillPath);
  throwIfAttachmentAborted(state.signal);
  if (!stats.isDirectory()) {
    if (stats.isFile() && skillPath.endsWith(".md")) addSkillBytes(state, stats.size);
    return [];
  }
  return collectSkillCandidates(skillPath, true, ignore(), skillPath, 0, state);
}

async function collectSkillCandidates(
  directory: string,
  includeRootMarkdown: boolean,
  ignoreMatcher: IgnoreMatcher,
  rootDirectory: string,
  depth: number,
  state: SkillScanState,
): Promise<string[]> {
  throwIfAttachmentAborted(state.signal);
  if (depth > MAX_SKILL_SCAN_DEPTH) throwSkillScanLimit();
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpathAsync(directory);
  } catch {
    throwInvalidDeclaredSkill();
  }
  throwIfAttachmentAborted(state.signal);
  if (state.ancestors.has(canonicalDirectory)) {
    throw new Error("Subagent skill attachment must not contain a recursive directory link.");
  }
  state.ancestors.add(canonicalDirectory);
  try {
    await addSkillIgnoreRules(ignoreMatcher, directory, rootDirectory, state);
    let directoryHandle: Awaited<ReturnType<typeof opendirAsync>>;
    try {
      directoryHandle = await opendirAsync(directory);
    } catch {
      throwInvalidDeclaredSkill();
    }
    const entries: Dirent[] = [];
    try {
      for await (const entry of directoryHandle) {
        throwIfAttachmentAborted(state.signal);
        state.entries++;
        if (state.entries > MAX_SKILL_SCAN_ENTRIES) throwSkillScanLimit();
        entries.push(entry);
      }
    } catch (error) {
      if (isAbortError(error) || isSkillScanLimitError(error)) throw error;
      throwInvalidDeclaredSkill();
    }

    const rootSkill = entries.find((entry) => entry.name === "SKILL.md");
    if (rootSkill) {
      const rootPath = path.join(directory, rootSkill.name);
      let rootStats: Awaited<ReturnType<typeof statAsync>>;
      try {
        rootStats = await statAsync(rootPath);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throwInvalidDeclaredSkill();
      }
      throwIfAttachmentAborted(state.signal);
      const relativePath = toPosixPath(path.relative(rootDirectory, rootPath));
      if (rootStats.isFile() && !ignoreMatcher.ignores(relativePath)) {
        addSkillBytes(state, rootStats.size);
        return [rootPath];
      }
    }

    const candidates: string[] = [];
    for (const entry of entries) {
      throwIfAttachmentAborted(state.signal);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const candidate = path.join(directory, entry.name);
      let candidateStats: Awaited<ReturnType<typeof statAsync>>;
      try {
        candidateStats = await statAsync(candidate);
      } catch {
        if (entry.name === "SKILL.md" || (includeRootMarkdown && entry.name.endsWith(".md"))) {
          throwInvalidDeclaredSkill();
        }
        continue;
      }
      throwIfAttachmentAborted(state.signal);
      const relativePath = toPosixPath(path.relative(rootDirectory, candidate));
      if (ignoreMatcher.ignores(candidateStats.isDirectory() ? `${relativePath}/` : relativePath)) continue;
      if (candidateStats.isDirectory()) {
        candidates.push(
          ...(await collectSkillCandidates(candidate, false, ignoreMatcher, rootDirectory, depth + 1, state)),
        );
      } else if (
        candidateStats.isFile() &&
        (entry.name === "SKILL.md" || (includeRootMarkdown && entry.name.endsWith(".md")))
      ) {
        addSkillBytes(state, candidateStats.size);
        candidates.push(candidate);
      }
    }
    return candidates;
  } finally {
    state.ancestors.delete(canonicalDirectory);
  }
}

function addSkillBytes(state: SkillScanState, bytes: number): void {
  state.skillBytes += bytes;
  if (state.skillBytes > MAX_SKILL_SCAN_BYTES) throwSkillScanLimit();
}

async function addSkillIgnoreRules(
  ignoreMatcher: IgnoreMatcher,
  directory: string,
  rootDirectory: string,
  state: SkillScanState,
): Promise<void> {
  const relativeDirectory = path.relative(rootDirectory, directory);
  const prefix = relativeDirectory ? `${toPosixPath(relativeDirectory)}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    throwIfAttachmentAborted(state.signal);
    const ignorePath = path.join(directory, filename);
    let ignoreStats: Awaited<ReturnType<typeof statAsync>>;
    try {
      ignoreStats = await statAsync(ignorePath);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAttachmentAborted(state.signal);
      continue;
    }
    if (!ignoreStats.isFile()) throwInvalidIgnoreFile();
    state.ignoreBytes += ignoreStats.size;
    if (state.ignoreBytes > MAX_SKILL_IGNORE_BYTES) throwSkillScanLimit();
    try {
      const content = await readFileAsync(ignorePath, { encoding: "utf8", signal: state.signal });
      throwIfAttachmentAborted(state.signal);
      const patterns = content
        .split(/\r?\n/u)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => line !== null);
      if (patterns.length > 0) ignoreMatcher.add(patterns);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAttachmentAborted(state.signal);
      // Pi ignores unreadable ignore files.
    }
  }
}

function throwInvalidIgnoreFile(): never {
  throw new Error("Subagent attachment ignore files must be regular files.");
}

function throwIfAttachmentAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Subagent attachment validation was cancelled.");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isSkillScanLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "SkillScanLimitError";
}

function throwSkillScanLimit(): never {
  const error = new Error(
    `Subagent skill attachment exceeds traversal limits (${MAX_SKILL_SCAN_ENTRIES} entries, depth ${MAX_SKILL_SCAN_DEPTH}, ${MAX_SKILL_SCAN_BYTES} skill bytes, or ${MAX_SKILL_IGNORE_BYTES} ignore bytes).`,
  );
  error.name = "SkillScanLimitError";
  throw error;
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function throwInvalidDeclaredSkill(): never {
  throw new Error("Subagent skill attachment must not contain an invalid or unreadable declared skill.");
}

async function assertResolvableExtensionAttachment(
  extensionPath: string,
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await inspectExtensionAttachment(extensionPath, cwd, canonicalCwd, projectTrusted, signal);
  throwIfAttachmentAborted(signal);
  const resolved = await resolveAttachedExtensionResources(extensionPath, cwd);
  throwIfAttachmentAborted(signal);
  const entrypoints = enabledResourcePaths(resolved.extensions);
  if (entrypoints.length === 0) {
    throw new Error("Subagent extension directory must contain at least one loadable Pi extension entrypoint.");
  }
  for (const entrypoint of entrypoints.flatMap(resolveDirectExtensionLoadPaths)) {
    assertTrustedResolvedPath(entrypoint, "extension entrypoint", cwd, canonicalCwd, projectTrusted);
  }
  const packageResources = [resolved.skills, resolved.prompts, resolved.themes].flatMap(enabledResourcePaths);
  for (const resource of packageResources) {
    assertTrustedResolvedPath(resource, "extension package resource", cwd, canonicalCwd, projectTrusted);
  }
}

function resolveDirectExtensionLoadPaths(entrypoint: string): string[] {
  if (!statSync(entrypoint).isDirectory()) return [entrypoint];
  for (const filename of ["index.ts", "index.js"]) {
    const indexPath = path.join(entrypoint, filename);
    if (existsSync(indexPath) && statSync(indexPath).isFile()) return [entrypoint, indexPath];
  }
  throwUnresolvableExtensionEntrypoint();
}

async function resolveAttachedExtensionResources(extensionPath: string, cwd: string) {
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory(),
  });
  return packageManager.resolveExtensionSources([extensionPath], { temporary: true });
}

function enabledResourcePaths(resources: readonly { enabled: boolean; path: string }[]): string[] {
  return resources.filter((resource) => resource.enabled).map((resource) => resource.path);
}

function assertTrustedResolvedPath(
  resourcePath: string,
  label: string,
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
): void {
  const canonicalPath = realpath(resourcePath, `Subagent ${label}`);
  const stats = statSync(canonicalPath);
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error(`Subagent ${label} must reference a file or directory.`);
  }
  assertProjectPathTrusted(resourcePath, canonicalPath, label, cwd, canonicalCwd, projectTrusted);
}

function assertProjectPathTrusted(
  lexicalPath: string,
  canonicalPath: string,
  label: string,
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
): void {
  if (!projectTrusted && (isWithin(cwd, path.resolve(lexicalPath)) || isWithin(canonicalCwd, canonicalPath))) {
    throw new Error(`Subagent ${label} cannot load a project path because the project is not trusted.`);
  }
}

type PackageResourceType = "skills" | "prompts" | "themes";
type PiManifest = Partial<Record<"extensions" | PackageResourceType, string[]>>;

interface InspectedPiManifest {
  hasPiManifest: boolean;
  manifest?: PiManifest;
}

interface ExtensionScanState {
  entries: number;
  metadataBytes: number;
  ancestors: Set<string>;
  cwd: string;
  canonicalCwd: string;
  projectTrusted: boolean;
  signal?: AbortSignal;
}

async function inspectExtensionAttachment(
  extensionPath: string,
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!statSync(extensionPath).isDirectory()) return;
  const state: ExtensionScanState = {
    entries: 0,
    metadataBytes: 0,
    ancestors: new Set<string>(),
    cwd,
    canonicalCwd,
    projectTrusted,
    signal,
  };
  const inspected = await inspectPiManifest(extensionPath, state);
  if (inspected.hasPiManifest) {
    await inspectDeclaredExtensionEntries(extensionPath, inspected.manifest?.extensions, true, state);
    for (const resourceType of ["skills", "prompts", "themes"] as const) {
      await inspectDeclaredPackageResourceEntries(
        extensionPath,
        inspected.manifest?.[resourceType],
        resourceType,
        state,
      );
    }
    return;
  }

  const resourceDirectories = ["extensions", "skills", "prompts", "themes"].map((name) =>
    path.join(extensionPath, name),
  );
  const resourceStats = await Promise.all(resourceDirectories.map((directory) => statIfPresent(directory)));
  if (resourceStats.some((stats) => stats?.isDirectory())) {
    if (resourceStats[0]?.isDirectory()) await inspectAutoExtensionDirectory(resourceDirectories[0], true, state);
    for (const [index, resourceType] of (["skills", "prompts", "themes"] as const).entries()) {
      if (resourceStats[index + 1]?.isDirectory()) {
        await inspectPackageResourceDirectory(resourceDirectories[index + 1], resourceType, state);
      }
    }
    return;
  }
  await inspectAutoExtensionDirectory(extensionPath, true, state);
}

async function inspectAutoExtensionDirectory(
  directory: string,
  discoverContents: boolean,
  state: ExtensionScanState,
): Promise<boolean> {
  throwIfAttachmentAborted(state.signal);
  assertExtensionPackagePathTrusted(directory, "extension entrypoint", state);
  const inspected = await inspectPiManifest(directory, state);
  const sourceEntries = inspected.manifest?.extensions?.filter((entrypoint) => !isExtensionOverridePattern(entrypoint));
  if (sourceEntries && sourceEntries.length > 0) {
    await inspectDeclaredExtensionEntries(directory, inspected.manifest?.extensions, false, state);
    return true;
  }
  if (await hasRegularExtensionIndex(directory, state)) return true;
  if (!discoverContents) return false;

  const ignoreMatcher = ignore();
  await addPackageIgnoreRules(ignoreMatcher, directory, directory, state);
  const entries = await readBoundedExtensionEntries(directory, state);
  let found = false;
  for (const entry of entries) {
    throwIfAttachmentAborted(state.signal);
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    const entryStats = await statIfPresent(entryPath);
    if (!entryStats) continue;
    const relativePath = toPosixPath(path.relative(directory, entryPath));
    if (ignoreMatcher.ignores(entryStats.isDirectory() ? `${relativePath}/` : relativePath)) continue;
    assertExtensionPackagePathTrusted(entryPath, "extension entrypoint", state);
    if (entryStats.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      found = true;
    } else if (entryStats.isDirectory() && (await inspectAutoExtensionDirectory(entryPath, false, state))) {
      found = true;
    }
  }
  return found;
}

async function inspectDeclaredExtensionEntries(
  directory: string,
  entries: string[] | undefined,
  expandDirectories: boolean,
  state: ExtensionScanState,
): Promise<void> {
  if (!entries) return;
  for (const entrypoint of entries) {
    throwIfAttachmentAborted(state.signal);
    state.entries++;
    if (state.entries > MAX_EXTENSION_SCAN_ENTRIES) throwExtensionScanLimit();
    if (isExtensionOverridePattern(entrypoint)) continue;
    if (hasExtensionGlob(entrypoint)) {
      throw new Error("Subagent extension package must not contain glob entrypoint declarations.");
    }
    const resolved = path.resolve(directory, entrypoint);
    const resolvedStats = await statIfPresent(resolved);
    if (!resolvedStats) throwUnresolvableExtensionEntrypoint();
    assertExtensionPackagePathTrusted(resolved, "extension entrypoint", state);
    if (resolvedStats.isFile()) continue;
    if (!resolvedStats.isDirectory()) throwUnresolvableExtensionEntrypoint();
    if (expandDirectories) {
      if (!(await inspectAutoExtensionDirectory(resolved, true, state))) throwUnresolvableExtensionEntrypoint();
    } else if (!(await hasRegularExtensionIndex(resolved, state))) {
      throwUnresolvableExtensionEntrypoint();
    }
  }
}

async function inspectDeclaredPackageResourceEntries(
  directory: string,
  entries: string[] | undefined,
  resourceType: PackageResourceType,
  state: ExtensionScanState,
): Promise<void> {
  if (!entries) return;
  for (const entrypoint of entries) {
    throwIfAttachmentAborted(state.signal);
    state.entries++;
    if (state.entries > MAX_EXTENSION_SCAN_ENTRIES) throwExtensionScanLimit();
    if (isExtensionOverridePattern(entrypoint)) continue;
    if (hasExtensionGlob(entrypoint)) {
      throw new Error("Subagent extension package must not contain glob resource declarations.");
    }
    const resolved = path.resolve(directory, entrypoint);
    const resolvedStats = await statIfPresent(resolved);
    if (!resolvedStats) continue;
    assertExtensionPackagePathTrusted(resolved, "extension package resource", state);
    if (resolvedStats.isDirectory()) await inspectPackageResourceDirectory(resolved, resourceType, state);
  }
}

async function inspectPackageResourceDirectory(
  directory: string,
  resourceType: PackageResourceType,
  state: ExtensionScanState,
): Promise<void> {
  const ignoreMatcher = ignore();
  if (resourceType === "skills") {
    await inspectPackageSkillDirectory(directory, ignoreMatcher, directory, 0, state);
  } else {
    await inspectRecursivePackageDirectory(directory, ignoreMatcher, directory, 0, state);
  }
}

async function inspectPackageSkillDirectory(
  directory: string,
  ignoreMatcher: IgnoreMatcher,
  rootDirectory: string,
  depth: number,
  state: ExtensionScanState,
): Promise<void> {
  const canonicalDirectory = await enterPackageResourceDirectory(directory, depth, state);
  if (!canonicalDirectory) return;
  try {
    await addPackageIgnoreRules(ignoreMatcher, directory, rootDirectory, state);
    const entries = await readBoundedPackageResourceEntries(directory, state);
    const rootSkill = entries.find((entry) => entry.name === "SKILL.md");
    if (rootSkill) {
      const skillPath = path.join(directory, rootSkill.name);
      const skillStats = await statIfPresent(skillPath);
      const relativePath = toPosixPath(path.relative(rootDirectory, skillPath));
      if (skillStats?.isFile() && !ignoreMatcher.ignores(relativePath)) {
        assertExtensionPackagePathTrusted(skillPath, "extension package resource", state);
        return;
      }
    }
    for (const entry of entries) {
      throwIfAttachmentAborted(state.signal);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      const entryStats = await statIfPresent(entryPath);
      if (!entryStats) continue;
      const relativePath = toPosixPath(path.relative(rootDirectory, entryPath));
      if (ignoreMatcher.ignores(entryStats.isDirectory() ? `${relativePath}/` : relativePath)) continue;
      assertExtensionPackagePathTrusted(entryPath, "extension package resource", state);
      if (!entryStats.isDirectory()) continue;
      await inspectPackageSkillDirectory(entryPath, ignoreMatcher, rootDirectory, depth + 1, state);
    }
  } finally {
    state.ancestors.delete(canonicalDirectory);
  }
}

async function inspectRecursivePackageDirectory(
  directory: string,
  ignoreMatcher: IgnoreMatcher,
  rootDirectory: string,
  depth: number,
  state: ExtensionScanState,
): Promise<void> {
  const canonicalDirectory = await enterPackageResourceDirectory(directory, depth, state);
  if (!canonicalDirectory) return;
  try {
    await addPackageIgnoreRules(ignoreMatcher, directory, rootDirectory, state);
    const entries = await readBoundedPackageResourceEntries(directory, state);
    for (const entry of entries) {
      throwIfAttachmentAborted(state.signal);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      const entryStats = await statIfPresent(entryPath);
      if (!entryStats) continue;
      const relativePath = toPosixPath(path.relative(rootDirectory, entryPath));
      if (ignoreMatcher.ignores(entryStats.isDirectory() ? `${relativePath}/` : relativePath)) continue;
      assertExtensionPackagePathTrusted(entryPath, "extension package resource", state);
      if (!entryStats.isDirectory()) continue;
      await inspectRecursivePackageDirectory(entryPath, ignoreMatcher, rootDirectory, depth + 1, state);
    }
  } finally {
    state.ancestors.delete(canonicalDirectory);
  }
}

async function enterPackageResourceDirectory(
  directory: string,
  depth: number,
  state: ExtensionScanState,
): Promise<string | undefined> {
  throwIfAttachmentAborted(state.signal);
  if (depth > MAX_EXTENSION_SCAN_DEPTH) throwExtensionScanLimit();
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpathAsync(directory);
  } catch {
    return undefined;
  }
  throwIfAttachmentAborted(state.signal);
  assertProjectPathTrusted(
    directory,
    canonicalDirectory,
    "extension package resource",
    state.cwd,
    state.canonicalCwd,
    state.projectTrusted,
  );
  if (state.ancestors.has(canonicalDirectory)) {
    throw new Error("Subagent extension package must not contain a recursive resource directory link.");
  }
  state.ancestors.add(canonicalDirectory);
  return canonicalDirectory;
}

async function inspectPiManifest(directory: string, state: ExtensionScanState): Promise<InspectedPiManifest> {
  const manifestPath = path.join(directory, "package.json");
  const manifestStats = await statIfPresent(manifestPath);
  if (!manifestStats) return { hasPiManifest: false };
  if (!manifestStats.isFile()) {
    throw new Error("Subagent extension package manifest must be a regular file.");
  }
  assertExtensionPackagePathTrusted(manifestPath, "extension package resource", state);
  state.metadataBytes += manifestStats.size;
  if (state.metadataBytes > MAX_EXTENSION_METADATA_BYTES) throwExtensionScanLimit();
  let document: unknown;
  try {
    document = JSON.parse(
      (await readFileAsync(manifestPath, { encoding: "utf8", signal: state.signal })).replace(/^\uFEFF/u, ""),
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    throwIfAttachmentAborted(state.signal);
    return { hasPiManifest: false };
  }
  if (!isRecord(document) || !isRecord(document.pi)) return { hasPiManifest: false };
  return {
    hasPiManifest: true,
    manifest: {
      extensions: readManifestEntries(document.pi, "extensions"),
      skills: readManifestEntries(document.pi, "skills"),
      prompts: readManifestEntries(document.pi, "prompts"),
      themes: readManifestEntries(document.pi, "themes"),
    },
  };
}

function readManifestEntries(manifest: Record<string, unknown>, resourceType: string): string[] | undefined {
  const entries = manifest[resourceType];
  return Array.isArray(entries) && entries.every((entrypoint) => typeof entrypoint === "string") ? entries : undefined;
}

async function addPackageIgnoreRules(
  ignoreMatcher: IgnoreMatcher,
  directory: string,
  rootDirectory: string,
  state: ExtensionScanState,
): Promise<void> {
  const relativeDirectory = path.relative(rootDirectory, directory);
  const prefix = relativeDirectory ? `${toPosixPath(relativeDirectory)}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    throwIfAttachmentAborted(state.signal);
    const ignorePath = path.join(directory, filename);
    const ignoreStats = await statIfPresent(ignorePath);
    if (!ignoreStats) continue;
    if (!ignoreStats.isFile()) throwInvalidIgnoreFile();
    assertExtensionPackagePathTrusted(ignorePath, "extension package resource", state);
    state.metadataBytes += ignoreStats.size;
    if (state.metadataBytes > MAX_EXTENSION_METADATA_BYTES) throwExtensionScanLimit();
    try {
      const content = await readFileAsync(ignorePath, { encoding: "utf8", signal: state.signal });
      throwIfAttachmentAborted(state.signal);
      const patterns = content
        .split(/\r?\n/u)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => line !== null);
      if (patterns.length > 0) ignoreMatcher.add(patterns);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAttachmentAborted(state.signal);
      // Pi ignores unreadable ignore files.
    }
  }
}

async function readBoundedPackageResourceEntries(directory: string, state: ExtensionScanState): Promise<Dirent[]> {
  let directoryHandle: Awaited<ReturnType<typeof opendirAsync>>;
  try {
    directoryHandle = await opendirAsync(directory);
  } catch {
    return [];
  }
  const entries: Dirent[] = [];
  try {
    for await (const entry of directoryHandle) {
      throwIfAttachmentAborted(state.signal);
      state.entries++;
      if (state.entries > MAX_EXTENSION_SCAN_ENTRIES) throwExtensionScanLimit();
      entries.push(entry);
    }
  } catch (error) {
    if (isAbortError(error) || isExtensionScanLimitError(error)) throw error;
    return [];
  }
  return entries;
}

async function readBoundedExtensionEntries(directory: string, state: ExtensionScanState): Promise<Dirent[]> {
  let directoryHandle: Awaited<ReturnType<typeof opendirAsync>>;
  try {
    directoryHandle = await opendirAsync(directory);
  } catch {
    throwUnresolvableExtensionEntrypoint();
  }
  const entries: Dirent[] = [];
  try {
    for await (const entry of directoryHandle) {
      throwIfAttachmentAborted(state.signal);
      state.entries++;
      if (state.entries > MAX_EXTENSION_SCAN_ENTRIES) throwExtensionScanLimit();
      entries.push(entry);
    }
  } catch (error) {
    if (isAbortError(error) || isExtensionScanLimitError(error)) throw error;
    throwUnresolvableExtensionEntrypoint();
  }
  return entries;
}

async function hasRegularExtensionIndex(directory: string, state: ExtensionScanState): Promise<boolean> {
  for (const filename of ["index.ts", "index.js"]) {
    const indexPath = path.join(directory, filename);
    const stats = await statIfPresent(indexPath);
    if (stats) {
      assertExtensionPackagePathTrusted(indexPath, "extension entrypoint", state);
      return stats.isFile();
    }
  }
  return false;
}

function assertExtensionPackagePathTrusted(
  resourcePath: string,
  label: "extension entrypoint" | "extension package resource",
  state: ExtensionScanState,
): void {
  if (state.projectTrusted) return;
  const canonicalPath = realpath(resourcePath, `Subagent ${label}`);
  assertProjectPathTrusted(resourcePath, canonicalPath, label, state.cwd, state.canonicalCwd, state.projectTrusted);
}

async function statIfPresent(value: string): Promise<Stats | undefined> {
  try {
    return await statAsync(value);
  } catch {
    return undefined;
  }
}

function throwUnresolvableExtensionEntrypoint(): never {
  throw new Error("Subagent extension package must not contain a missing or unresolvable declared entrypoint.");
}

function isExtensionScanLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "ExtensionScanLimitError";
}

function throwExtensionScanLimit(): never {
  const error = new Error(
    `Subagent extension attachment exceeds preflight limits (${MAX_EXTENSION_SCAN_ENTRIES} entries, depth ${MAX_EXTENSION_SCAN_DEPTH}, or ${MAX_EXTENSION_METADATA_BYTES} metadata bytes).`,
  );
  error.name = "ExtensionScanLimitError";
  throw error;
}

function isExtensionOverridePattern(value: string): boolean {
  return value.startsWith("!") || value.startsWith("+") || value.startsWith("-");
}

function hasExtensionGlob(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

function resolveExtensionToolName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Subagent extension tool name is required.");
  const name = value.trim();
  if (name.length > MAX_EXTENSION_TOOL_NAME_LENGTH || name.includes(",") || hasControlCharacter(name)) {
    throw new Error(
      `Subagent extension tool name must be at most ${MAX_EXTENSION_TOOL_NAME_LENGTH} characters without commas or control characters.`,
    );
  }
  return name;
}

function isLocalPath(value: string): boolean {
  if (value.startsWith("//") || value.startsWith("\\\\")) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return true;
  return !/^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function realpath(value: string, label: string): string {
  try {
    return realpathSync(value);
  } catch {
    throw new Error(`${label} path does not exist: ${sanitizeTerminalText(value).slice(0, 512)}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
