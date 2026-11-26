import { lstatSync } from "node:fs";
import path from "node:path";
import { getEngineRoot } from "../host.js";
import { stateDir } from "../state/state-directory.js";
import { retiredIgnorePolicy } from "./retired-ignore-policy.js";

export function hasRetiredRuleJournal(root: string) {
  return Boolean(
    lstatSync(path.join(root, ".pi-sync.json.syncignore-creation"), { throwIfNoEntry: false }) ||
      lstatSync(path.join(stateDir(root), "ignore-adoption.json"), { throwIfNoEntry: false }),
  );
}

export function assertNoRetiredRuleJournal(root = getEngineRoot()) {
  if (hasRetiredRuleJournal(root)) {
    throw retiredIgnorePolicy("recovery");
  }
}
