import { createHash } from "node:crypto";
import { scanSnapshot } from "../snapshot/snapshot.js";
import type { Snapshot, SnapshotFile } from "../snapshot/snapshot-types.js";
import { AGENT_INPUT_BYTES, AGENT_MAX_UNITS, AGENT_OUTPUT_BYTES } from "./agent-policy.js";
import { snapshotFile } from "./content-conflicts.js";
import type { FileMergePlan } from "./file-merge-planner.js";
import { parseJsonObjectDocument, parseSettingsDocument } from "./json-document.js";
import { COUPLED_FIELDS, mergeSettingsJson } from "./settings-merge.js";
import { edits, type Hunk, isMergeTextPath, lines, text } from "./text-merge.js";

export interface AgentUnit {
  id: string;
  path: string;
  kind: "text" | "settings";
  base: string;
  local: string;
  remote: string;
}
interface CandidateFile {
  path: string;
  base: string;
  local: string;
  remote: string;
  parts?: (string | AgentUnit)[];
  fields?: { id: string; key: string }[];
}
export interface AgentEvidence {
  units: AgentUnit[];
  files: CandidateFile[];
  unsupported: string[];
}
export interface AgentCandidate {
  version: 1;
  results: (
    | { id: string; content: string }
    | { id: string; source: "local" | "remote" }
    | { id: string; refuse: true }
  )[];
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function overlaps(a: Hunk, b: Hunk) {
  return a.start === a.end || b.start === b.end
    ? a.start <= b.end && b.start <= a.end
    : a.start < b.end && b.start < a.end;
}

/** Only overlapping edit regions are model-writable; all other bytes are assembled by code. */
function textParts(filePath: string, baseText: string, localText: string, remoteText: string): (string | AgentUnit)[] {
  const base = lines(baseText);
  const changes = [
    ...edits(base, lines(localText)).map((hunk) => ({ ...hunk, side: "local" as const })),
    ...edits(base, lines(remoteText)).map((hunk) => ({ ...hunk, side: "remote" as const })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters: (typeof changes)[] = [];
  for (const change of changes) {
    const last = clusters.at(-1);
    if (last?.some((item) => overlaps(item, change))) last.push(change);
    else clusters.push([change]);
  }
  const result: (string | AgentUnit)[] = [];
  let cursor = 0;
  for (const cluster of clusters) {
    const start = Math.min(...cluster.map((item) => item.start));
    const end = Math.max(...cluster.map((item) => item.end));
    result.push(base.slice(cursor, start).join(""));
    const image = (side: "local" | "remote") => {
      let position = start;
      const output: string[] = [];
      for (const hunk of cluster.filter((item) => item.side === side)) {
        output.push(...base.slice(position, hunk.start), ...hunk.lines);
        position = hunk.end;
      }
      return [...output, ...base.slice(position, end)].join("");
    };
    const local = image("local");
    const remote = image("remote");
    const original = base.slice(start, end).join("");
    if (local === remote || local === original || remote === original) result.push(local === original ? remote : local);
    else result.push({ id: "", path: filePath, kind: "text", base: original, local, remote });
    cursor = end;
  }
  result.push(base.slice(cursor).join(""));
  return result;
}

export function buildAgentEvidence(
  plan: FileMergePlan,
  local: Snapshot,
  remote: Snapshot,
  ancestors: SnapshotFile[],
): AgentEvidence {
  const evidence: AgentEvidence = { units: [], files: [], unsupported: [] };
  if (plan.kind !== "planned") return evidence;
  if (plan.conflicts.length > AGENT_MAX_UNITS)
    throw new Error("Agent mode paused: too many conflict paths for bounded analysis.");
  for (const conflict of plan.conflicts) {
    try {
      if (conflict.reason !== "both-changed") throw new Error("unsupported conflict");
      const versions = [ancestors, local.files, remote.files].map((files) => {
        const file = files.find((item) => item.path === conflict.path);
        if (!file) throw new Error("missing ancestor/version");
        const bytes = Buffer.from(file.contentBase64, "base64");
        if (bytes.length > 8192) throw new Error("file bound");
        return text(bytes);
      }) as [string, string, string];
      const [base, left, right] = versions;
      const file: CandidateFile = { path: conflict.path, base, local: left, remote: right };
      let units: AgentUnit[];
      if (conflict.path === "settings.json") {
        const documents = versions.map((value) => parseSettingsDocument(Buffer.from(value)));
        const merge = mergeSettingsJson(
          ...(versions.map((value) => Buffer.from(value)) as [Buffer, Buffer, Buffer]),
          undefined,
          true,
        );
        if (merge.kind === "review" && merge.reason !== "field-conflict") throw new Error("unsupported settings");
        const fields = new Set(merge.kind === "review" ? merge.fields : []);
        const groups = COUPLED_FIELDS.map((group) => [...group] as string[]);
        const coupled = new Set(groups.flat());
        groups.push(...[...fields].filter((key) => !coupled.has(key)).map((key) => [key]));
        file.fields = [];
        units = groups
          .filter((group) => group.some((key) => fields.has(key)))
          .map((group) => {
            const values = documents.map((document) =>
              JSON.stringify(
                Object.fromEntries(
                  group.flatMap((key) => {
                    const node = document.root.members.get(key)?.node;
                    return node ? [[key, node.value]] : [];
                  }),
                ),
              ),
            );
            const unit: AgentUnit = {
              id: "",
              path: file.path,
              kind: "settings",
              base: values[0] ?? "{}",
              local: values[1] ?? "{}",
              remote: values[2] ?? "{}",
            };
            file.fields?.push({ id: String(evidence.units.length + file.fields.length), key: group[0] ?? "" });
            return unit;
          });
      } else {
        if (!isMergeTextPath(conflict.path)) throw new Error("unsupported path");
        file.parts = textParts(file.path, base, left, right);
        units = file.parts.filter((part): part is AgentUnit => typeof part !== "string");
      }
      for (const unit of units) {
        unit.id = String(evidence.units.length);
        evidence.units.push(unit);
      }
      evidence.files.push(file);
    } catch {
      evidence.unsupported.push(conflict.path);
    }
  }
  if (evidence.units.length > AGENT_MAX_UNITS || Buffer.byteLength(JSON.stringify(evidence.units)) > AGENT_INPUT_BYTES)
    throw new Error("Agent mode paused: conflict evidence exceeds its input bound.");
  // Scan only the actual disclosure image; skipSecretScan never authorizes model disclosure.
  if (
    scanSnapshot({
      ...local,
      files: evidence.units.flatMap((unit) =>
        [unit.path, unit.base, unit.local, unit.remote].map((value) => snapshotFile(unit.path, Buffer.from(value))),
      ),
    }).length
  )
    throw new Error("Agent mode paused: possible secrets in model evidence; nothing was disclosed.");
  return evidence;
}

export function parseAgentCandidate(raw: string, evidence: AgentEvidence): AgentCandidate {
  if (Buffer.byteLength(raw) > AGENT_OUTPUT_BYTES) throw new Error("Agent output exceeds its bound.");
  const parsed = parseJsonObjectDocument(Buffer.from(raw)).root.value as Record<string, unknown>;
  if (
    Object.keys(parsed).sort().join(",") !== "results,version" ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.results) ||
    parsed.results.length !== evidence.units.length
  )
    throw new Error("Invalid agent candidate contract.");
  const seen = new Set<string>();
  for (const result of parsed.results) {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid agent result.");
    const row = result as Record<string, unknown>;
    const unit = evidence.units.find((unit) => unit.id === row.id);
    if (!unit || seen.has(unit.id)) throw new Error("Unowned or duplicate agent unit.");
    seen.add(unit.id);
    const keys = Object.keys(row).sort().join(",");
    if (keys === "id,refuse" && row.refuse === true) continue;
    if (unit.kind === "settings" && keys === "id,source" && (row.source === "local" || row.source === "remote"))
      continue;
    if (unit.kind === "text" && keys === "content,id" && typeof row.content === "string" && row.content.length > 0) {
      text(Buffer.from(row.content));
      if (/^(?:<{7}|={7}|>{7}|\|{7})/mu.test(row.content)) throw new Error("Unresolved conflict markers.");
      continue;
    }
    throw new Error("Unsupported agent action.");
  }
  return parsed as unknown as AgentCandidate;
}

export function applyAgentCandidate(
  plan: FileMergePlan,
  evidence: AgentEvidence,
  candidate: AgentCandidate,
): FileMergePlan {
  // Persisted candidates cross a trust boundary too.
  parseAgentCandidate(JSON.stringify(candidate), evidence);
  if (plan.kind !== "planned") throw new Error("Unverified merge plan.");
  const results = new Map(candidate.results.map((row) => [row.id, row]));
  const replacements = new Map<string, SnapshotFile>();
  for (const file of evidence.files) {
    const units = evidence.units.filter((unit) => unit.path === file.path);
    if (units.some((unit) => results.get(unit.id) && "refuse" in (results.get(unit.id) ?? {}))) continue;
    let bytes: Buffer;
    if (file.parts) {
      bytes = Buffer.from(
        file.parts
          .map((part) => (typeof part === "string" ? part : (results.get(part.id) as { content: string }).content))
          .join(""),
      );
    } else {
      const selections = new Map(
        (file.fields ?? []).map(({ id, key }) => [key, (results.get(id) as { source: "local" | "remote" }).source]),
      );
      const merged = mergeSettingsJson(
        Buffer.from(file.base),
        Buffer.from(file.local),
        Buffer.from(file.remote),
        selections,
        true,
      );
      if (merged.kind !== "merged") throw new Error("Agent settings units remain unresolved.");
      // The existing renderer/parser retains atomic values, unknown members and exact numeric policy.
      parseSettingsDocument(merged.content);
      for (const { key } of file.fields ?? []) {
        if (!selections.has(key)) throw new Error("Missing atomic settings selection.");
      }
      bytes = merged.content;
    }
    if (bytes.length > AGENT_OUTPUT_BYTES) throw new Error("Agent file exceeds output bound.");
    replacements.set(file.path, snapshotFile(file.path, bytes));
  }
  const decisions = plan.decisions.map((decision) => {
    const file = replacements.get(decision.path);
    return file && decision.kind === "conflict"
      ? { kind: "accepted" as const, path: file.path, source: "merged" as const, file }
      : decision;
  });
  return { kind: "planned", decisions, conflicts: decisions.filter((item) => item.kind === "conflict") };
}
