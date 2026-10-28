import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { required } from "./invariant.ts";
import { inspectBundleMetadata, inspectMetadata } from "./metadata.ts";
import { withSkillTreeQueue as serialized } from "./mutation-queue.ts";
import type {
  Guard,
  Inventory,
  LocalSkill,
  Location,
  OperationRequest,
  OperationResult,
  PreparedBatch,
  SkillBundle,
} from "./types.ts";

function mutationQueues<T>(paths: string[], work: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths.map((path) => resolve(path)))].sort();
  const acquire = (index: number): Promise<T> =>
    index === ordered.length ? work() : withFileMutationQueue(ordered[index], () => acquire(index + 1));
  return acquire(0);
}

const LIMITS = { depth: 32, entries: 10000, bytes: 64 * 1024 * 1024, skills: 512 };
const discoveredRoots = new Set<string>();
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
type Budget = { entries: number; bytes: number };
type Entry = { path: string; mode: number; type: "directory" | "file" | "link"; content?: Buffer; link?: string };
type Snapshot = { entries: Entry[]; digest: string; identity: string; copyable: boolean; warnings?: string[] };
type Item = {
  origin?: string;
  source?: LocalSkill;
  destination?: string;
  snapshot?: Snapshot;
  skip?: string;
  warnings: string[];
};

function check(guard: Guard): void {
  guard.check();
  guard.signal.throwIfAborted();
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function within(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}
function overlap(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}
function leaf(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name) || name.startsWith(".")) {
    throw new Error(`Unsafe skill directory name: ${name}`);
  }
}
function spend(budget: Budget, bytes = 0): void {
  budget.entries++;
  budget.bytes += bytes;
  if (budget.entries > LIMITS.entries || budget.bytes > LIMITS.bytes)
    throw new Error("Skill inventory or bundle limit exceeded");
}
function digest(entries: Entry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => compare(a.path, b.path))) {
    hash.update(JSON.stringify([entry.path, entry.type, entry.mode, entry.link, entry.content?.length]));
    if (entry.content) hash.update(entry.content);
  }
  return hash.digest("hex");
}
function identity(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}
function fingerprint(snapshot: Snapshot): string {
  return `${snapshot.identity}:${snapshot.digest}:${snapshot.copyable}`;
}

