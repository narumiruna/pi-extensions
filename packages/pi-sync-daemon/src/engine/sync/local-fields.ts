import { createHash } from "node:crypto";
import { regenerateSnapshotIdentity } from "../snapshot/snapshot.js";
import { assertAgentDirectorySnapshotBound } from "../snapshot/snapshot-bounds.js";
import { assertSnapshotFilePayload } from "../snapshot/snapshot-payload.js";
import {
  IGNORE_SNAPSHOT_VERSION,
  type IgnoreSnapshotSelection,
  isSupportedSnapshotVersion,
  type Snapshot,
  type SnapshotFile,
  type SnapshotObservation,
} from "../snapshot/snapshot-types.js";
import {
  type JsonDocument,
  type JsonNode,
  jsonEqual,
  parseSettingsDocument,
  renderSettingsMembers,
} from "./json-document.js";
import { normalizeLocalFields } from "./local-field-policy.js";
import { compileSyncPolicyExclude, configuredSnapshotPathMatcher, validateSnapshotSelection } from "./sync-policy.js";

export { normalizeLocalFields } from "./local-field-policy.js";

/** Shared transport contract: older snapshots cannot carry portable policy metadata. */
export function validateSnapshotFieldPolicy(snapshot: Pick<Snapshot, "version" | "localFields">) {
  if (!isSupportedSnapshotVersion(snapshot.version)) throw new Error("Unsupported snapshot format.");
  if (snapshot.version === 1 && snapshot.localFields !== undefined)
    throw new Error("Portable field policy requires snapshot version 2.");
  if (snapshot.version !== 1) {
    if (snapshot.version === 2 && snapshot.localFields === undefined)
      throw new Error("Snapshot version 2 requires explicit localFields rules.");
    normalizeLocalFields(snapshot.localFields);
  }
}
export function validateIgnoreSnapshotSessionFlag(selection: IgnoreSnapshotSelection, syncSessions: unknown) {
  if (
    (syncSessions !== undefined && typeof syncSessions !== "boolean") ||
    (syncSessions === true && !selection.sessions)
  )
    throw new Error("Invalid ignore snapshot session metadata.");
}

export function validateIgnoreSnapshotIdentity({
  id,
  createdAt,
  machine,
  profile,
}: Pick<Snapshot, "id" | "createdAt" | "machine" | "profile">) {
  if (
    typeof id !== "string" ||
    id.length > 512 ||
    id === "." ||
    id === ".." ||
    !/^[A-Za-z0-9._-]+(?![\s\S])/u.test(id) ||
    typeof createdAt !== "string" ||
    createdAt.length > 64 ||
    /[\p{Cc}\p{Cs}]/u.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof machine !== "string" ||
    machine.length > 256 ||
    /[\p{Cc}\p{Cs}]/u.test(machine) ||
    typeof profile !== "string" ||
    !profile ||
    profile.length > 256 ||
    /[\p{Cc}\p{Cs}]/u.test(profile)
  )
    throw new Error("Invalid ignore snapshot identity.");
}

function validateIgnoreSnapshotEnvelope(snapshot: Snapshot, selection: IgnoreSnapshotSelection) {
  validateIgnoreSnapshotIdentity(snapshot);
  validateIgnoreSnapshotSessionFlag(selection, snapshot.syncSessions);
  if (
    !Array.isArray(snapshot.files) ||
    Object.keys(snapshot).some(
      (key) =>
        ![
          "version",
          "id",
          "createdAt",
          "machine",
          "profile",
          "syncSessions",
          "selection",
          "localFields",
          "files",
        ].includes(key),
    )
  )
    throw new Error("Invalid ignore snapshot payload.");
}

