import { readFileSync } from "node:fs";
import { valid } from "semver";

// Capture the installed build at module load. A later package update must not
// change the version advertised by an already running process.
export const { version: DAEMON_BUILD_VERSION, id: DAEMON_BUILD_ID } = readInstalledDaemonBuild();

export function readInstalledDaemonBuild() {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (typeof version !== "string" || valid(version) !== version)
    throw new Error("Invalid Pi Sync daemon build version.");
  return { version, id: readBuildId() };
}

export function isDaemonBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function readBuildId(): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(new URL("./build-id.json", import.meta.url), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isDaemonBuildId(value)) throw new Error("Invalid Pi Sync daemon build identifier.");
  return value;
}