/** Filesystem injection is for deterministic I/O-failure tests, not user configuration. */
export function createFilesystem(operations: Partial<typeof fs> = {}) {
  const io = { ...fs, ...operations };
  async function checked<T>(promise: Promise<T>, guard: Guard): Promise<T> {
    const result = await promise;
    check(guard);
    return result;
  }
  async function stat(path: string, guard: Guard) {
    try {
      return await checked(io.lstat(path), guard);
    } catch (error) {
      check(guard);
      if (missing(error)) return undefined;
      throw error;
    }
  }
  // Check every existing component, not only the final directory. A missing
  // suffix is allowed for destinations but cannot hide an existing link.
  async function noLinks(path: string, guard: Guard): Promise<void> {
    const absolute = resolve(path);
    const parts: string[] = [];
    let current = absolute;
    while (dirname(current) !== current) {
      parts.push(current);
      current = dirname(current);
    }
    parts.push(current);
    for (const part of parts.reverse()) {
      const value = await stat(part, guard);
      if (!value) break;
      if (value.isSymbolicLink()) throw new Error(`Symbolic link is read-only: ${part}`);
      if (part !== absolute && !value.isDirectory()) throw new Error(`Not a directory: ${part}`);
    }
    check(guard);
  }
  function mutable(location: Location, guard: Guard): void {
    check(guard);
    if (location.readOnlyReason) throw new Error(location.readOnlyReason);
    if (dirname(resolve(location.path)) === resolve(location.path))
      throw new Error("A filesystem root cannot be a writable skill container");
    if (location.scope === "project" && !guard.isProjectTrusted()) throw new Error("Project trust is required");
  }
  async function mutationPath(location: Location, path: string, guard: Guard): Promise<void> {
    mutable(location, guard);
    if (!within(location.path, path)) throw new Error(`Path escapes skill container: ${path}`);
    await noLinks(path, guard);
    mutable(location, guard);
  }
  async function readBytes(path: string, guard: Guard, budget: Budget): Promise<Buffer> {
    // O_NOFOLLOW prevents a final-component swap from following a link.
    const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      check(guard);
      const before = await checked(handle.stat(), guard);
      if (!before.isFile() || before.size > LIMITS.bytes - budget.bytes)
        throw new Error(`Unsupported or oversized file: ${path}`);
      const content = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < content.length) {
        const { bytesRead } = await checked(
          handle.read(content, offset, Math.min(65536, content.length - offset), offset),
          guard,
        );
        if (!bytesRead) throw new Error(`File became shorter while reading: ${path}`);
        offset += bytesRead;
      }
      spend(budget, content.length);
      const after = await checked(handle.stat(), guard);
      if (
        identity(before) !== identity(after) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.mode !== after.mode
      ) {
        throw new Error(`File changed while reading: ${path}`);
      }
      return content;
    } finally {
      await handle.close();
      check(guard);
    }
  }
  async function snapshot(path: string, guard: Guard, budget: Budget): Promise<Snapshot> {
    await noLinks(path, guard);
    const root = await checked(io.lstat(path), guard);
    if (!root.isDirectory()) throw new Error(`Not a skill directory: ${path}`);
    const entries: Entry[] = [];
    let copyable = true;
    async function walk(current: string, local: string, depth: number): Promise<void> {
      if (depth > LIMITS.depth) throw new Error("Skill tree depth limit exceeded");
      await noLinks(dirname(current), guard);
      const value = await checked(io.lstat(current), guard);
      const mode = value.mode & 0o7777;
      spend(budget);
      if (value.isSymbolicLink()) {
        copyable = false;
        entries.push({ path: local, type: "link", mode, link: await checked(io.readlink(current), guard) });
      } else if (value.isDirectory()) {
        entries.push({ path: local, type: "directory", mode });
        const names = await checked(io.readdir(current), guard);
        if (names.length > LIMITS.entries - budget.entries) throw new Error("Skill file count limit exceeded");
        for (const name of names.sort()) await walk(join(current, name), local ? `${local}/${name}` : name, depth + 1);
        const after = await checked(io.lstat(current), guard);
        if (identity(value) !== identity(after) || value.mode !== after.mode || value.mtimeMs !== after.mtimeMs)
          throw new Error(`Directory changed while reading: ${current}`);
      } else if (value.isFile()) {
        if (value.nlink > 1) copyable = false;
        const content = await readBytes(current, guard, budget);
        const after = await checked(io.lstat(current), guard);
        if (identity(value) !== identity(after) || value.mode !== after.mode || value.mtimeMs !== after.mtimeMs)
          throw new Error(`File changed while reading: ${current}`);
        entries.push({ path: local, type: "file", mode, content });
      } else {
        throw new Error(`Unsupported special file: ${current}`);
      }
    }
    await walk(path, "", 0);
    return { entries, digest: digest(entries), identity: identity(root), copyable };
  }

  async function scanInventory(locations: readonly Location[], guard: Guard): Promise<Inventory> {
    check(guard);
    if (locations.length > LIMITS.skills) throw new Error("Location count limit exceeded");
    const result: Inventory = { skills: [], warnings: [] };
    const budget: Budget = { entries: 0, bytes: 0 };
    for (const original of locations) {
      check(guard);
      const location = { ...original, path: resolve(original.path) };
      discoveredRoots.add(location.path);
      const seen = new Set<string>();
      let rootReason = location.readOnlyReason;
      try {
        await noLinks(location.path, guard);
      } catch (error) {
        check(guard);
        rootReason ??= errorText(error);
      }
      if (location.scope === "project" && !guard.isProjectTrusted()) {
        result.warnings.push(`${location.path}: Project trust is required`);
        continue;
      }
      async function add(path: string, reason?: string, markdown = false): Promise<void> {
        if (result.skills.length >= LIMITS.skills) throw new Error("Skill count limit exceeded");
        const warnings: string[] = [];
        let content = "";
        let print = "";
        const skillFile = markdown ? path : join(path, "SKILL.md");
        const fileStat = await stat(skillFile, guard);
        if (fileStat?.isFile()) content = (await readBytes(skillFile, guard, budget)).toString("utf8");
        else warnings.push("SKILL.md is not a regular file");
        if (!reason && !markdown) {
          try {
            print = fingerprint(await snapshot(path, guard, budget));
          } catch (error) {
            check(guard);
            reason = errorText(error);
          }
        }
        const metadata = inspectMetadata(content, markdown ? basename(path, ".md") : basename(path));
        result.skills.push({
          ...metadata,
          id: resolve(path),
          path: resolve(path),
          directoryPath: markdown ? dirname(resolve(path)) : resolve(path),
          location,
          content,
          warnings: [...metadata.warnings, ...warnings, ...(metadata.disabledReason ? [metadata.disabledReason] : [])],
          readOnlyReason: reason,
          fingerprint: print,
        });
      }
      async function discover(path: string, depth: number, reason?: string): Promise<void> {
        if (depth > LIMITS.depth) throw new Error("Inventory depth limit exceeded");
        spend(budget);
        const value = await stat(path, guard);
        if (!value) return;
        if (value.isSymbolicLink()) reason ??= "Symbolic link directory is read-only";
        const actual = value.isSymbolicLink() ? await checked(io.stat(path), guard) : value;
        if (!actual.isDirectory()) return;
        const canonical = await checked(io.realpath(path), guard);
        if (seen.has(canonical)) return;
        const names = await checked(io.readdir(path), guard);
        if (names.length > LIMITS.entries - budget.entries) throw new Error("Inventory entry limit exceeded");
        if (names.includes("SKILL.md")) {
          await add(path, reason ?? (path === location.path ? "The skill container itself is read-only" : undefined));
          return;
        }
        seen.add(canonical);
        for (const name of names.sort()) {
          spend(budget);
          if (name.startsWith(".") || name === "node_modules") continue;
          const child = join(path, name);
          const childStat = await stat(child, guard);
          if (childStat?.isDirectory() || childStat?.isSymbolicLink()) {
            try {
              await discover(child, depth + 1, reason);
            } catch (error) {
              check(guard);
              result.warnings.push(`${child}: ${errorText(error)}`);
            }
          } else if (depth === 0 && childStat?.isFile() && name.endsWith(".md")) {
            await add(child, "Standalone Markdown skills are read-only", true);
          }
        }
        seen.delete(canonical);
      }
      try {
        await discover(location.path, 0, rootReason);
      } catch (error) {
        check(guard);
        result.warnings.push(`${location.path}: ${errorText(error)}`);
      }
    }
    const names = new Map<string, LocalSkill[]>();
    for (const skill of result.skills) {
      const group = names.get(skill.name) ?? [];
      group.push(skill);
      names.set(skill.name, group);
    }
    for (const [name, skills] of names)
      if (skills.length > 1) {
        const warning = `Duplicate declared name "${name}": ${skills.map((skill) => skill.path).join(", ")}; Pi decides loading precedence`;
        result.warnings.push(warning);
        for (const skill of skills) skill.warnings.push(warning);
      }
    return result;
  }

  function bundleSnapshot(bundle: SkillBundle, budget: Budget): Snapshot {
    leaf(bundle.directoryName);
    const entries: Entry[] = [{ path: "", type: "directory", mode: 0o755 }];
    const paths = new Set<string>();
    for (const file of bundle.files) {
      const parts = file.path.split("/");
      if (
        !file.path ||
        isAbsolute(file.path) ||
        /[\\\0]/u.test(file.path) ||
        parts.some((part) => !part || part === "." || part === "..")
      )
        throw new Error(`Unsafe bundle path: ${file.path}`);
      if (parts.length > LIMITS.depth || paths.has(file.path))
        throw new Error(`Duplicate or deep bundle path: ${file.path}`);
      paths.add(file.path);
      spend(budget, file.content.length);
      entries.push({
        path: file.path,
        type: "file",
        mode: file.executable ? 0o755 : 0o644,
        content: Buffer.from(file.content),
      });
    }
    for (const path of paths) {
      let parent = dirname(path);
      while (parent !== ".") {
        if (paths.has(parent)) throw new Error(`File/directory conflict: ${parent}`);
        if (!entries.some((entry) => entry.path === parent)) {
          spend(budget);
          entries.push({ path: parent, type: "directory", mode: 0o755 });
        }
        parent = dirname(parent);
      }
    }
    const skill = entries.find((entry) => entry.path === "SKILL.md");
    if (!skill?.content) throw new Error("Bundle has no SKILL.md");
    const metadata = inspectBundleMetadata(
      entries
        .filter((entry) => entry.type === "file")
        .map((entry) => ({
          path: entry.path,
          content: required(entry.content),
          executable: (entry.mode & 0o111) !== 0,
        })),
      bundle.directoryName,
    );
    if (metadata.disabledReason) throw new Error(metadata.disabledReason);
    entries.sort((a, b) => compare(a.path, b.path));
    return { entries, digest: digest(entries), identity: "", copyable: true, warnings: metadata.warnings };
  }

  async function verifySource(item: Item, guard: Guard): Promise<void> {
    const source = item.source;
    if (!source || !item.snapshot) return;
    if (source.readOnlyReason) throw new Error(source.readOnlyReason);
    if (resolve(source.path) === resolve(source.location.path)) throw new Error("Cannot mutate the skill container");
    await mutationPath(source.location, source.path, guard);
    const current = await snapshot(source.path, guard, { entries: 0, bytes: 0 });
    if (fingerprint(current) !== fingerprint(item.snapshot))
      throw new Error(`Source changed since confirmation: ${source.path}`);
    mutable(source.location, guard);
  }

  async function prepareOperation(request: OperationRequest, guard: Guard): Promise<PreparedBatch> {
    // Do not let caller edits change the confirmed operation discriminator.
    request = { ...request };
    check(guard);
    if ((request.kind === "add" ? request.bundles : request.skills).length > LIMITS.skills)
      throw new Error("Selected skill count limit exceeded");
    const items: Item[] = [];
    const budget: Budget = { entries: 0, bytes: 0 };
    // Copy all caller-owned metadata: later UI changes cannot change a confirmed batch.
    const target = request.kind === "remove" ? undefined : { ...request.target, path: resolve(request.target.path) };
    const seen = new Set<string>();
    let targetAnchor: { path: string; identity: string } | undefined;
    if (target) {
      await mutationPath(target, target.path, guard);
      discoveredRoots.add(target.path);
      let path = target.path;
      let value = await stat(path, guard);
      while (!value) {
        path = dirname(path);
        value = await stat(path, guard);
      }
      if (!value.isDirectory()) throw new Error(`Not a skill container directory: ${path}`);
      targetAnchor = { path, identity: identity(value) };
    }
    async function verifyTarget(path: string, currentGuard: Guard): Promise<void> {
      await mutationPath(required(target), path, currentGuard);
      const value = await stat(required(targetAnchor).path, currentGuard);
      if (!value || identity(value) !== required(targetAnchor).identity)
        throw new Error(`Destination container changed since confirmation: ${required(targetAnchor).path}`);
      mutable(required(target), currentGuard);
    }
    for (const candidate of request.kind === "add" ? request.bundles : request.skills) {
      check(guard);
      const item: Item = { warnings: [...candidate.warnings] };
      try {
        if (request.kind === "add") {
          const bundle = candidate as SkillBundle;
          item.origin = bundle.id;
          item.destination = join(required(target).path, bundle.directoryName);
          item.snapshot = bundleSnapshot(bundle, budget);
          item.warnings = [...new Set([...item.warnings, ...required(item.snapshot.warnings)])];
        } else {
          const original = candidate as LocalSkill;
          const source = {
            ...original,
            path: resolve(original.path),
            location: { ...original.location, path: resolve(original.location.path) },
          };
          item.source = source;
          discoveredRoots.add(source.location.path);
          if (source.readOnlyReason) throw new Error(source.readOnlyReason);
          if (source.path === source.location.path || !within(source.location.path, source.path))
            throw new Error("Cannot mutate the skill container or a path outside it");
          leaf(basename(source.path));
          await mutationPath(source.location, source.path, guard);
          const skillFile = await stat(join(source.path, "SKILL.md"), guard);
          if (!skillFile) throw new Error("Selected directory has no SKILL.md");
          item.snapshot = await snapshot(source.path, guard, budget);
          if (!source.fingerprint || fingerprint(item.snapshot) !== source.fingerprint)
            throw new Error(`Source changed since inventory: ${source.path}`);
          if (request.kind === "move") {
            if (!item.snapshot.copyable)
              throw new Error("Cannot move a skill with symbolic links or hard-linked files");
            item.destination = join(required(target).path, basename(source.path));
            if (overlap(source.path, required(target).path) || overlap(source.path, item.destination))
              throw new Error("Source and destination trees overlap");
          }
        }
        const key = item.destination ?? required(item.source).path;
        if (seen.has(key)) item.skip = "Duplicate selected path";
        seen.add(key);
        if (item.destination) {
          leaf(basename(item.destination));
          await verifyTarget(item.destination, guard);
          if (await stat(item.destination, guard)) item.skip = "Destination already exists; no overwrite";
        }
      } catch (error) {
        check(guard);
        item.skip = errorText(error);
      }
      items.push(item);
    }
    // Reject cross-item overlaps, including a destination inside another source.
    for (const item of items)
      for (const other of items)
        if (item !== other && item.source && other.source && overlap(item.source.path, other.source.path)) {
          item.skip = "Selected source trees overlap";
        }
    for (const item of items)
      if (item.destination)
        for (const other of items)
          if (other.source && overlap(item.destination, other.source.path))
            item.skip = "Destination overlaps a selected source";
    const summary = items.flatMap((item) => [
      `${item.skip ? "Skip" : request.kind}: ${item.source?.path ?? item.origin ?? "bundle"}${item.destination ? ` -> ${item.destination}` : ""}${item.skip ? ` (${item.skip})` : ""}`,
      ...item.warnings.map((warning) => `Warning: ${warning}`),
    ]);
    if (request.kind === "add")
      summary.push(
        "Only files inside each selected bundle are copied; external references are not bundled or rewritten.",
      );
    let used = false;
    return {
      kind: request.kind,
      summary,
      async apply(applyGuard, register) {
        if (used) throw new Error("This confirmation has already been applied");
        used = true;
        return serialized(async () => {
          const results: OperationResult[] = [];
          let registered = false;
          let registrationFailed = false;
          for (const item of items) {
            const result: OperationResult = {
              source: item.source?.path,
              destination: item.destination,
              status: "failed",
              message: "",
              changed: false,
            };
            try {
              check(applyGuard);
            } catch {
              results.push({ ...result, status: "skipped", message: "Cancelled; remaining items were not started" });
              continue;
            }
            if (registrationFailed) {
              results.push({
                ...result,
                status: "skipped",
                message: "Registration failed; remaining items were not started",
              });
              continue;
            }
            if (item.skip) {
              results.push({ ...result, status: "skipped", message: item.skip });
              continue;
            }
            let staging: string | undefined;
            let published = false;
            try {
              await verifySource(item, applyGuard);
              if (request.kind === "remove") {
                await withFileMutationQueue(required(item.source).path, async () => {
                  await verifySource(item, applyGuard);
                  mutable(required(item.source).location, applyGuard);
                  await removeSource(item, applyGuard);
                  // Removal is one committed filesystem step, even if cancellation
                  // arrives while the operating system is completing it.
                  result.status = "removed";
                  result.changed = true;
                  result.message = "Removed";
                });
              } else {
                const destination = required(item.destination);
                await verifyTarget(destination, applyGuard);
                if (await stat(destination, applyGuard))
                  throw new Error("Destination appeared since confirmation; no overwrite");
                if (request.kind === "move" && !register) {
                  try {
                    await mutationQueues([required(item.source).path, destination], async () => {
                      await verifySource(item, applyGuard);
                      await verifyTarget(destination, applyGuard);
                      if (await stat(destination, applyGuard))
                        throw new Error("Destination already exists; no overwrite");
                      await makeRoot(required(target), applyGuard, () => verifyTarget(destination, applyGuard));
                      await verifySource(item, applyGuard);
                      await verifyTarget(destination, applyGuard);
                      if (await stat(destination, applyGuard))
                        throw new Error("Destination appeared since confirmation; no overwrite");
                      mutable(required(target), applyGuard);
                      mutable(required(item.source).location, applyGuard);
                      await io.rename(required(item.source).path, destination);
                      result.status = "moved";
                      result.changed = true;
                      result.message = "Moved";
                    });
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
                  }
                }
                if (!result.changed) {
                  staging = await stage(required(target), required(item.snapshot), applyGuard, () =>
                    verifyTarget(destination, applyGuard),
                  );
                  await verifySource(item, applyGuard);
                  await withFileMutationQueue(destination, async () => {
                    await verifyTarget(destination, applyGuard);
                    if (await stat(destination, applyGuard))
                      throw new Error("Destination appeared since confirmation; no overwrite");
                    await makeRoot(required(target), applyGuard, () => verifyTarget(destination, applyGuard));
                    await verifySource(item, applyGuard);
                    await verifyTarget(destination, applyGuard);
                    if (await stat(destination, applyGuard))
                      throw new Error("Destination appeared since confirmation; no overwrite");
                    mutable(required(target), applyGuard);
                    await io.rename(join(required(staging), "bundle"), destination);
                    published = true;
                    result.changed = true;
                  });
                  if (register && !registered) {
                    check(applyGuard);
                    try {
                      await register();
                      registered = true;
                    } catch (error) {
                      registrationFailed = true;
                      throw error;
                    }
                    check(applyGuard);
                  }
                  if (request.kind === "move") {
                    await withFileMutationQueue(required(item.source).path, async () => {
                      await verifySource(item, applyGuard);
                      await verifyTarget(destination, applyGuard);
                      const copy = await snapshot(destination, applyGuard, { entries: 0, bytes: 0 });
                      if (copy.digest !== required(item.snapshot).digest)
                        throw new Error("Published copy changed; source retained");
                      await verifySource(item, applyGuard);
                      mutable(required(item.source).location, applyGuard);
                      await removeSource(item, applyGuard);
                      result.status = "moved";
                      result.message = "Moved";
                    });
                  } else {
                    result.status = "installed";
                    result.message = "Installed";
                  }
                }
              }
            } catch (error) {
              result.status =
                published && request.kind === "move"
                  ? "source-retained"
                  : published && registered
                    ? "installed"
                    : "failed";
              const incomplete = (error as { incomplete?: boolean }).incomplete;
              if (incomplete) result.changed = true;
              result.message = `${published && request.kind === "move" ? (incomplete ? "Copied; source recovery incomplete. " : "Copied; source retained. ") : published ? (registered ? "Installed; registration succeeded. " : "Copied; registration not confirmed. ") : ""}${errorText(error)}`;
            } finally {
              if (staging) {
                try {
                  await io.rm(staging, { recursive: true, force: true });
                } catch (error) {
                  result.message += `; staging cleanup failed at ${staging}: ${errorText(error)}`;
                }
              }
            }
            results.push(result);
          }
          return results;
        });
      },
    };
  }

  async function removeSource(item: Item, guard: Guard): Promise<void> {
    const source = required(item.source);
    const saved = required(item.snapshot);
    await verifySource(item, guard);
    const parentPath = dirname(source.path);
    const parentIdentity = identity(await checked(io.lstat(parentPath), guard));
    await verifySource(item, guard);
    const projectTrusted = guard.isProjectTrusted();
    mutable(source.location, guard);
    // Deletion and missing-entry repair are one safe step. Capture plain-data
    // authorization before deletion; cancellation or session replacement must
    // not interrupt repair or call a context that is no longer owned.
    const recoveryGuard: Guard = {
      signal: new AbortController().signal,
      check() {},
      isProjectTrusted: () => projectTrusted,
    };
    try {
      await io.rm(source.path, { recursive: true });
    } catch (error) {
      // Recursive deletion can fail after deleting some children. Recover only
      // missing entries from the immutable confirmation snapshot, never replace
      // an existing entry or a newly substituted root.
      try {
        const guard = recoveryGuard;
        await mutationPath(source.location, source.path, guard);
        const root = await stat(source.path, guard);
        if (root && identity(root) !== saved.identity)
          throw new Error("Source root was replaced; refusing recovery writes");
        let expectedRoot = root ? saved.identity : undefined;
        async function recoveryPath(path: string): Promise<void> {
          await mutationPath(source.location, path, guard);
          const parent = await stat(parentPath, guard);
          const currentRoot = await stat(source.path, guard);
          if (
            !parent ||
            identity(parent) !== parentIdentity ||
            (expectedRoot ? !currentRoot || identity(currentRoot) !== expectedRoot : currentRoot !== undefined)
          ) {
            throw new Error("Source root or parent was replaced; refusing recovery writes");
          }
          mutable(source.location, guard);
        }
        const ordered = [...saved.entries].sort(
          (a, b) => a.path.split("/").length - b.path.split("/").length || compare(a.path, b.path),
        );
        const createdDirectories: Entry[] = [];
        for (const entry of ordered) {
          const path = join(source.path, entry.path);
          await recoveryPath(entry.path ? dirname(path) : path);
          const current = await stat(path, guard);
          if (current) {
            if (
              entry.type === "directory"
                ? !current.isDirectory()
                : entry.type === "link"
                  ? !current.isSymbolicLink()
                  : !current.isFile()
            )
              throw new Error(`Source entry was replaced: ${path}`);
            continue;
          }
          await recoveryPath(entry.path ? dirname(path) : path);
          if (entry.type === "directory") {
            await checked(io.mkdir(path, { mode: 0o700 }), guard);
            if (!entry.path) expectedRoot = identity(await checked(io.lstat(path), guard));
            createdDirectories.push(entry);
          } else if (entry.type === "file") {
            await checked(io.writeFile(path, required(entry.content), { flag: "wx", mode: entry.mode }), guard);
            await recoveryPath(path);
            await checked(io.chmod(path, entry.mode), guard);
          } else {
            await checked(io.symlink(required(entry.link), path), guard);
          }
        }
        for (const entry of createdDirectories.reverse()) {
          const path = join(source.path, entry.path);
          await recoveryPath(path);
          await checked(io.chmod(path, entry.mode), guard);
        }
        const restored = await snapshot(source.path, guard, { entries: 0, bytes: 0 });
        if (restored.digest !== saved.digest)
          throw new Error("Recovered source does not match the confirmation snapshot");
      } catch (recovery) {
        throw Object.assign(
          new Error(
            `Removal failed: ${errorText(error)}; source recovery incomplete at ${source.path}: ${errorText(recovery)}${item.destination ? `; complete published copy: ${item.destination}` : "; do not retry removal without inspection"}`,
          ),
          { incomplete: true },
        );
      }
      throw new Error(`Removal failed; complete source retained at ${source.path}: ${errorText(error)}`);
    }
  }

  async function makeRoot(target: Location, guard: Guard, validate: () => Promise<void>): Promise<void> {
    await validate();
    mutable(target, guard);
    await checked(io.mkdir(target.path, { recursive: true }), guard);
    await validate();
  }
  async function stage(
    target: Location,
    value: Snapshot,
    guard: Guard,
    validate: () => Promise<void>,
  ): Promise<string> {
    // Use the nearest existing ancestor outside the destination container. The
    // device check rejects mount layouts where no outside-root samefs stage exists.
    let parent = dirname(target.path);
    while ([...discoveredRoots].some((root) => within(root, parent))) {
      if (dirname(parent) === parent) throw new Error("No staging directory outside discoverable roots");
      parent = dirname(parent);
    }
    let ancestor = parent;
    while (dirname(ancestor) !== ancestor) {
      if (await stat(join(ancestor, "SKILL.md"), guard)) parent = dirname(ancestor);
      ancestor = dirname(ancestor);
    }
    let parentStat = await stat(parent, guard);
    while (!parentStat) {
      parent = dirname(parent);
      parentStat = await stat(parent, guard);
    }
    await noLinks(parent, guard);
    let devicePath = target.path;
    let rootStat = await stat(devicePath, guard);
    while (!rootStat) {
      devicePath = dirname(devicePath);
      rootStat = await stat(devicePath, guard);
    }
    if (rootStat.dev !== parentStat.dev) throw new Error("No same-filesystem staging directory outside the skill root");
    const marker = await stat(join(parent, "SKILL.md"), guard);
    if (marker) throw new Error("Cannot stage inside another skill directory");
    await validate();
    mutable(target, guard);
    const staging = await io.mkdtemp(join(parent, ".pi-skills-stage-"));
    try {
      check(guard);
      for (const entry of [...value.entries].sort(
        (a, b) => a.path.split("/").length - b.path.split("/").length || compare(a.path, b.path),
      )) {
        const path = join(staging, "bundle", entry.path);
        check(guard);
        mutable(target, guard);
        await noLinks(dirname(path), guard);
        mutable(target, guard);
        if (entry.type === "directory") await checked(io.mkdir(path, { mode: 0o700 }), guard);
        else if (entry.type === "file") {
          await checked(io.writeFile(path, required(entry.content), { flag: "wx", mode: entry.mode }), guard);
          mutable(target, guard);
          await checked(io.chmod(path, entry.mode), guard);
        } else throw new Error("Cannot copy symbolic links");
      }
      // Apply directory modes last, so read-only directories do not prevent copy.
      for (const entry of [...value.entries].reverse())
        if (entry.type === "directory") {
          mutable(target, guard);
          await checked(io.chmod(join(staging, "bundle", entry.path), entry.mode), guard);
        }
      const actual = await snapshot(join(staging, "bundle"), guard, { entries: 0, bytes: 0 });
      if (actual.digest !== value.digest) throw new Error("Staged content verification failed");
      return staging;
    } catch (error) {
      try {
        await io.rm(staging, { recursive: true, force: true });
      } catch (cleanup) {
        throw new Error(`${errorText(error)}; staging cleanup failed at ${staging}: ${errorText(cleanup)}`);
      }
      throw error;
    }
  }
  return {
    scanInventory: (locations: readonly Location[], guard: Guard) => serialized(() => scanInventory(locations, guard)),
    prepareOperation: (request: OperationRequest, guard: Guard) => serialized(() => prepareOperation(request, guard)),
  };
}

const engine = createFilesystem();
export const scanInventory = engine.scanInventory;
export const prepareOperation = engine.prepareOperation;
