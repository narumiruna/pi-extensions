import { type Dirent, existsSync, type Stats, statSync } from "node:fs";
import {
  opendir as opendirAsync,
  readFile as readFileAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import * as path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import ignore from "ignore";
import {
  addAttachmentIgnoreRules,
  type IgnoreMatcher,
  isAbortError,
  isRecord,
  isWithin,
  realpath,
  throwIfAttachmentAborted,
  toolSourceId,
  toPosixPath,
} from "./attachment-utils.js";
import { CHILD_COMMUNICATION_TOOL_NAMES } from "./child-communication-tools.js";
import { assertLoadablePackageSkills, assertLoadableSkills } from "./skill-attachments.js";
import { CHILD_CORE_TOOL_NAMES } from "./types.js";

export {
  MAX_SKILL_IGNORE_BYTES,
  MAX_SKILL_SCAN_BYTES,
  MAX_SKILL_SCAN_DEPTH,
  MAX_SKILL_SCAN_ENTRIES,
} from "./skill-attachments.js";

export const MAX_ATTACHED_SKILLS = 16;
export const MAX_ATTACHED_EXTENSIONS = 16;
export const MAX_SELECTED_TOOLS = 64;
export const MAX_RESOURCE_PATH_BYTES = 4 * 1024;
export const MAX_EXTENSION_TOOL_NAME_LENGTH = 128;
export const MAX_EXTENSION_SCAN_DEPTH = 32;
export const MAX_EXTENSION_SCAN_ENTRIES = 4_096;
export const MAX_EXTENSION_METADATA_BYTES = 1024 * 1024;

const RESERVED_CHILD_TOOL_NAMES = new Set<string>([...CHILD_CORE_TOOL_NAMES, ...CHILD_COMMUNICATION_TOOL_NAMES]);

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
  toolSources: Record<string, string[]>;
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
  const skillScanState = await assertLoadableSkills(skills, cwd, canonicalCwd, options.projectTrusted, options.signal);

  const extensions: ExtensionAttachment[] = [];
  const extensionsByPath = new Map<string, ExtensionAttachment>();
  const entrypointsByPath = new Map<string, string[]>();
  const packageSkillPaths: string[] = [];
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
      const resources = await assertResolvableExtensionAttachment(
        resolved,
        cwd,
        canonicalCwd,
        options.projectTrusted,
        options.signal,
      );
      packageSkillPaths.push(...resources.skills);
      entrypointsByPath.set(resolved, resources.entrypoints);
      attachment = { path: resolved, tools: [] };
      extensionsByPath.set(resolved, attachment);
      extensions.push(attachment);
    }
    for (const tool of tools) {
      if (!attachment.tools.includes(tool)) attachment.tools.push(tool);
    }
  }

  if (packageSkillPaths.length > 0) {
    await assertLoadablePackageSkills(packageSkillPaths, skills, cwd, skillScanState);
  }

  const effectiveTools = [...new Set([...options.coreTools, ...extensions.flatMap((extension) => extension.tools)])];
  if (effectiveTools.length > MAX_SELECTED_TOOLS) {
    throw new Error(`Subagent jobs may select at most ${MAX_SELECTED_TOOLS} total tools.`);
  }
  const toolSources = new Map<string, string[]>();
  const firstSourceIdByCanonicalPath = new Map<string, string>();
  for (const extension of extensions) {
    // Pi keeps the first lexical source when multiple entrypoints resolve to the same file.
    const sourceIds = (entrypointsByPath.get(extension.path) ?? []).map((entrypoint) => {
      const canonicalPath = realpath(entrypoint, "Subagent extension entrypoint");
      const sourceId = firstSourceIdByCanonicalPath.get(canonicalPath) ?? toolSourceId(entrypoint);
      firstSourceIdByCanonicalPath.set(canonicalPath, sourceId);
      return sourceId;
    });
    for (const tool of extension.tools) {
      if (toolSources.has(tool)) {
        throw new Error(`Subagent extension tool ${tool} is requested by multiple attachments.`);
      }
      toolSources.set(tool, sourceIds);
    }
  }
  return { skills, extensions, effectiveTools, toolSources: Object.fromEntries(toolSources) };
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

