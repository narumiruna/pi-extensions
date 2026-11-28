import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip, gzip } from "node:zlib";
import { throwIfAborted } from "../sync/signals.js";
import {
  assertSnapshotExcludesDebugLog,
  requireLegacyTransferPolicy,
  validateSnapshotSelection,
} from "../sync/sync-policy.js";
import { SnapshotCaptureLimitError } from "./snapshot-capture-limit.js";
import { isSupportedSnapshotVersion, type Snapshot } from "./snapshot-types.js";

const VERSION = 1;
const MAX_DECOMPRESSED_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const gzipAsync = promisify(gzip);

export async function encodeSnapshot(snapshot: Snapshot) {
  requireLegacyTransferPolicy(snapshot);
  if (!isSupportedSnapshotVersion(snapshot?.version)) throw new Error("Unsupported snapshot format.");
  assertSnapshotExcludesDebugLog(snapshot);
  validateSnapshotSelection(snapshot);
  if (snapshot.version >= 4) {
    const { validatePortableSnapshot } = await import("../sync/local-fields.js");
    validatePortableSnapshot(snapshot);
  }
  return gzipAsync(Buffer.from(JSON.stringify(snapshot), "utf8"));
}

export async function decodeSnapshot(
  buffer: Buffer,
  options: { signal?: AbortSignal; maxOutputLength?: number } = {},
): Promise<Snapshot> {
  throwIfAborted(options.signal);
  const limit = options.maxOutputLength ?? MAX_DECOMPRESSED_SNAPSHOT_BYTES;
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > limit) {
        callback(
          options.maxOutputLength === undefined
            ? new Error(`Decompressed snapshot exceeds the ${limit}-byte limit.`)
            : new SnapshotCaptureLimitError(),
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from([buffer]), createGunzip(), sink, { signal: options.signal });
  throwIfAborted(options.signal);
  const payload = Buffer.concat(chunks, total);
  const parsed = JSON.parse(payload.toString("utf8")) as Snapshot;
  if (parsed && typeof parsed === "object") requireLegacyTransferPolicy(parsed);
  if (!isSupportedSnapshotVersion(parsed?.version) || !Array.isArray(parsed.files)) {
    throw new Error("Unsupported snapshot format.");
  }
  assertSnapshotExcludesDebugLog(parsed);
  validateSnapshotSelection(parsed);
  if (parsed.version !== VERSION) {
    const { normalizeLocalFields, validatePortableSnapshot } = await import("../sync/local-fields.js");
    validatePortableSnapshot(parsed);
    if (parsed.localFields !== undefined) parsed.localFields = normalizeLocalFields(parsed.localFields);
  } else if (parsed.localFields !== undefined) throw new Error("Portable field policy requires snapshot version 2.");
  return parsed;
}
