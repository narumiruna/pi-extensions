import { readFileSync } from "node:fs";
import { valid } from "semver";

// Capture the installed build at module load. A later package update must not
// change the version advertised by an already running process.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (typeof version !== "string" || valid(version) !== version) throw new Error("Invalid Pi Sync daemon build version.");

export const DAEMON_BUILD_VERSION: string = version;
