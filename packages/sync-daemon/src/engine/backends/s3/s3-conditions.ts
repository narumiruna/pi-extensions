import { randomUUID } from "node:crypto";
import { posixJoin } from "../../paths.js";
import type { ResolvedS3Backend } from "../backend-types.js";
import { S3Client, S3HttpError, S3ObjectAlreadyExistsError } from "./s3-client.js";

export function requireS3Etag(value: string | undefined) {
  if (!value || !/^"[^"\r\n]+"$/u.test(value)) throw new Error("S3 conditional publication requires a strong ETag.");
  return value;
}

/** Never probe the active pointer or immutable snapshots; ignored conditions must not corrupt either. */
export async function verifyS3Conditions(config: ResolvedS3Backend, signal?: AbortSignal) {
  const key = posixJoin(
    config.destination.prefix === "./" ? "" : config.destination.prefix,
    ".pi-sync-probes",
    randomUUID(),
  );
  const client = new S3Client(config, signal);
  let failure: unknown;
  let attempted = false;
  try {
    signal?.throwIfAborted();
    attempted = true;
    await client.putBuffer(key, Buffer.from("first"), "text/plain", { ifAbsent: true });
    const first = await client.getBuffer(key);
    const etag = requireS3Etag(first.etag);
    if (!first.value?.equals(Buffer.from("first"))) throw new Error("S3 conditional probe read did not match.");
    await expectRejected(client.putBuffer(key, Buffer.from("ignored"), "text/plain", { ifAbsent: true }));
    await expectRejected(client.putBuffer(key, Buffer.from("ignored"), "text/plain", { ifMatch: '"pi-sync-stale"' }));
    const unchanged = await client.getBuffer(key);
    if (!unchanged.value?.equals(first.value) || unchanged.etag !== etag)
      throw new Error("S3 failed precondition changed the probe.");
    await client.putBuffer(key, Buffer.from("second"), "text/plain", { ifMatch: etag });
    const second = await client.getBuffer(key);
    if (!second.value?.equals(Buffer.from("second")) || requireS3Etag(second.etag) === etag) {
      throw new Error("S3 conditional write did not rotate the probe ETag.");
    }
    await expectRejected(client.putBuffer(key, Buffer.from("ignored"), "text/plain", { ifMatch: etag }));
    const final = await client.getBuffer(key);
    if (!final.value?.equals(second.value) || final.etag !== second.etag)
      throw new Error("S3 stale ETag changed the probe.");
    signal?.throwIfAborted();
  } catch (error) {
    failure = error;
  }
  // Cleanup has its own bounded deadline even when the owning session was cancelled.
  if (attempted) {
    try {
      await new S3Client(config, AbortSignal.timeout(10_000)).delete(key);
    } catch (error) {
      throw new Error(`S3 probe cleanup failed; remove ${key}.`, { cause: failure ?? error });
    }
  }
  if (failure) throw failure;
  signal?.throwIfAborted();
}

async function expectRejected(operation: Promise<void>) {
  try {
    await operation;
  } catch (error) {
    // 409 is retryable contention, not proof that a failed condition was enforced.
    if (error instanceof S3ObjectAlreadyExistsError || (error instanceof S3HttpError && error.status === 412)) return;
    throw error;
  }
  throw new Error("S3 server ignored a write precondition; publication stopped for safety.");
}
