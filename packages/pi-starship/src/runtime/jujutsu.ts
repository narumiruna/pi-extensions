import { dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import type { JujutsuBookmark } from "../modules/types.js";
import { isRecord, MAX_COMMAND_OUTPUT_BYTES, runBounded } from "./helpers.js";
import type { CollectorContext, MutableModuleSnapshot } from "./types.js";

const MAX_ANCESTORS = 64;
const MODULES = ["jj_bookmark", "jj_change", "jj_metrics", "jj_status"] as const;

// Match Starship's selection: the current change, the latest mutable conflicted
// ancestor head, and the latest bookmark ancestor. These can be the same change.
const REVSET = "@ | latest(heads(mutable() & ::@ & conflicts()), 1) | latest(bookmarks() & ::@, 1)";
const TEMPLATE = String.raw`if(
  current_working_copy,
  join(
    "\n",
    concat("current.has_description = ", description.len() > 0),
    concat("current.hidden = ", hidden),
    concat("current.immutable = ", immutable),
    concat("current.divergent = ", divergent),
    concat("current.change_offset = ", change_offset),
    concat("current.change_id = \"", change_id, "\""),
    concat("current.change_id_prefix_len = ", change_id.shortest().prefix().len()),
    concat("current.commit_id = \"", commit_id, "\""),
    concat("current.commit_id_prefix_len = ", commit_id.shortest().prefix().len()),
    concat("current.lines_added = ", diff.stat().total_added()),
    concat("current.lines_removed = ", diff.stat().total_removed()),
    concat("current.conflicted = ", conflict),
    concat("current.bookmarks = [", bookmarks.map(|bm| concat("{ name = ", bm.name().escape_json(), ", remote = ", if(bm.remote(), bm.remote().escape_json(), "\"\""), ", diverged = ", !bm.conflict() && !bm.synced() && (!bm.remote() || bm.tracked()), " }")).join(","), "]"),
    concat("current.statuses = \"", self.diff().files().map(|file| file.status_char()).join(""), "\""),
    "",
  ),
  concat(
    "parents.", commit_id, ".conflicted = ", conflict, "\n",
    "parents.", commit_id, ".bookmark_source = ", contained_in("latest(bookmarks() & ::@, 1)"), "\n",
    "parents.", commit_id, ".bookmarks = [", bookmarks.map(|bm| concat("{ name = ", bm.name().escape_json(), ", remote = ", if(bm.remote(), bm.remote().escape_json(), "\"\""), ", diverged = ", !bm.conflict() && !bm.synced() && (!bm.remote() || bm.tracked()), " }")).join(","), "]\n",
  ),
)`;

export async function collectJujutsu(context: CollectorContext): Promise<MutableModuleSnapshot> {
  if (context.input.signal?.aborted || !MODULES.some((name) => context.needs(name))) return {};
  const root = await discoverRoot(context);
  if (!root || context.input.signal?.aborted) return {};
  // Unlike a shell prompt, a footer must not snapshot the working copy or write
  // the repository. Values describe the last recorded working-copy change.
  const output = await runBounded(context, "jj", [
    "--color",
    "never",
    "--ignore-working-copy",
    "--no-integrate-operation",
    "--no-pager",
    "--quiet",
    "--repository",
    root,
    "show",
    REVSET,
    "--no-patch",
    "--template",
    TEMPLATE,
  ]);
  if (output === undefined || context.input.signal?.aborted) return {};
  const change = parseJujutsuOutput(output);
  if (!change) return {};
  const modules: MutableModuleSnapshot = {};
  if (context.needs("jj_bookmark")) modules.jj_bookmark = { bookmarks: JSON.stringify(change.bookmarks) };
  if (context.needs("jj_change")) {
    modules.jj_change = {
      change_id: change.changeId,
      change_prefix_len: String(change.changePrefixLength),
      commit_id: change.commitId,
      commit_prefix_len: String(change.commitPrefixLength),
      ...(change.changeOffset === undefined ? {} : { change_offset: String(change.changeOffset) }),
    };
  }
  if (context.needs("jj_metrics"))
    modules.jj_metrics = { added: String(change.added), deleted: String(change.deleted) };
  if (context.needs("jj_status")) {
    modules.jj_status = {
      conflicted: String(change.conflicted),
      has_description: String(change.hasDescription),
      hidden: String(change.hidden),
      immutable: String(change.immutable),
      added: String(countStatus(change.statuses, "A")),
      copied: String(countStatus(change.statuses, "C")),
      deleted: String(countStatus(change.statuses, "D")),
      modified: String(countStatus(change.statuses, "M")),
      renamed: String(countStatus(change.statuses, "R")),
    };
  }
  return modules;
}

async function discoverRoot(context: CollectorContext): Promise<string | undefined> {
  let current = resolve(context.input.cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (context.input.signal?.aborted) return undefined;
    let entries: Awaited<ReturnType<CollectorContext["entries"]>>;
    try {
      entries = depth === 0 ? await context.entries() : await context.fs.readDirectory(current);
    } catch {
      return undefined;
    }
    if (context.input.signal?.aborted) return undefined;
    if (entries.some((entry) => entry.name === ".jj" && entry.isDirectory)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

interface JujutsuChange {
  changeId: string;
  changePrefixLength: number;
  commitId: string;
  commitPrefixLength: number;
  changeOffset?: number;
  bookmarks: JujutsuBookmark[];
  added: number;
  deleted: number;
  conflicted: boolean;
  hasDescription: boolean;
  hidden: boolean;
  immutable: boolean;
  statuses: string;
}

export function parseJujutsuOutput(output: string): JujutsuChange | undefined {
  if (Buffer.byteLength(output) > MAX_COMMAND_OUTPUT_BYTES) return undefined;
  try {
    const document = parse(output);
    const current = document.current;
    const parents = document.parents ?? {};
    if (!isRecord(current) || !isRecord(parents)) return undefined;
    // Unique ancestor tables prevent duplicate TOML keys when both selected
    // ancestors have bookmarks or conflicts.
    const entries = Object.entries(parents);
    if (entries.length > 2 || entries.some(([key, value]) => !/^[a-fA-F0-9]{1,128}$/u.test(key) || !isRecord(value)))
      return undefined;
    const selectedAncestors = entries.map(([, value]) => value as Record<string, unknown>);
    if (
      selectedAncestors.some((ancestor) => typeof ancestor.bookmark_source !== "boolean") ||
      selectedAncestors.filter((ancestor) => ancestor.bookmark_source === true).length > 1
    )
      return undefined;
    const ancestors = selectedAncestors;
    if (
      ancestors.some(
        (ancestor) =>
          !bookmarks(ancestor.bookmarks) ||
          (ancestor.conflicted !== undefined && typeof ancestor.conflicted !== "boolean"),
      )
    )
      return undefined;
    if (
      !asciiId(current.change_id, 32, 32) ||
      !asciiId(current.commit_id, 1, 128) ||
      !unsigned(current.change_id_prefix_len, 255) ||
      !unsigned(current.commit_id_prefix_len, 255) ||
      !unsigned(current.change_offset, 65_535) ||
      !unsigned(current.lines_added, 4_294_967_295) ||
      !unsigned(current.lines_removed, 4_294_967_295) ||
      ![current.has_description, current.hidden, current.immutable, current.divergent].every(
        (value) => typeof value === "boolean",
      ) ||
      typeof current.statuses !== "string" ||
      (current.conflicted !== undefined && typeof current.conflicted !== "boolean") ||
      !bookmarks(current.bookmarks)
    )
      return undefined;
    return {
      changeId: current.change_id,
      changePrefixLength: current.change_id_prefix_len,
      commitId: current.commit_id,
      commitPrefixLength: current.commit_id_prefix_len,
      ...(current.divergent ? { changeOffset: current.change_offset } : {}),
      bookmarks: [
        ...(current.bookmarks ?? []),
        ...selectedAncestors
          .filter((ancestor) => ancestor.bookmark_source === true)
          .flatMap((ancestor) => (ancestor.bookmarks ?? []) as JujutsuBookmark[]),
      ],
      added: current.lines_added,
      deleted: current.lines_removed,
      conflicted: current.conflicted === true || ancestors.some((ancestor) => ancestor.conflicted === true),
      hasDescription: current.has_description === true,
      hidden: current.hidden === true,
      immutable: current.immutable === true,
      statuses: current.statuses,
    };
  } catch {
    return undefined;
  }
}

function unsigned(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function asciiId(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9]+$/u.test(value)
  );
}

function bookmarks(value: unknown): value is JujutsuBookmark[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (item) =>
          isRecord(item) &&
          typeof item.name === "string" &&
          typeof item.remote === "string" &&
          typeof item.diverged === "boolean" &&
          Object.keys(item).every((key) => key === "name" || key === "remote" || key === "diverged"),
      ))
  );
}

function countStatus(statuses: string, status: string): number {
  let count = 0;
  for (const character of statuses) if (character === status) count += 1;
  return count;
}
