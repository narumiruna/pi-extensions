import {
  type JsonDocument,
  type JsonNode,
  jsonEqual,
  parseSettingsDocument,
  renderSettingsMembers,
} from "./json-document.js";

import { mergePackageVersions } from "./package-merge.js";

export type SettingsMergeResult =
  | { kind: "merged"; content: Buffer }
  | { kind: "review"; reason: "unsupported-format" | "field-conflict"; fields: string[] };

export const COUPLED_FIELDS = [
  ["defaultProvider", "defaultModel"],
  ["queueMode", "steeringMode"],
  ["websockets", "transport"],
  ["skills", "enableSkillCommands"],
  ["enableAnalytics", "trackingId"],
] as const;

function selectPackages(base: JsonDocument, left: JsonDocument, right: JsonDocument) {
  const packages = mergePackageVersions(
    base.root.members.get("packages")?.node.value,
    left.root.members.get("packages")?.node.value,
    right.root.members.get("packages")?.node.value,
  );
  if (!packages) return undefined;
  const document =
    [left, right].find((source) => jsonEqual(source.root.members.get("packages")?.node.value, packages)) ??
    parseSettingsDocument(Buffer.from(JSON.stringify({ packages })));
  const node = document.root.members.get("packages")?.node;
  return node ? { document, node } : undefined;
}

/** Accepted files need only a package override, not another full-document field merge. */
export function mergeAcceptedSettingsPackages(
  ancestor: Buffer,
  local: Buffer,
  remote: Buffer,
  accepted: Buffer,
): Buffer | undefined {
  try {
    const base = parseSettingsDocument(ancestor);
    const left = parseSettingsDocument(local);
    const right = parseSettingsDocument(remote);
    const document = parseSettingsDocument(accepted);
    const packages = selectPackages(base, left, right);
    if (!packages || jsonEqual(packages.node.value, document.root.members.get("packages")?.node.value))
      return undefined;
    const selected = new Map([...document.root.members].map(([key, member]) => [key, { document, node: member.node }]));
    selected.set("packages", packages);
    return renderSettingsMembers(document, selected);
  } catch {
    // Unsupported settings must not replace an accepted file with a reconstructed document.
    return undefined;
  }
}

/** Only global settings.json; objects/arrays are atomic units until their invariants are proven. */
export function mergeSettingsJson(
  ancestor: Buffer,
  local: Buffer,
  remote: Buffer,
  selections: ReadonlyMap<string, "local" | "remote"> = new Map(),
  preferHigherPackageVersions = false,
): SettingsMergeResult {
  let documents: JsonDocument[];
  try {
    documents = [ancestor, local, remote].map(parseSettingsDocument);
  } catch {
    return { kind: "review", reason: "unsupported-format", fields: [] };
  }
  const [base, left, right] = documents as [JsonDocument, JsonDocument, JsonDocument];
  const selected = new Map<string, { document: JsonDocument; node: JsonNode }>();
  const fields = new Set(documents.flatMap((document) => [...document.root.members.keys()]));
  const units: string[][] = COUPLED_FIELDS.map((group) => [...group]);
  const coupled = new Set(units.flat());
  units.push(...[...fields].filter((field) => !coupled.has(field)).map((field) => [field]));
  const conflicts: string[] = [];
  for (const unit of units) {
    if (preferHigherPackageVersions && unit[0] === "packages") {
      const packages = selectPackages(base, left, right);
      if (packages) {
        selected.set("packages", packages);
        continue;
      }
    }
    const equal = (first: JsonDocument, second: JsonDocument) =>
      unit.every((field) =>
        jsonEqual(first.root.members.get(field)?.node.value, second.root.members.get(field)?.node.value),
      );
    const choice = selections.get(unit[0] ?? "");
    const source = equal(left, right)
      ? left
      : equal(left, base)
        ? right
        : equal(right, base)
          ? left
          : choice === "local"
            ? left
            : choice === "remote"
              ? right
              : undefined;
    if (!source) {
      conflicts.push(...unit.filter((field) => fields.has(field)));
      continue;
    }
    for (const field of unit) {
      const member = source.root.members.get(field);
      if (member) selected.set(field, { document: source, node: member.node });
    }
  }
  if (conflicts.length) return { kind: "review", reason: "field-conflict", fields: conflicts };
  try {
    return { kind: "merged", content: renderSettingsMembers(left, selected) };
  } catch {
    return { kind: "review", reason: "unsupported-format", fields: [] };
  }
}