function validateIgnoreSnapshotFiles(files: SnapshotFile[]) {
  for (const file of files) {
    if (
      Object.keys(file).length !== 3 ||
      !Object.hasOwn(file, "path") ||
      !Object.hasOwn(file, "contentBase64") ||
      !Object.hasOwn(file, "sha256") ||
      typeof file.sha256 !== "string" ||
      file.sha256.length !== 64
    )
      throw new Error("Invalid ignore snapshot file.");
    assertSnapshotFilePayload(file, "Ignore snapshot file checksum or encoding mismatch.");
  }
}

/** Portable transport images must not carry values declared machine-local. Physical journal images are different. */
export function validatePortableSnapshot(snapshot: Snapshot) {
  validateSnapshotFieldPolicy(snapshot);
  validateSnapshotSelection(snapshot);
  const selection = snapshot.selection;
  if (selection?.version === 4) validateIgnoreSnapshotEnvelope(snapshot, selection);
  if (selection?.scope) {
    const selected = configuredSnapshotPathMatcher(selection);
    if (snapshot.files.some((file) => typeof file?.path !== "string" || !selected(file.path)))
      throw new Error("Portable snapshot retains excluded or unsafe agent-directory paths.");
    assertAgentDirectorySnapshotBound(snapshot.files);
    if (snapshot.version === IGNORE_SNAPSHOT_VERSION) validateIgnoreSnapshotFiles(snapshot.files);
  } else {
    const excludedPath = compileSyncPolicyExclude(selection ?? {});
    if (snapshot.files.some((file) => excludedPath(file.path)))
      throw new Error("Portable snapshot retains excluded paths.");
  }
  if (snapshot.version === 1 || !snapshot.localFields?.length) return;
  requireCanonicalFieldSettingsPath(snapshot);
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
function requireCanonicalFieldSettingsPath(snapshot: Snapshot) {
  assertCanonicalFieldSettingsPath(snapshot.files, snapshot.selection?.scope);
}

function assertCanonicalFieldSettingsPath(files: SnapshotObservation["files"], scope: SnapshotObservation["scope"]) {
  if (scope && files.some(({ path }) => path !== "settings.json" && path.toLowerCase() === "settings.json"))
    throw new Error(
      "Directory scope requires the exact settings.json spelling when machine-local fields are configured.",
    );
}

function portableSettingsContent(content: Buffer, excluded: ReadonlySet<string>) {
  const document = parseSettingsDocument(content);
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
  return Buffer.from(`${JSON.stringify(canonical(object))}\n`);
}

export function portableObservation(observation: SnapshotObservation, fields: string[] | undefined) {
  if (fields === undefined) return observation;
  const excluded = new Set(normalizeLocalFields(fields));
  if (excluded.size === 0) return observation;
  assertCanonicalFieldSettingsPath(observation.files, observation.scope);
  return {
    files: observation.files.map((entry) => {
      if (entry.path !== "settings.json") return entry;
      if (entry.settingsContent === undefined) throw new Error("Missing settings bytes for portable observation.");
      return {
        path: entry.path,
        sha256: createHash("sha256").update(portableSettingsContent(entry.settingsContent, excluded)).digest("hex"),
      };
    }),
  };
}

export function portableSnapshot(snapshot: Snapshot, fields: string[] | undefined): Snapshot {
  if (fields === undefined) return snapshot;
  const excluded = new Set(normalizeLocalFields(fields));
  if (excluded.size > 0) requireCanonicalFieldSettingsPath(snapshot);
  const files = snapshot.files.map((entry) => {
    if (entry.path !== "settings.json" || excluded.size === 0) return entry;
    return file(portableSettingsContent(Buffer.from(entry.contentBase64, "base64"), excluded));
  });
  return regenerateSnapshotIdentity({
    ...snapshot,
    version: snapshot.version >= 4 ? snapshot.version : 2,
    localFields: [...excluded],
    files,
  });
}
export function overlayLocalFields(portable: Snapshot, local: Snapshot, fields: string[] | undefined): Snapshot {
  if (!fields?.length) return portable;
  requireCanonicalFieldSettingsPath(portable);
  requireCanonicalFieldSettingsPath(local);
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
