import { type BigIntStats, lstatSync, opendirSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../state/state-directory.js";

function stamp(info: BigIntStats | undefined) {
  return info && `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}`;
}

function inspect(target: string) {
  return lstatSync(target, { bigint: true, throwIfNoEntry: false });
}

export function startupRecoveryEvidence(root: string, reviewOwnsLock?: () => boolean): string | undefined {
  const state = stateDir(root);
  const transactions = path.join(state, "transactions");
  const guard = path.join(root, ".pi-sync-state-migration.lock");
  const lock = path.join(state, "lock");
  const protectedState = () =>
    state === stateDir(root) &&
    !inspect(guard) &&
    (reviewOwnsLock ? reviewOwnsLock() : !inspect(lock) && !inspect(`${lock}.guard`));
  if (!protectedState()) return;
  const parent = inspect(state);
  const pending = inspect(transactions);
  if (pending) {
    if (!pending.isDirectory()) return;
    const directory = opendirSync(transactions, { bufferSize: 1 });
    try {
      if (directory.readSync()) return;
    } finally {
      directory.closeSync();
    }
  }
  if (!protectedState() || stamp(parent) !== stamp(inspect(state)) || stamp(pending) !== stamp(inspect(transactions)))
    return;
  return JSON.stringify([state, stamp(parent), stamp(pending)]);
}
