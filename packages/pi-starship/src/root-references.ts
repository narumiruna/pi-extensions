const EXTENSION_STATUS_PREFIX = "extension_status.";

/** The suffix is an exact public status key, not a path or namespace selector. */
export function extensionStatusKey(reference: string): string | undefined {
  if (!reference.startsWith(EXTENSION_STATUS_PREFIX)) return undefined;
  const key = reference.slice(EXTENSION_STATUS_PREFIX.length);
  return key.length > 0 ? key : undefined;
}

export function referencesModule(references: ReadonlySet<string>, module: string): boolean {
  return (
    references.has(module) ||
    (module === "extension_status" && [...references].some((reference) => extensionStatusKey(reference) !== undefined))
  );
}
