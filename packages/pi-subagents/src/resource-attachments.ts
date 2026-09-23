import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "./message-broker.js";

export const MAX_ATTACHED_SKILLS = 16;
export const MAX_ATTACHED_EXTENSIONS = 16;
export const MAX_SELECTED_TOOLS = 64;
export const MAX_RESOURCE_PATH_BYTES = 4 * 1024;
export const MAX_EXTENSION_TOOL_NAME_LENGTH = 128;

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
}

export function resolveResourceAttachments(
  input: ResourceAttachmentInput,
  options: ResolveResourceAttachmentOptions,
): ResolvedResourceAttachments {
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
  assertLoadableSkills(skills, cwd, canonicalCwd, options.projectTrusted);

  const extensions: ExtensionAttachment[] = [];
  const extensionsByPath = new Map<string, ExtensionAttachment>();
  for (const candidate of extensionInputs) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => key !== "path" && key !== "tools")) {
      throw new Error("Each subagent extension must contain only path and tools.");
    }
    const resolved = resolveResourcePath(candidate.path, "extension", cwd, canonicalCwd, options.projectTrusted);
    const toolInputs = optionalArray(candidate.tools, "extension tools", MAX_SELECTED_TOOLS, false);
    const tools = toolInputs.map(resolveExtensionToolName);
    let attachment = extensionsByPath.get(resolved);
    if (!attachment) {
      assertResolvableExtensionAttachment(resolved, cwd, canonicalCwd, options.projectTrusted);
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

function assertLoadableSkills(skillPaths: string[], cwd: string, canonicalCwd: string, projectTrusted: boolean): void {
  for (const skillPath of skillPaths) {
    const result = loadExplicitSkills([skillPath], cwd);
    if (result.skills.length === 0) {
      throw new Error("Subagent skill path must contain at least one loadable Pi skill.");
    }
    assertNoUntrustedProjectSkills(result, cwd, canonicalCwd, projectTrusted);
    assertNoOmittedSkillDiagnostics(result);
    assertNoSkillNameCollisions(result.diagnostics);
    assertNoSilentlyOmittedSkills(skillPath, cwd, result, canonicalCwd, projectTrusted);
  }
  if (skillPaths.length > 1) {
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

function assertNoSilentlyOmittedSkills(
  skillPath: string,
  cwd: string,
  result: ReturnType<typeof loadSkills>,
  canonicalCwd: string,
  projectTrusted: boolean,
): void {
  if (!statSync(skillPath).isDirectory()) return;
  const loadedPaths = new Set(result.skills.map((skill) => realpath(skill.filePath, "Loaded subagent skill")));
  const candidates = collectSkillCandidates(skillPath, true, new Set<string>());
  for (const candidate of candidates) {
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

function collectSkillCandidates(
  directory: string,
  includeRootMarkdown: boolean,
  visitedDirectories: Set<string>,
): string[] {
  const canonicalDirectory = realpath(directory, "Subagent skill directory");
  if (visitedDirectories.has(canonicalDirectory)) return [];
  visitedDirectories.add(canonicalDirectory);
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    throwInvalidDeclaredSkill();
  }

  const rootSkill = entries.find((entry) => entry.name === "SKILL.md");
  if (rootSkill) {
    const rootPath = path.join(directory, rootSkill.name);
    try {
      if (statSync(rootPath).isFile()) return [rootPath];
    } catch {
      throwInvalidDeclaredSkill();
    }
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const candidate = path.join(directory, entry.name);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(candidate);
    } catch {
      if (entry.name === "SKILL.md" || (includeRootMarkdown && entry.name.endsWith(".md"))) {
        throwInvalidDeclaredSkill();
      }
      continue;
    }
    if (stats.isDirectory()) {
      candidates.push(...collectSkillCandidates(candidate, false, visitedDirectories));
    } else if (stats.isFile() && (entry.name === "SKILL.md" || (includeRootMarkdown && entry.name.endsWith(".md")))) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function throwInvalidDeclaredSkill(): never {
  throw new Error("Subagent skill attachment must not contain an invalid or unreadable declared skill.");
}

function assertResolvableExtensionAttachment(
  extensionPath: string,
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
): void {
  const entrypoints = resolveAttachedExtensionEntrypoints(extensionPath);
  if (entrypoints.length === 0) {
    throw new Error("Subagent extension directory must contain at least one loadable Pi extension entrypoint.");
  }
  for (const entrypoint of entrypoints) {
    const lexicalPath = path.resolve(entrypoint);
    const canonicalPath = realpath(entrypoint, "Subagent extension entrypoint");
    const stats = statSync(canonicalPath);
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new Error("Subagent extension entrypoint must reference a file or directory.");
    }
    if (!projectTrusted && (isWithin(cwd, lexicalPath) || isWithin(canonicalCwd, canonicalPath))) {
      throw new Error("Subagent extension cannot load a project path because the project is not trusted.");
    }
  }
}

function resolveAttachedExtensionEntrypoints(extensionPath: string): string[] {
  if (!statSync(extensionPath).isDirectory()) return [extensionPath];
  const explicit = resolveExtensionDirectoryEntrypoints(extensionPath);
  const entrypoints = explicit ?? discoverExtensionEntrypoints(extensionPath);
  return [...new Set(entrypoints.map((entrypoint) => path.resolve(entrypoint)))];
}

function resolveExtensionDirectoryEntrypoints(directory: string): string[] | null {
  const manifestEntries = readExtensionManifestEntries(directory);
  if (manifestEntries) {
    const entrypoints = manifestEntries.map((entrypoint) => path.resolve(directory, entrypoint));
    if (entrypoints.some((entrypoint) => !existsSync(entrypoint))) {
      throw new Error("Subagent extension package must not contain a missing declared extension entrypoint.");
    }
    return entrypoints;
  }
  for (const filename of ["index.ts", "index.js"]) {
    const entrypoint = path.join(directory, filename);
    if (existsSync(entrypoint)) return [entrypoint];
  }
  return null;
}

function readExtensionManifestEntries(directory: string): string[] | undefined {
  const manifestPath = path.join(directory, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const document: unknown = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/u, ""));
    if (!isRecord(document) || !isRecord(document.pi)) return undefined;
    const entries = document.pi.extensions;
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every((entry) => typeof entry === "string")) {
      return undefined;
    }
    return entries;
  } catch {
    return undefined;
  }
}

function discoverExtensionEntrypoints(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const entrypoints: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      entrypoints.push(entryPath);
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const nested = resolveExtensionDirectoryEntrypoints(entryPath);
      if (nested) entrypoints.push(...nested);
    }
  }
  return entrypoints;
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
