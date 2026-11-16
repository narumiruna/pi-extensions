export function isMissingConfigError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.startsWith("Missing pi-sync settings.") || error.message === "No sync setups are configured.")
  );
}
