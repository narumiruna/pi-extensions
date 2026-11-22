import { lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { isAbsolute, join, parse } from "node:path";
import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  getAgentDir,
  type ToolInfo,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_MAX_CHARS, validatePlanText } from "./completion-tool.js";
import { hasNativeToolSource } from "./tool-policy.js";

export const DRAFT_TOOL_NAMES = ["read", "write", "edit"] as const;
export const DRAFT_READ_LIMIT = "Keep the draft within 50 KiB, 2,000 lines, and 50,000 characters.";

export interface PlanDraftIdentity {
  version: 1;
  workflowId: string;
  sessionId: string;
  status: "pending" | "active";
}

export type DraftPreview = { kind: "waiting" } | { kind: "draft"; text: string } | { kind: "error"; reason: string };

interface DraftFile {
  root: string;
  workflowId: string;
  path: string;
  createdDirectory?: { dev: bigint; ino: bigint };
}

export function normalizePlanDraftIdentity(value: unknown): PlanDraftIdentity | undefined {
  const draft = value as Partial<PlanDraftIdentity> | undefined;
  if (
    draft?.version !== 1 ||
    typeof draft.workflowId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(draft.workflowId) ||
    typeof draft.sessionId !== "string" ||
    !draft.sessionId ||
    (draft.status !== "pending" && draft.status !== "active")
  )
    return undefined;
  return { version: 1, workflowId: draft.workflowId, sessionId: draft.sessionId, status: draft.status };
}

export function isActiveNativeDraftTool(tool: ToolInfo | undefined, active: ReadonlySet<string>) {
  return (
    tool &&
    hasNativeToolSource(tool) &&
    (tool.exposure === undefined || tool.exposure === "direct") &&
    active.has(tool.name)
  );
}

export function isNativeDraftPath(path: string) {
  if (!isAbsolute(path) || /[\p{Cc}\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(path)) return false;
  if (process.platform !== "win32") return true;
  return (
    /^[a-z]:\\/iu.test(path) &&
    path
      .slice(parse(path).root.length)
      .split("\\")
      .every(
        (part) => !/[:/]|[ .]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
      )
  );
}

function draftDirectories(root: string, workflowId: string) {
  const packageDir = join(root, "pi-plan-mode");
  const drafts = join(packageDir, "drafts");
  return [packageDir, drafts, join(drafts, workflowId)] as const;
}

function checkDirectory(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  ) {
    throw new Error("Draft directory is not a private, canonical directory.");
  }
  return stat;
}

function checkFile(file: DraftFile) {
  if (realpathSync(file.root) !== file.root) throw new Error("Draft root has changed.");
  for (const directory of draftDirectories(file.root, file.workflowId)) checkDirectory(directory);
  const stat = lstatSync(file.path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(file.path) !== file.path)) {
    throw new Error("Draft is not a regular, unlinked file.");
  }
  return stat;
}

