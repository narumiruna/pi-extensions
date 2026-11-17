import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonNode {
  value: JsonValue;
  start: number;
  end: number;
  members?: Map<string, { start: number; end: number; node: JsonNode }>;
}
export interface JsonDocument {
  text: string;
  root: JsonNode & { members: NonNullable<JsonNode["members"]> };
}

/** Strict UTF-8 JSON, with Pi's supported BOM; duplicates and prototype hazards require review. */
export function parseSettingsDocument(bytes: Buffer): JsonDocument {
  try {
    return parseDocument(bytes);
  } catch {
    throw new Error(
      "Unsupported settings JSON syntax, encoding, migration or structure; review without modifying the original file.",
    );
  }
}
export function parseJsonObjectDocument(bytes: Buffer): JsonDocument {
  try {
    return parseDocument(bytes, false);
  } catch {
    throw new Error("Unsupported JSON object syntax, encoding or structure; preserve original bytes.");
  }
}
function parseDocument(bytes: Buffer, checkSettingsMigration = true): JsonDocument {
  if (bytes.length > 1024 * 1024) throw new Error("Settings merge input exceeds 1 MiB.");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Settings merge requires valid UTF-8.");
  let position = text.startsWith("\uFEFF") ? 1 : 0;
  let nodes = 0;
  JSON.parse(text.slice(position));
  const whitespace = () => {
    while (/^[\t\n\r ]$/.test(text[position] ?? "")) position++;
  };
  const stringEnd = () => {
    position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === "\\") position++;
      else if (character === '"') return;
    }
    throw new Error("Invalid JSON string.");
  };
  const parse = (depth: number): JsonNode => {
    if (depth > 64 || ++nodes > 16_384) throw new Error("Settings merge structure exceeds its bound.");
    whitespace();
    const start = position;
    let members: JsonNode["members"];
    if (text[position] === "{") {
      position++;
      members = new Map();
      whitespace();
      while (text[position] !== "}") {
        const memberStart = position;
        stringEnd();
        const key = JSON.parse(text.slice(memberStart, position)) as string;
        if (members.has(key) || ["__proto__", "constructor", "prototype"].includes(key))
          throw new Error("Duplicate or prototype-sensitive JSON key; review required.");
        whitespace();
        position++; // Colon: whole-document JSON.parse already validated grammar.
        const node = parse(depth + 1);
        members.set(key, { start: memberStart, end: position, node });
        whitespace();
        if (text[position] !== ",") break;
        position++;
        whitespace();
      }
      position++;
    } else if (text[position] === "[") {
      position++;
      whitespace();
      while (text[position] !== "]") {
        parse(depth + 1);
        whitespace();
        if (text[position] !== ",") break;
        position++;
      }
      position++;
    } else if (text[position] === '"') stringEnd();
    else while (position < text.length && !/[\s,\]}]/u.test(text.charAt(position))) position++;
    const source = text.slice(start, position);
    const value = JSON.parse(source) as JsonValue;
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
        decimalIdentity(source) !== decimalIdentity(String(value)))
    )
      throw new Error("Numeric settings value cannot round-trip without loss; review required.");
    return { start, end: position, value, ...(members ? { members } : {}) };
  };
  const root = parse(0);
  if (!root.members) throw new Error("Settings merge requires a JSON object.");
  // Use the public API rather than reproducing private migration branches. Migrating input
  // is withheld, including legacy queue/transport/skills and retry-delay formats.
  if (checkSettingsMigration) {
    const migrated = SettingsManager.inMemory(
      root.value as Parameters<typeof SettingsManager.inMemory>[0],
    ).getGlobalSettings();
    if (!jsonEqual(root.value, migrated as unknown as JsonValue))
      throw new Error("Legacy settings migration requires review before content merge.");
  }
  return { text, root: { ...root, members: root.members } };
}

/** Compare decimal literals without expanding exponents or rounding through Number. */
function decimalIdentity(source: string) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
  if (!match) throw new Error("Invalid numeric token.");
  const fraction = match[3] ?? "";
  const digits = `${match[2]}${fraction}`.replace(/^0+/u, "");
  if (!digits) return "0";
  const coefficient = digits.replace(/0+$/u, "");
  const exponent = Number(match[4] ?? 0) - fraction.length + digits.length - coefficient.length;
  if (!Number.isSafeInteger(exponent)) throw new Error("Unsupported numeric exponent.");
  return `${match[1]}${coefficient}e${exponent}`;
}

export function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  if (typeof left !== "object" || typeof right !== "object") return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}

/** Preserve the local prefix/suffix, order, unchanged member bytes, and every chosen value's spelling. */
export function renderSettingsMembers(
  local: JsonDocument,
  selected: Map<string, { document: JsonDocument; node: JsonNode }>,
): Buffer {
  const members = local.root.members;
  const keys = [...members.keys(), ...[...selected.keys()].filter((key) => !members.has(key))].filter((key) =>
    selected.has(key),
  );
  const opening = local.text.slice(local.root.start, members.values().next().value?.start ?? local.root.end - 1);
  const last = [...members.values()].at(-1);
  const closing = last ? local.text.slice(last.end, local.root.end) : "}";
  const separator = /\r\n/.test(local.text) ? "\r\n" : "\n";
  const indent = local.text.match(/\n([\t ]+)"/)?.[1] ?? "  ";
  const multiline = opening.includes("\n") || closing.includes("\n");
  const originalSeparators = new Map<string, string>();
  let previous: { end: number } | undefined;
  for (const [key, member] of members) {
    if (previous) originalSeparators.set(key, local.text.slice(previous.end, member.start));
    previous = member;
  }
  const newSeparator = multiline ? `,${separator}${indent}` : ", ";
  const rendered = keys
    .map((key, index) => {
      const choice = selected.get(key);
      if (!choice) throw new Error("Missing selected settings member.");
      const existing = members.get(key);
      const prefix = existing ? local.text.slice(existing.start, existing.node.start) : `${JSON.stringify(key)}: `;
      const gap = index ? (originalSeparators.get(key) ?? newSeparator) : "";
      return gap + prefix + choice.document.text.slice(choice.node.start, choice.node.end);
    })
    .join("");
  const result = Buffer.from(
    local.text.slice(0, local.root.start) + opening + rendered + closing + local.text.slice(local.root.end),
  );
  parseSettingsDocument(result);
  return result;
}
