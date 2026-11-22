import fs from "node:fs/promises";
import path from "node:path";
import type { DebugEvent } from "@narumitw/pi-sync-daemon/engine/debug-log";

export async function readClientDebug(root: string) {
  const bytes = await fs.readFile(path.join(root, "pi-sync.log"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const records = bytes
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DebugEvent & { source: string });
  return records.filter((event) => event.source === "pi-sync");
}
