import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { documentFingerprint } from "../../document.js";
import { type Execution, record } from "../../protocol.js";
import { getEngineRoot } from "../host.js";
import { type LocalConfigDocument, withLockedLocalConfigDocument } from "../settings/config-file.js";
import { validateConfigName, validateSettingsDocument } from "../settings/settings-validation.js";
import { sameFile, sameIdentity } from "./ignore-source.js";

const MIGRATION_VERSION = 1;
const flush = promisify(fsync);

function markerPath(root: string, setup: string) {
  const key = createHash("sha256")
    .update(JSON.stringify([setup, MIGRATION_VERSION]))
    .digest("hex");
  return path.join(root, `.pi-sync.json.ignore-migration-${key}.deferred`);
}

function markerAt(target: string) {
  const marker = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (
    marker &&
    (!marker.isFile() ||
      marker.nlink !== 1n ||
      marker.size !== 0n ||
      (process.getuid && marker.uid !== BigInt(process.getuid())) ||
      (process.platform !== "win32" && (marker.mode & 0o077n) !== 0n) ||
      realpathSync(target) !== target)
  )
    throw new Error(`Unsafe ignore migration deferral marker at "${target}"; preserve it for inspection.`);
  return marker;
}

function eligibleToken(document: LocalConfigDocument | undefined, setup: string) {
  if (!document) return null;
  const settings = validateSettingsDocument(document.parsed);
  if (
    settings.activeSyncSetup !== setup ||
    !Object.hasOwn(settings.syncSetups, setup) ||
    settings.syncSetups[setup].sync.pathPolicy === "ignore-file"
  )
    return null;
  const fingerprint = documentFingerprint({ bytes: document.bytes.toString("base64"), identity: document.identity });
  return createHash("sha256")
    .update(JSON.stringify([MIGRATION_VERSION, document.path, fingerprint]))
    .digest("hex");
}

function stale(): never {
  throw new Error("Ignore migration offer is stale; reopen Pi Sync.");
}

export function assertCurrentIgnoreMigrationOffer(
  document: LocalConfigDocument | undefined,
  root: string,
  setup: string,
  token: string,
): void {
  if (eligibleToken(document, setup) !== token || markerAt(markerPath(root, setup))) stale();
}

function validateClient(execution: Execution) {
  execution.validate();
  const facts = execution.facts();
  if (!execution.clientId || facts?.id !== execution.clientId || facts.mode !== "tui" || !facts.hasUI)
    throw new Error("Ignore migration offers require an attached TUI client.");
}

function readRequest(payload: unknown, execution: Execution, fields: readonly string[]) {
  validateClient(execution);
  if (
    !record(payload) ||
    typeof payload.setup !== "string" ||
    Object.keys(payload).some((key) => !fields.includes(key))
  )
    throw new Error("Invalid ignore migration offer request.");
  validateConfigName(payload.setup, "sync setup");
  return payload.setup;
}

export async function readIgnoreMigrationOffer(
  payload: unknown,
  execution: Execution,
): Promise<{ token: string } | null> {
  const setup = readRequest(payload, execution, ["setup"]);
  const result = await withLockedLocalConfigDocument(
    async (document, recheck) => {
      validateClient(execution);
      const token = eligibleToken(document, setup);
      const deferred = token && markerAt(markerPath(getEngineRoot(), setup));
      recheck();
      return token && !deferred ? { token } : null;
    },
    execution.signal,
    false,
    { securePermissions: false },
  );
  validateClient(execution);
  return result;
}

export function deferIgnoreMigrationOffer(payload: unknown, execution: Execution): Promise<true> {
  const setup = readRequest(payload, execution, ["setup", "token"]);
  if (!record(payload) || typeof payload.token !== "string" || !/^[a-f0-9]{64}$/u.test(payload.token))
    throw new Error("Invalid ignore migration offer token.");
  const { token } = payload;
  return withLockedLocalConfigDocument<true>(
    async (document, recheck) => {
      validateClient(execution);
      const root = getEngineRoot();
      const target = markerPath(root, setup);
      assertCurrentIgnoreMigrationOffer(document, root, setup, token);
      await createMarker(root, target, () => {
        if (execution.liveClients().some((peer) => peer.sessionFile && path.resolve(peer.sessionFile) === target))
          throw new Error("Cannot defer ignore migration at a protected live session path.");
        validateClient(execution);
        recheck();
      });
      return true;
    },
    execution.signal,
    true,
    { securePermissions: false },
  );
}

async function createMarker(root: string, target: string, beforeCreate: () => void) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directory =
    process.platform === "win32" ? undefined : openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
  try {
    beforeCreate();
    if (
      directory !== undefined &&
      !sameIdentity(lstatSync(getEngineRoot(), { bigint: true }), fstatSync(directory, { bigint: true }))
    )
      throw new Error("The Pi agent directory changed before recording ignore migration deferral.");
    const marker = openMarker(target, noFollow);
    try {
      const installed = fstatSync(marker, { bigint: true });
      try {
        await flush(marker);
        if (directory !== undefined) await flush(directory);
      } catch (cause) {
        throw new Error("Ignore migration was deferred but marker durability could not be verified.", { cause });
      }
      getEngineRoot();
      const current = markerAt(target);
      if (!current || !sameFile(installed, current))
        throw new Error("Ignore migration deferral marker changed during publication.");
    } finally {
      closeSync(marker);
    }
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

function openMarker(target: string, noFollow: number) {
  try {
    return openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") stale();
    throw error;
  }
}
