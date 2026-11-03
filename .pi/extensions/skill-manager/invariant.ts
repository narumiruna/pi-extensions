/** Require confirmed operation data instead of bypassing TypeScript null checks. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required skill operation data is missing");
  return value;
}
