import { type DaemonConnection, DaemonError, requestDaemon } from "@narumitw/pi-sync-daemon";

export async function requestStartupBootstrap(
  connection: DaemonConnection,
  fingerprint: string | null,
  debug: boolean,
  signal: AbortSignal,
): Promise<boolean> {
  let result: unknown;
  try {
    const { id: client, generation } = connection.facts;
    result = await requestDaemon(
      connection.paths,
      connection.identity,
      "startup.bootstrap",
      { client, generation, fingerprint, debug },
      signal,
    );
  } catch (error) {
    if (error instanceof DaemonError && error.name === "Error" && error.message === "Unknown daemon method.")
      return false;
    throw error;
  }
  if (typeof result !== "boolean") throw new Error("Invalid startup bootstrap response.");
  return result;
}
