import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { backendIdentityCoordinates } from "../backends/backend-identity.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { writeJson } from "../state/json-file.js";
import { stateDir } from "../state/state-directory.js";
import { ensureStateDir } from "../state/sync-state-store.js";

export const CONTINUOUS_RECORD_MAX_BYTES = 131072;

export function hashContinuous(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
}
export async function continuousBinding(config: AnySyncConfig) {
  return hashContinuous([await fs.realpath(getAgentDir()), config.setupName, backendIdentityCoordinates(config)]);
}
export function continuousRoot() {
  return path.join(stateDir(), "continuous");
}
export async function prepareContinuousRoot() {
  await ensureStateDir();
  await fs.mkdir(continuousRoot(), { recursive: true, mode: 0o700 });
  await checkContinuousRoot();
}
export async function checkContinuousRoot() {
  const stat = await fs.lstat(continuousRoot());
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && stat.mode & 0o077))
    throw new Error("Unsafe continuous sync directory; evidence retained.");
}
export async function readContinuousPrivate(name: string): Promise<unknown> {
  return (await readContinuousPrivateDocument(name))?.value;
}
/** Read-only metadata; uses the same private-file checks as runtime reads. */
export async function readContinuousPrivateDocument(
  name: string,
): Promise<{ value: unknown; bytes: number } | undefined> {
  try {
    await checkContinuousRoot();
    const file = path.join(continuousRoot(), name);
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > CONTINUOUS_RECORD_MAX_BYTES ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      throw new Error("Unsafe continuous sync record; evidence retained.");
    const bytes = await fs.readFile(file);
    return { value: JSON.parse(bytes.toString("utf8")), bytes: bytes.byteLength };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function writeContinuousPrivate(name: string, value: unknown) {
  await checkContinuousRoot();
  await readContinuousPrivate(name); // Never replace unsafe or malformed evidence.
  await writeJson(path.join(continuousRoot(), name), value, { maxBytes: CONTINUOUS_RECORD_MAX_BYTES });
}
