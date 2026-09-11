import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip, gzip } from "node:zlib";
import { snapshotSelectionInclude } from "../sync/sync-policy.js";
import type { Snapshot } from "./snapshot-types.js";

const VERSION = 1;
const MAX_DECOMPRESSED_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const gzipAsync = promisify(gzip);

export async function encodeSnapshot(snapshot: Snapshot) {
  snapshotSelectionInclude(snapshot);
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
        callback(new Error(`Decompressed snapshot exceeds the ${limit}-byte limit.`));
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from([buffer]), createGunzip(), sink, { signal: options.signal });
  throwIfAborted(options.signal);
  const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as Snapshot;
  if (parsed.version !== VERSION || !Array.isArray(parsed.files)) {
    throw new Error("Unsupported snapshot format.");
  }
  snapshotSelectionInclude(parsed);
  return parsed;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