async function assertResolvableExtensionAttachment(
  extensionPath: string,
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
  signal?: AbortSignal,
): Promise<{ skills: string[]; entrypoints: string[] }> {
  await inspectExtensionAttachment(extensionPath, cwd, canonicalCwd, projectTrusted, signal);
  throwIfAttachmentAborted(signal);
  const resolved = await resolveAttachedExtensionResources(extensionPath, cwd);
  throwIfAttachmentAborted(signal);
  const entrypoints = enabledResourcePaths(resolved.extensions);
  if (entrypoints.length === 0) {
    throw new Error("Subagent extension directory must contain at least one loadable Pi extension entrypoint.");
  }
  const loadPaths = entrypoints.flatMap(resolveDirectExtensionLoadPaths);
  for (const entrypoint of loadPaths) {
    assertTrustedResolvedPath(entrypoint, "extension entrypoint", cwd, canonicalCwd, projectTrusted);
  }
  const packageSkills = enabledResourcePaths(resolved.skills);
  const packageResources = [
    packageSkills,
    enabledResourcePaths(resolved.prompts),
    enabledResourcePaths(resolved.themes),
  ].flat();
  for (const resource of packageResources) {
    assertTrustedResolvedPath(resource, "extension package resource", cwd, canonicalCwd, projectTrusted);
  }
  return { skills: packageSkills, entrypoints: loadPaths };
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
  enforceTrust = true,
): Promise<boolean> {
  throwIfAttachmentAborted(state.signal);
  if (enforceTrust) assertExtensionPackagePathTrusted(directory, "extension entrypoint", state);
  const inspected = await inspectPiManifest(directory, state, enforceTrust);
  const sourceEntries = inspected.manifest?.extensions?.filter((entrypoint) => !isExtensionOverridePattern(entrypoint));
  if (sourceEntries && sourceEntries.length > 0) {
    await inspectDeclaredExtensionEntries(directory, inspected.manifest?.extensions, false, state);
    return true;
  }
  if (await hasRegularExtensionIndex(directory, state, enforceTrust)) return true;
  if (!discoverContents) return false;

  const ignoreMatcher = ignore();
  await addPackageIgnoreRules(ignoreMatcher, directory, directory, state, enforceTrust);
  const entries = await readBoundedPackageEntries(directory, state, "reject");
  let found = false;
  for (const entry of entries) {
    throwIfAttachmentAborted(state.signal);
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    const entryStats = await statIfPresent(entryPath);
    if (!entryStats) continue;
    const relativePath = toPosixPath(path.relative(directory, entryPath));
    if (ignoreMatcher.ignores(entryStats.isDirectory() ? `${relativePath}/` : relativePath)) continue;
    if (entryStats.isFile()) {
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
      if (enforceTrust) assertExtensionPackagePathTrusted(entryPath, "extension entrypoint", state);
      found = true;
    } else if (entryStats.isDirectory()) {
      if (enforceTrust) assertExtensionPackagePathTrusted(entryPath, "extension entrypoint", state);
      if (await inspectAutoExtensionDirectory(entryPath, false, state, enforceTrust)) found = true;
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
  // Bound declared trees here, then trust-gate only Pi's final enabled resources after manifest overrides.
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
    if (resolvedStats.isFile()) continue;
    if (!resolvedStats.isDirectory()) throwUnresolvableExtensionEntrypoint();
    if (expandDirectories) {
      if (!(await inspectAutoExtensionDirectory(resolved, true, state, false))) throwUnresolvableExtensionEntrypoint();
    } else if (!(await hasRegularExtensionIndex(resolved, state, false))) {
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
  // Bound declared trees here, then trust-gate only Pi's final enabled resources after manifest overrides.
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
    throwIfAttachmentAborted(state.signal);
    if (resourceType === "skills" && (!resolvedStats || (!resolvedStats.isFile() && !resolvedStats.isDirectory()))) {
      throw new Error("Subagent extension package must not contain a missing or unreadable declared skill.");
    }
    if (resolvedStats?.isDirectory()) await inspectPackageResourceDirectory(resolved, resourceType, state, false);
  }
}

async function inspectPackageResourceDirectory(
  directory: string,
  resourceType: PackageResourceType,
  state: ExtensionScanState,
  enforceTrust = true,
): Promise<void> {
  await inspectPackageResourceTree(directory, resourceType, ignore(), directory, 0, state, enforceTrust);
}

async function inspectPackageResourceTree(
  directory: string,
  resourceType: PackageResourceType,
  ignoreMatcher: IgnoreMatcher,
  rootDirectory: string,
  depth: number,
  state: ExtensionScanState,
  enforceTrust: boolean,
): Promise<void> {
  const canonicalDirectory = await enterPackageResourceDirectory(directory, resourceType, depth, state, enforceTrust);
  if (!canonicalDirectory) return;
  try {
    await addPackageIgnoreRules(ignoreMatcher, directory, rootDirectory, state, enforceTrust);
    const entries = await readBoundedPackageEntries(
      directory,
      state,
      resourceType === "skills" ? "reject-skill" : "skip",
    );
    if (resourceType === "skills") {
      const rootSkill = entries.find((entry) => entry.name === "SKILL.md");
      if (rootSkill) {
        const skillPath = path.join(directory, rootSkill.name);
        const skillStats = await statIfPresent(skillPath);
        const relativePath = toPosixPath(path.relative(rootDirectory, skillPath));
        if (skillStats?.isFile() && !ignoreMatcher.ignores(relativePath)) {
          if (enforceTrust) assertExtensionPackagePathTrusted(skillPath, "extension package resource", state);
          return;
        }
      }
    }
    for (const entry of entries) {
      throwIfAttachmentAborted(state.signal);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const entryPath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(rootDirectory, entryPath));
      const entryStats = await statIfPresent(entryPath);
      throwIfAttachmentAborted(state.signal);
      const isSkillCandidate =
        resourceType === "skills" &&
        (entry.name === "SKILL.md" || (directory === rootDirectory && entry.name.endsWith(".md")));
      if (
        isSkillCandidate &&
        (!entryStats || (!entryStats.isFile() && !entryStats.isDirectory())) &&
        !ignoreMatcher.ignores(relativePath) &&
        !ignoreMatcher.ignores(`${relativePath}/`)
      ) {
        throw new Error("Subagent extension package must not contain an invalid or unreadable declared skill.");
      }
      if (!entryStats) continue;
      if (ignoreMatcher.ignores(entryStats.isDirectory() ? `${relativePath}/` : relativePath)) continue;
      if (entryStats.isFile()) {
        const isResourceFile =
          entry.name.endsWith(resourceType === "themes" ? ".json" : ".md") &&
          (resourceType !== "skills" || directory === rootDirectory);
        if (enforceTrust && isResourceFile) {
          assertExtensionPackagePathTrusted(entryPath, "extension package resource", state);
        }
        continue;
      }
      if (!entryStats.isDirectory()) continue;
      if (enforceTrust) assertExtensionPackagePathTrusted(entryPath, "extension package resource", state);
      await inspectPackageResourceTree(
        entryPath,
        resourceType,
        ignoreMatcher,
        rootDirectory,
        depth + 1,
        state,
        enforceTrust,
      );
    }
  } finally {
    state.ancestors.delete(canonicalDirectory);
  }
}

async function enterPackageResourceDirectory(
  directory: string,
  resourceType: PackageResourceType,
  depth: number,
  state: ExtensionScanState,
  enforceTrust: boolean,
): Promise<string | undefined> {
  throwIfAttachmentAborted(state.signal);
  if (depth > MAX_EXTENSION_SCAN_DEPTH) throwExtensionScanLimit();
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpathAsync(directory);
  } catch {
    throwIfAttachmentAborted(state.signal);
    if (resourceType === "skills") throwUnreadablePackageSkillDirectory();
    return undefined;
  }
  throwIfAttachmentAborted(state.signal);
  if (enforceTrust) {
    assertProjectPathTrusted(
      directory,
      canonicalDirectory,
      "extension package resource",
      state.cwd,
      state.canonicalCwd,
      state.projectTrusted,
    );
  }
  if (state.ancestors.has(canonicalDirectory)) {
    throw new Error("Subagent extension package must not contain a recursive resource directory link.");
  }
  state.ancestors.add(canonicalDirectory);
  return canonicalDirectory;
}

