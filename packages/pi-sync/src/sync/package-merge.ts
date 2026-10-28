import { compare, valid } from "semver";
import { type JsonValue, jsonEqual } from "./json-document.js";

interface Entry {
  value: JsonValue;
  version?: string;
  options: JsonValue;
}

function entries(value: JsonValue | undefined): Map<string, Entry> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = new Map<string, Entry>();
  for (const item of value) {
    if (typeof item !== "string" && (!item || Array.isArray(item) || typeof item !== "object")) return undefined;
    const source = typeof item === "string" ? item : item.source;
    if (typeof source !== "string") return undefined;
    const spec = source.startsWith("npm:") ? source.slice(4).trim() : undefined;
    const match = spec?.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/u);
    const key = match ? `npm:${match[1]}` : source;
    if (result.has(key)) return undefined;
    const options =
      typeof item === "string" ? null : Object.fromEntries(Object.entries(item).filter(([key]) => key !== "source"));
    result.set(key, { value: item, options, version: match?.[2] });
  }
  return result;
}

/** Compare only explicit npm versions; do not resolve ranges, tags, Git refs or registry state. */
export function mergePackageVersions(
  base: JsonValue | undefined,
  local: JsonValue | undefined,
  remote: JsonValue | undefined,
): JsonValue[] | undefined {
  const ancestor = entries(base ?? []);
  const left = entries(local);
  const right = entries(remote);
  if (!ancestor || !left || !right) return undefined;
  // Raw Git refs and local path aliases do not prove distinct package identities.
  // Leave changes to those sources under the existing atomic field policy.
  const otherEntries = (items: Map<string, Entry>) =>
    [...items].filter(([key]) => !key.startsWith("npm:")).map(([, entry]) => entry.value);
  if (!jsonEqual(otherEntries(ancestor), otherEntries(left)) || !jsonEqual(otherEntries(ancestor), otherEntries(right)))
    return undefined;

  // Package order affects resource precedence. Merge the ordered identity list
  // atomically, then select versions without changing that order.
  const baseKeys = [...ancestor.keys()];
  const leftKeys = [...left.keys()];
  const rightKeys = [...right.keys()];
  const order = jsonEqual(leftKeys, rightKeys)
    ? leftKeys
    : jsonEqual(leftKeys, baseKeys)
      ? rightKeys
      : jsonEqual(rightKeys, baseKeys)
        ? leftKeys
        : undefined;
  if (!order) return undefined;
  const output: JsonValue[] = [];
  for (const key of new Set([...order, ...baseKeys])) {
    const a = ancestor.get(key);
    const l = left.get(key);
    const r = right.get(key);
    let chosen: Entry | undefined;
    if (
      l &&
      r &&
      key.startsWith("npm:") &&
      l.version &&
      r.version &&
      valid(l.version) &&
      valid(r.version) &&
      jsonEqual(l.options, r.options)
    ) {
      const precedence = compare(l.version, r.version);
      if (precedence !== 0) chosen = precedence > 0 ? l : r;
    }
    // Build metadata and equivalent version spelling do not establish a higher version.
    if (!chosen) {
      if (jsonEqual(l?.value, r?.value)) chosen = l;
      else if (jsonEqual(l?.value, a?.value)) chosen = r;
      else if (jsonEqual(r?.value, a?.value)) chosen = l;
      else return undefined;
    }
    if (chosen) output.push(chosen.value);
  }
  return output;
}
