/** Require a fixture value without erasing its runtime presence check. */
export function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing required durable test value");
  return value;
}