async function inspectPiManifest(
  directory: string,
  state: ExtensionScanState,
  enforceTrust = true,
): Promise<InspectedPiManifest> {
  const manifestPath = path.join(directory, "package.json");
  const manifestStats = await statIfPresent(manifestPath);
  if (!manifestStats) return { hasPiManifest: false };
  if (!manifestStats.isFile()) {
    throw new Error("Subagent extension package manifest must be a regular file.");
  }
  if (enforceTrust) assertExtensionPackagePathTrusted(manifestPath, "extension package resource", state);
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
  enforceTrust: boolean,
): Promise<void> {
  await addAttachmentIgnoreRules(ignoreMatcher, directory, rootDirectory, state.signal, (ignorePath, bytes) => {
    if (enforceTrust) assertExtensionPackagePathTrusted(ignorePath, "extension package resource", state);
    state.metadataBytes += bytes;
    if (state.metadataBytes > MAX_EXTENSION_METADATA_BYTES) throwExtensionScanLimit();
  });
}

async function readBoundedPackageEntries(
  directory: string,
  state: ExtensionScanState,
  onFailure: "skip" | "reject" | "reject-skill",
): Promise<Dirent[]> {
  let directoryHandle: Awaited<ReturnType<typeof opendirAsync>>;
  try {
    directoryHandle = await opendirAsync(directory);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throwIfAttachmentAborted(state.signal);
    return failedPackageDirectoryRead(onFailure);
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
    throwIfAttachmentAborted(state.signal);
    return failedPackageDirectoryRead(onFailure);
  }
  throwIfAttachmentAborted(state.signal);
  return entries;
}

function failedPackageDirectoryRead(onFailure: "skip" | "reject" | "reject-skill"): Dirent[] {
  if (onFailure === "reject") throwUnresolvableExtensionEntrypoint();
  if (onFailure === "reject-skill") throwUnreadablePackageSkillDirectory();
  return [];
}

function throwUnreadablePackageSkillDirectory(): never {
  throw new Error("Subagent extension package must not contain an unreadable declared skill directory.");
}

async function hasRegularExtensionIndex(
  directory: string,
  state: ExtensionScanState,
  enforceTrust = true,
): Promise<boolean> {
  for (const filename of ["index.ts", "index.js"]) {
    const indexPath = path.join(directory, filename);
    const stats = await statIfPresent(indexPath);
    if (stats) {
      if (enforceTrust) assertExtensionPackagePathTrusted(indexPath, "extension entrypoint", state);
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

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}
