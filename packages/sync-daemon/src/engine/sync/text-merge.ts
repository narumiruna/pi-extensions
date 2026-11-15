import path from "node:path";
export const TEXT_LIMIT = 1024 * 1024;
export const TEXT_MERGE_WORK_LIMIT = 8_000_000;
export interface TextMergeBudget {
  remaining: number;
}
export interface TextMergeOptions {
  budget?: TextMergeBudget;
  signal?: AbortSignal;
}
function charge(budget: TextMergeBudget, work: number) {
  if (work > budget.remaining) throw new Error("Text merge operation complexity bound exceeded.");
  budget.remaining -= work;
}
export function isMergeTextPath(filePath: string) {
  return (
    filePath === "AGENTS.md" ||
    (/\.(?:md|txt)$/u.test(filePath) &&
      ["prompts", "skills"].includes(filePath.split("/")[0] ?? "") &&
      path.posix.basename(filePath) !== "keybindings.json")
  );
}
export function text(bytes: Buffer) {
  if (bytes.length > TEXT_LIMIT) throw new Error("Text merge bound exceeded.");
  const decoded = bytes.toString("utf8");
  if (
    !Buffer.from(decoded).equals(bytes) ||
    bytes.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)
  )
    throw new Error("Unsupported text encoding.");
  return decoded;
}
export type Hunk = { start: number; end: number; lines: string[] };
export function lines(value: string) {
  return value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}
export function edits(base: string[], next: string[], signal?: AbortSignal): Hunk[] {
  const width = next.length + 1;
  if ((base.length + 1) * width > 4_000_000) throw new Error("Text merge complexity bound exceeded.");
  // Intern once so each charged DP cell compares fixed-size IDs, not long line strings.
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const baseIds = base.map(intern);
  const nextIds = next.map(intern);
  const grid = new Uint32Array((base.length + 1) * width);
  for (let i = base.length - 1; i >= 0; i--) {
    signal?.throwIfAborted();
    for (let j = next.length - 1; j >= 0; j--)
      grid[i * width + j] =
        baseIds[i] === nextIds[j]
          ? 1 + (grid[(i + 1) * width + j + 1] ?? 0)
          : Math.max(grid[(i + 1) * width + j] ?? 0, grid[i * width + j + 1] ?? 0);
  }
  const result: Hunk[] = [];
  let i = 0;
  let j = 0;
  let active: Hunk | undefined;
  while (i < base.length || j < next.length) {
    if (i < base.length && j < next.length && baseIds[i] === nextIds[j]) {
      if (active) {
        result.push(active);
        active = undefined;
      }
      i++;
      j++;
      continue;
    }
    active ??= { start: i, end: i, lines: [] };
    if (j < next.length && (i === base.length || (grid[i * width + j + 1] ?? 0) >= (grid[(i + 1) * width + j] ?? 0)))
      active.lines.push(next[j++] ?? "");
    else active.end = ++i;
  }
  if (active) result.push(active);
  return result;
}
export function mergeText(
  baseBytes: Buffer,
  localBytes: Buffer,
  remoteBytes: Buffer,
  options: TextMergeOptions = {},
): Buffer | undefined {
  const budget = options.budget ?? { remaining: TEXT_MERGE_WORK_LIMIT };
  try {
    options.signal?.throwIfAborted();
    const base = lines(text(baseBytes));
    const ours = lines(text(localBytes));
    const theirs = lines(text(remoteBytes));
    const cells = [ours, theirs].map((next) => (base.length + 1) * (next.length + 1));
    if (cells.some((count) => count > 4_000_000)) return;
    charge(budget, (cells[0] ?? 0) + (cells[1] ?? 0));
    const local = edits(base, ours, options.signal);
    const remote = edits(base, theirs, options.signal);
    const combined = [...local];
    for (const right of remote) {
      let same = false;
      for (const left of local) {
        options.signal?.throwIfAborted();
        charge(budget, 1);
        if (left.start === right.start && left.end === right.end && left.lines.join("") === right.lines.join("")) {
          same = true;
          continue;
        }
        const overlap =
          left.start === left.end || right.start === right.end
            ? left.start <= right.end && right.start <= left.end
            : left.start < right.end && right.start < left.end;
        if (overlap) return;
      }
      if (!same) combined.push(right);
    }
    combined.sort((left, right) => left.start - right.start || left.end - right.end);
    let cursor = 0;
    const output: string[] = [];
    for (const edit of combined) {
      output.push(...base.slice(cursor, edit.start), ...edit.lines);
      cursor = edit.end;
    }
    output.push(...base.slice(cursor));
    const result = Buffer.from(output.join(""));
    text(result);
    return result;
  } catch {
    options.signal?.throwIfAborted();
    return;
  }
}
