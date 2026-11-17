import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "../state/state-directory.js";

export function transactionRoot() {
  return path.join(stateDir(), "transactions");
}

export async function pendingTransactionEntries() {
  try {
    return await fs.readdir(transactionRoot(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
