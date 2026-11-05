import { createHash } from "node:crypto";
import { regenerateSnapshotIdentity } from "../snapshot/snapshot.js";
import type { Snapshot, SnapshotFile } from "../snapshot/snapshot-types.js";
import {
  type JsonDocument,
  type JsonNode,
  jsonEqual,
  parseSettingsDocument,
  renderSettingsMembers,
} from "./json-document.js";
import { normalizeLocalFields } from "./local-field-policy.js";

export { normalizeLocalFields } from "./local-field-policy.js";

/** Shared transport contract: older snapshots cannot carry portable policy metadata. */
export function validateSnapshotFieldPolicy(snapshot: Pick<Snapshot, "version" | "localFields">) {
  if (snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3)
    throw new Error("Unsupported snapshot format.");
  if (snapshot.version === 1 && snapshot.localFields !== undefined)
    throw new Error("Portable field policy requires snapshot version 2.");
  if (snapshot.version === 2 || snapshot.version === 3) {
    if (snapshot.version === 2 && snapshot.localFields === undefined)
      throw new Error("Snapshot version 2 requires explicit localFields rules.");
    normalizeLocalFields(snapshot.localFields);
  }
}
/** Portable transport images must not carry values declared machine-local. Physical journal images are different. */
export function validatePortableSnapshot(snapshot: Snapshot) {
  validateSnapshotFieldPolicy(snapshot);
  if ((snapshot.version !== 2 && snapshot.version !== 3) || !snapshot.localFields?.length) return;
  try {
    for (const entry of snapshot.files) {
      if (typeof entry?.path !== "string" || entry.path.toLowerCase() !== "settings.json") continue;
      const document = parseSettingsDocument(Buffer.from(entry.contentBase64, "base64"));
      if (snapshot.localFields.some((field) => document.root.members.has(field))) throw new Error("Excluded field.");
    }
  } catch {
    throw new Error("Portable snapshot settings.json retains excluded fields or has an unsupported document.");
  }
}
export function sameLocalFields(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(normalizeLocalFields(left)) === JSON.stringify(normalizeLocalFields(right));
}
function file(content: Buffer): SnapshotFile {
  return {
    path: "settings.json",
    contentBase64: content.toString("base64"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
export function portableSnapshot(snapshot: Snapshot, fields: string[] | undefined): Snapshot {
  if (fields === undefined) return snapshot;
  const excluded = new Set(normalizeLocalFields(fields));
  const files = snapshot.files.map((entry) => {
    if (entry.path !== "settings.json" || excluded.size === 0) return entry;
    const document = parseSettingsDocument(Buffer.from(entry.contentBase64, "base64"));
    const object = Object.create(null);
    for (const key of [...document.root.members.keys()].sort())
      if (!excluded.has(key)) object[key] = document.root.members.get(key)?.node.value;
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, child]) => [key, canonical(child)]),
            )
          : value;
    return file(Buffer.from(`${JSON.stringify(canonical(object))}\n`));
  });
  return regenerateSnapshotIdentity({ ...snapshot, version: 2, localFields: [...excluded], files });
}
export function overlayLocalFields(portable: Snapshot, local: Snapshot, fields: string[] | undefined): Snapshot {
  if (!fields?.length) return portable;
  const target = portable.files.find((entry) => entry.path === "settings.json");
  const current = local.files.find((entry) => entry.path === "settings.json");
  if (!target && !current) return portable;
  const original = current
    ? parseSettingsDocument(Buffer.from(current.contentBase64, "base64"))
    : parseSettingsDocument(Buffer.from("{}"));
  if (!target) {
    if (fields.some((field) => original.root.members.has(field)))
      throw new Error("Portable settings deletion requires manual review; local-only fields were preserved.");
    return portable;
  }
  const incoming = parseSettingsDocument(Buffer.from(target.contentBase64, "base64"));
  const selected = new Map<string, { document: JsonDocument; node: JsonNode }>();
  const excluded = new Set(fields);
  for (const [key, member] of incoming.root.members) {
    if (excluded.has(key)) continue;
    const existing = original.root.members.get(key);
    selected.set(
      key,
      existing && jsonEqual(existing.node.value, member.node.value)
        ? { document: original, node: existing.node }
        : { document: incoming, node: member.node },
    );
  }
  for (const [key, member] of original.root.members)
    if (excluded.has(key)) selected.set(key, { document: original, node: member.node });
  const content = renderSettingsMembers(original, selected);
  return regenerateSnapshotIdentity({
    ...portable,
    files: portable.files.map((entry) => (entry.path === "settings.json" ? file(content) : entry)),
  });
}
