import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadSkillsFromDir,
  parseFrontmatter,
  type Skill,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { setModelInvocation } from "./frontmatter.ts";
import { withSkillTreeQueue } from "./mutation-queue.ts";
import type { Guard } from "./types.ts";

export interface InvocationSnapshot {
  readonly filePath: string;
  readonly canonicalPath: string;
  readonly enabled: boolean;
}

export interface InvocationUpdate {
  snapshot: InvocationSnapshot;
  changed: boolean;
}

interface InvocationRecord {
  filePath: string;
  canonicalPath: string;
  content: string;
  signature: string;
  parentIdentity: string;
  mode: number;
  uid: number;
  gid: number;
  enabled: boolean;
  requiresTrust: boolean;
}

const MAX_BYTES = 64 * 1024 * 1024;
type FileInfo = Awaited<ReturnType<typeof fs.lstat>>;
function identity(info: FileInfo): string {
  return `${info.dev}:${info.ino}`;
}
function signature(info: FileInfo): string {
  return JSON.stringify([info.dev, info.ino, info.size, info.mode, info.uid, info.gid, info.mtimeMs, info.nlink]);
}
function scopedGuard(guard: Guard, requiresTrust: boolean): Guard {
  return {
    signal: guard.signal,
    isProjectTrusted: guard.isProjectTrusted,
    check() {
      guard.check();
      guard.signal.throwIfAborted();
      if (requiresTrust && !guard.isProjectTrusted()) throw new Error("Project trust is required");
    },
  };
}

