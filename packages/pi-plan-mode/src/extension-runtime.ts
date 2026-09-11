export function isStaleExtensionContextError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("This extension ctx is stale after session replacement or reload") ||
      error.message.includes("Extension context is no longer active"))
  );
}
