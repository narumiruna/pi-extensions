import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { backendIdentityCoordinates } from "../backends/backend-identity.js";
import { safeName } from "../paths.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { readJsonIfExists, writeJson } from "./json-file.js";
import { stateDir } from "./state-directory.js";
import type { SyncState } from "./state-types.js";

const STATE_VERSION = 2;

/** Bounded observation token; do not retain the full baseline in passive UI state. */
export function syncStateFingerprint(state: SyncState) {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export async function readState(profile: string): Promise<SyncState> {
  return (
    (await readJsonIfExists<SyncState>(statePath(profile))) ?? {
      version: STATE_VERSION,
      profile,
      lastFileHashes: {},
    }
  );
}

export async function writeState(profile: string, state: SyncState) {
  await writeJson(statePath(profile), state);
}

export async function readStateForConfig(config: AnySyncConfig): Promise<SyncState> {
  return (
    (await readJsonIfExists<SyncState>(statePathForConfig(config))) ?? {
      version: STATE_VERSION,
      profile: config.snapshotIdentity,
      lastFileHashes: {},
    }
  );
}

export async function writeStateForConfig(config: AnySyncConfig, state: SyncState) {
  await writeJson(statePathForConfig(config), state);
}

export function statePathForConfig(config: AnySyncConfig) {
  const identity = backendIdentityCoordinates(config);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(stateDir(), "setups", `${config.backend.type}-${hash}.state.json`);
}

function statePath(profile: string) {
  return path.join(stateDir(), `${safeName(profile)}.state.json`);
}

export function lockPath() {
  return path.join(stateDir(), "lock");
}

export async function ensureStateDir() {
  await fs.mkdir(stateDir(), { recursive: true });
}