function bindFile(identity: PlanDraftIdentity): DraftFile {
  const root = realpathSync(getAgentDir());
  const directories = draftDirectories(root, identity.workflowId);
  const path = join(directories[2], "plan.md");
  if (!isNativeDraftPath(path)) throw new Error("Pi cannot safely resolve the draft path.");
  const file: DraftFile = { root, workflowId: identity.workflowId, path };
  if (identity.status === "pending") {
    for (const directory of directories) {
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (directory === directories[2] || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const { dev, ino } = checkDirectory(directory);
      if (directory === directories[2]) file.createdDirectory = { dev, ino };
    }
  }
  checkFile(file);
  return file;
}

async function readDraft(file: DraftFile, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  return withFileMutationQueue(file.path, async () => {
    signal.throwIfAborted();
    const stat = checkFile(file);
    if (!stat) return undefined;
    if (stat.size > DEFAULT_MAX_BYTES) throw new Error(DRAFT_READ_LIMIT);
    const result = await createReadTool(cwd).execute("plan-draft", { path: file.path }, signal);
    signal.throwIfAborted();
    const [content] = result.content;
    if (result.details?.truncation?.truncated) throw new Error(DRAFT_READ_LIMIT);
    if (result.content.length !== 1 || content?.type !== "text" || Buffer.byteLength(content.text) !== stat.size) {
      throw new Error("Draft is not readable as UTF-8 Markdown. Write it again as text.");
    }
    return content.text;
  });
}

export function createPlanDraftController() {
  let file: DraftFile | undefined;
  let controller = new AbortController();
  let revision = 0;
  let preview: DraftPreview = { kind: "waiting" };
  let resync = false;
  const mutations = new Set<string>();

  function reset() {
    controller.abort();
    controller = new AbortController();
    file = undefined;
    revision += 1;
    mutations.clear();
    resync = false;
    preview = { kind: "waiting" };
  }

  return {
    reset,
    rollbackAdmission() {
      const previous = file;
      reset();
      if (!previous?.createdDirectory) return;
      try {
        if (realpathSync(previous.root) !== previous.root) return;
        const [packageDir, draftsDir, workflowDir] = draftDirectories(previous.root, previous.workflowId);
        checkDirectory(packageDir);
        checkDirectory(draftsDir);
        const { dev, ino } = checkDirectory(workflowDir);
        if (dev === previous.createdDirectory.dev && ino === previous.createdDirectory.ino) rmdirSync(workflowDir);
      } catch {
        return;
      }
    },
    bind(identity: PlanDraftIdentity) {
      reset();
      try {
        file = bindFile(identity);
      } catch {
        preview = { kind: "error", reason: "Draft directory is unavailable." };
      }
      return file?.path;
    },
    path: () => file?.path,
    preview: () => preview,
    hasPendingMutations: () => mutations.size > 0,
    admit(callId: string, path: unknown) {
      if (!file || path !== file.path)
        throw new Error("Use the exact absolute path to this workflow's Markdown draft.");
      try {
        checkFile(file);
      } catch {
        throw new Error("The draft path is unavailable or unsafe.");
      }
      revision += 1;
      mutations.add(callId);
    },
    finish(callId: string, isError: boolean, aborted: boolean) {
      if (!mutations.delete(callId)) return false;
      if (isError || aborted) resync = true;
      return !aborted && !isError;
    },
    settle() {
      const refresh = resync || mutations.size > 0;
      resync = false;
      mutations.clear();
      return refresh;
    },
    async refresh(cwd: string, isCurrent: () => boolean, runSignal?: AbortSignal) {
      if (!file || !isCurrent()) return false;
      const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
      const expected = ++revision;
      let next: DraftPreview;
      try {
        const text = await readDraft(file, cwd, signal);
        next = text?.trim() ? { kind: "draft", text } : { kind: "waiting" };
        if (text && text.length > PLAN_MODE_MAX_CHARS) next = { kind: "error", reason: DRAFT_READ_LIMIT };
      } catch (error) {
        next = {
          kind: "error",
          reason:
            error instanceof Error && error.message === DRAFT_READ_LIMIT
              ? DRAFT_READ_LIMIT
              : "Cannot read the Markdown draft.",
        };
      }
      if (!isCurrent()) return false;
      if (runSignal?.aborted) resync = true;
      if (signal.aborted || expected !== revision) return false;
      if (
        next.kind === preview.kind &&
        (next.kind === "waiting" ||
          (next.kind === "draft" && preview.kind === "draft" && next.text === preview.text) ||
          (next.kind === "error" && preview.kind === "error" && next.reason === preview.reason))
      )
        return false;
      preview = next;
      return true;
    },
    async snapshot(cwd: string, isCurrent: () => boolean, runSignal?: AbortSignal) {
      if (!isCurrent()) throw new Error("The Plan workflow no longer owns this draft.");
      if (!file) throw new Error("The draft directory is unavailable. Restore it and reload Plan mode.");
      if (mutations.size > 0) throw new Error("Wait for draft writes to finish before completing the plan.");
      const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
      const expected = revision;
      const text = await readDraft(file, cwd, signal);
      signal.throwIfAborted();
      if (!isCurrent() || revision !== expected || mutations.size > 0) {
        throw new Error("Plan draft changed while completing it. Retry once draft writes have finished.");
      }
      if (text === undefined) throw new Error("Write the decision-ready Markdown draft before completing the plan.");
      const normalized = validatePlanText(text);
      if (text.length > PLAN_MODE_MAX_CHARS) throw new Error(DRAFT_READ_LIMIT);
      if (!normalized.ok) throw new Error(`Draft ${normalized.error}. Update the draft and try again.`);
      return normalized.plan;
    },
  };
}
