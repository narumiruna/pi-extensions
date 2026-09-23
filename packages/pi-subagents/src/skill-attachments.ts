import { type Dirent, statSync } from "node:fs";
import { opendir as opendirAsync, realpath as realpathAsync, stat as statAsync } from "node:fs/promises";
import * as path from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import ignore from "ignore";
import {
  addAttachmentIgnoreRules,
  type IgnoreMatcher,
  isAbortError,
  isWithin,
  realpath,
  throwIfAttachmentAborted,
  toPosixPath,
} from "./attachment-utils.js";

export const MAX_SKILL_SCAN_DEPTH = 32;
export const MAX_SKILL_SCAN_ENTRIES = 4_096;
export const MAX_SKILL_SCAN_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_IGNORE_BYTES = 1024 * 1024;

export async function assertLoadableSkills(
  skillPaths: string[],
  cwd: string,
  canonicalCwd: string,
  projectTrusted: boolean,
  signal?: AbortSignal,
): Promise<SkillScanState> {
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
  return scanState;
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
    await addAttachmentIgnoreRules(ignoreMatcher, directory, rootDirectory, state.signal, (_ignorePath, bytes) => {
      state.ignoreBytes += bytes;
      if (state.ignoreBytes > MAX_SKILL_IGNORE_BYTES) throwSkillScanLimit();
    });
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
      const relativePath = toPosixPath(path.relative(rootDirectory, rootPath));
      if (!ignoreMatcher.ignores(relativePath)) {
        let rootStats: Awaited<ReturnType<typeof statAsync>>;
        try {
          rootStats = await statAsync(rootPath);
        } catch (error) {
          if (isAbortError(error)) throw error;
          throwInvalidDeclaredSkill();
        }
        throwIfAttachmentAborted(state.signal);
        if (rootStats.isFile()) {
          addSkillBytes(state, rootStats.size);
          return [rootPath];
        }
      }
    }

    const candidates: string[] = [];
    for (const entry of entries) {
      throwIfAttachmentAborted(state.signal);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const candidate = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(rootDirectory, candidate));
      let candidateStats: Awaited<ReturnType<typeof statAsync>>;
      try {
        candidateStats = await statAsync(candidate);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throwIfAttachmentAborted(state.signal);
        if (
          !ignoreMatcher.ignores(relativePath) &&
          (entry.name === "SKILL.md" || (includeRootMarkdown && entry.name.endsWith(".md")))
        ) {
          throwInvalidDeclaredSkill();
        }
        continue;
      }
      throwIfAttachmentAborted(state.signal);
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

function throwInvalidDeclaredSkill(): never {
  throw new Error("Subagent skill attachment must not contain an invalid or unreadable declared skill.");
}

export async function assertLoadablePackageSkills(
  packageSkillPaths: string[],
  explicitSkillPaths: string[],
  cwd: string,
  scanState: SkillScanState,
): Promise<void> {
  const uniquePackageSkillPaths = deduplicatePackageSkillPaths(packageSkillPaths, explicitSkillPaths);
  for (const [index, skillPath] of uniquePackageSkillPaths.entries()) {
    if (index > 0 && index % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfAttachmentAborted(scanState.signal);
    await collectBoundedSkillCandidates(skillPath, scanState);
  }
  for (const [index, skillPath] of uniquePackageSkillPaths.entries()) {
    if (index > 0 && index % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfAttachmentAborted(scanState.signal);
    const result = loadExplicitSkills([skillPath], cwd);
    if (result.skills.length === 0) throwInvalidDeclaredSkill();
    assertNoOmittedSkillDiagnostics(result);
  }
  throwIfAttachmentAborted(scanState.signal);
  assertNoSkillNameCollisions(loadExplicitSkills([...uniquePackageSkillPaths, ...explicitSkillPaths], cwd).diagnostics);
}

function deduplicatePackageSkillPaths(packageSkillPaths: string[], explicitSkillPaths: string[]): string[] {
  const seenPaths = new Set(explicitSkillPaths.map((skillPath) => realpath(skillPath, "Loaded subagent skill")));
  const uniquePaths: string[] = [];
  for (const skillPath of packageSkillPaths) {
    const canonicalPath = realpath(skillPath, "Loaded subagent package skill");
    if (seenPaths.has(canonicalPath)) continue;
    seenPaths.add(canonicalPath);
    uniquePaths.push(skillPath);
  }
  return uniquePaths;
}
