/** Initial rules select whole root fields of the global settings.json only. */
export function normalizeLocalFields(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some(
      (field) =>
        typeof field !== "string" ||
        !field ||
        field.length > 128 ||
        /[\p{Cc}\p{Cf}\p{Cs}]/u.test(field) ||
        ["__proto__", "constructor", "prototype"].includes(field),
    )
  )
    throw new Error("localFields must be at most 128 safe settings.json root field names.");
  if (new Set(value).size !== value.length) throw new Error("Duplicate localFields rule.");
  for (const [first, second] of [
    ["defaultProvider", "defaultModel"],
    ["skills", "enableSkillCommands"],
    ["queueMode", "steeringMode"],
    ["websockets", "transport"],
    ["enableAnalytics", "trackingId"],
  ]) {
    if (value.includes(first) !== value.includes(second))
      throw new Error("Coupled settings fields must be excluded together.");
  }
  return [...value].sort();
}
