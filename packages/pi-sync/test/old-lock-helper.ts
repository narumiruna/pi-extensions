import { utimesSync, writeFileSync } from "node:fs";
import { lockPath } from "../src/state/sync-state-store.js";

export function writeOldLock(contents: string) {
  writeFileSync(lockPath(), contents);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath(), old, old);
}