/** Injection supports deterministic filesystem-failure tests, not user settings. */
export function createInvocationSettings(operations: Partial<typeof fs> = {}) {
  const io = { ...fs, ...operations };
  const records = new WeakMap<InvocationSnapshot, InvocationRecord>();
  async function checked<T>(work: Promise<T>, guard: Guard): Promise<T> {
    const result = await work;
    guard.check();
    return result;
  }
  function expose(record: InvocationRecord): InvocationSnapshot {
    const snapshot = Object.freeze({
      filePath: record.filePath,
      canonicalPath: record.canonicalPath,
      enabled: record.enabled,
    });
    records.set(snapshot, record);
    return snapshot;
  }
  async function capture(filePath: string, requiresTrust: boolean, guard: Guard): Promise<InvocationRecord> {
    guard.check();
    // Following a loaded skill's link is deliberate. The UI shows this canonical
    // target before enabling a save; bundle Move/Remove keep their no-link policy.
    const canonicalPath = await checked(io.realpath(filePath), guard);
    const parent = dirname(canonicalPath);
    const parentInfo = await checked(io.stat(parent), guard);
    if (!parentInfo.isDirectory()) throw new Error("Skill parent is not a directory");
    const handle = await io.open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      guard.check();
      const before = await checked(handle.stat(), guard);
      if (!before.isFile()) throw new Error("Skill path is not a regular file");
      if (before.nlink !== 1) throw new Error("Hard-linked skill files cannot be edited atomically");
      if (before.size > MAX_BYTES) throw new Error("Skill file exceeds the 64 MiB settings limit");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await checked(handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset), guard);
        if (!result.bytesRead) throw new Error("Skill file changed while reading");
        offset += result.bytesRead;
      }
      const after = await checked(handle.stat(), guard);
      const current = await checked(io.lstat(canonicalPath), guard);
      const resolved = await checked(io.realpath(filePath), guard);
      const resolvedCanonical = await checked(io.realpath(canonicalPath), guard);
      const parentAfter = await checked(io.stat(parent), guard);
      if (
        !current.isFile() ||
        signature(before) !== signature(after) ||
        signature(after) !== signature(current) ||
        resolved !== canonicalPath ||
        resolvedCanonical !== canonicalPath ||
        identity(parentInfo) !== identity(parentAfter)
      ) {
        throw new Error("Skill file or target changed while reading");
      }
      const content = bytes.toString("utf8");
      if (!Buffer.from(content).equals(bytes)) throw new Error("Skill file is not valid UTF-8");
      let enabled: boolean;
      try {
        const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
        if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) throw new Error();
        enabled = frontmatter["disable-model-invocation"] !== true;
      } catch {
        throw new Error("Skill metadata is invalid; repair the file and reload Pi");
      }
      // Reject unsupported owned values instead of silently rewriting native YAML.
      setModelInvocation(content, enabled);
      return {
        filePath,
        canonicalPath,
        content,
        signature: signature(after),
        parentIdentity: identity(parentAfter),
        mode: after.mode & 0o7777,
        uid: after.uid,
        gid: after.gid,
        enabled,
        requiresTrust,
      };
    } finally {
      await handle.close();
    }
  }
  function unchanged(expected: InvocationRecord, current: InvocationRecord): void {
    if (
      expected.canonicalPath !== current.canonicalPath ||
      expected.parentIdentity !== current.parentIdentity ||
      expected.signature !== current.signature ||
      expected.content !== current.content
    ) {
      throw new Error("Skill file or target changed since review; select the skill again");
    }
  }
  async function validate(content: string, enabled: boolean, guard: Guard): Promise<void> {
    const directory = await io.mkdtemp(join(tmpdir(), ".pi-skills-invocation-"));
    try {
      guard.check();
      await checked(io.writeFile(join(directory, "SKILL.md"), content, { mode: 0o600 }), guard);
      const result = loadSkillsFromDir({ dir: directory, source: "path" });
      guard.check();
      if (result.skills.length !== 1 || result.skills[0].disableModelInvocation === enabled) {
        throw new Error("Pi rejected the updated skill metadata");
      }
    } finally {
      await io.rm(directory, { recursive: true, force: true });
    }
  }
  async function readInvocation(skill: Skill, owner: Guard): Promise<InvocationSnapshot> {
    const filePath = skill.filePath;
    const requiresTrust = skill.sourceInfo.scope !== "user";
    const guard = scopedGuard(owner, requiresTrust);
    return withSkillTreeQueue(() =>
      withFileMutationQueue(filePath, async () => {
        const record = await capture(filePath, requiresTrust, guard);
        // capture also drains handle.close(); ownership can change during cleanup.
        guard.check();
        return expose(record);
      }),
    );
  }
  async function updateInvocation(
    snapshot: InvocationSnapshot,
    enabled: boolean,
    owner: Guard,
  ): Promise<InvocationUpdate> {
    const record = records.get(snapshot);
    if (!record) throw new Error("Select a loaded skill before changing model invocation");
    const guard = scopedGuard(owner, record.requiresTrust);
    return withSkillTreeQueue(() =>
      withFileMutationQueue(record.filePath, async () => {
        const current = await capture(record.filePath, record.requiresTrust, guard);
        guard.check();
        unchanged(record, current);
        const candidate = setModelInvocation(current.content, enabled);
        if (candidate === current.content) {
          if (current.enabled !== enabled) throw new Error("Unsupported disable-model-invocation key format");
          return { snapshot, changed: false };
        }
        await validate(candidate, enabled, guard);
        guard.check();
        // A valid source basename can already use the filesystem's byte limit.
        const temporary = join(dirname(current.canonicalPath), `.invocation-${randomUUID()}.tmp`);
        let created = false;
        let published = false;
        try {
          const handle = await io.open(temporary, "wx", 0o600);
          created = true;
          let saved: FileInfo;
          try {
            guard.check();
            await checked(handle.writeFile(candidate, { encoding: "utf8", signal: guard.signal }), guard);
            const staged = await checked(handle.stat(), guard);
            if (staged.uid !== current.uid || staged.gid !== current.gid) {
              await checked(handle.chown(current.uid, current.gid), guard);
            }
            // Ownership changes can clear mode bits. Restore and verify both
            // before publishing, rather than silently changing shared access.
            await checked(handle.chmod(current.mode), guard);
            saved = await checked(handle.stat(), guard);
            if (saved.uid !== current.uid || saved.gid !== current.gid || (saved.mode & 0o7777) !== current.mode) {
              throw new Error("Cannot preserve the skill file's owner, group, and mode");
            }
          } finally {
            await handle.close();
          }
          guard.check();
          const latest = await capture(record.filePath, record.requiresTrust, guard);
          guard.check();
          unchanged(current, latest);
          await io.rename(temporary, current.canonicalPath);
          published = true;
          // Rename is the commit boundary. Return plain commit data even if the
          // caller was cancelled during rename; it must not report a rollback.
          return {
            changed: true,
            snapshot: expose({ ...current, content: candidate, signature: signature(saved), enabled }),
          };
        } finally {
          if (created && !published) await io.rm(temporary, { force: true });
        }
      }),
    );
  }
  return { readInvocation, updateInvocation };
}

const settings = createInvocationSettings();
export const readInvocation = settings.readInvocation;
export const updateInvocation = settings.updateInvocation;
