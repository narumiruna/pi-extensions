import { createHash } from "node:crypto";
import { encodeKey, posixJoin } from "../../paths.js";
import { sessionTokenWarnings } from "../../settings/config.js";
import { decodeSnapshot, encodeSnapshot } from "../../snapshot/snapshot-codec.js";
import type { Snapshot } from "../../snapshot/snapshot-types.js";
import { syncErrorGuidance } from "../../sync/sync-error-guidance.js";
import { portableSnapshotSelection } from "../../sync/sync-policy.js";
import type { LatestPointer, RemoteObject, ResolvedS3Backend } from "../backend-types.js";
import {
  type BackendDiagnostic,
  type ExpectedRemoteHead,
  type PublishSnapshotOptions,
  type PublishSnapshotResult,
  type RemoteHead,
  type RemoteHistoryEntry,
  type SyncBackend,
  SyncBackendConflictError,
  SyncBackendPublicationOutcomeUnknownError,
} from "../sync-backend.js";
import { S3Client, S3ObjectAlreadyExistsError } from "./s3-client.js";

const VERSION = 1;
const POST_COMMIT_TIMEOUT_MS = 30_000;

export class S3SyncBackend implements SyncBackend {
  readonly identity: string;
  readonly destination: string;
  readonly capability = "read-check-write-verify" as const;
  private readonly checksums = new Map<string, string>();

  constructor(
    private readonly config: ResolvedS3Backend,
    private readonly postCommitTimeoutMs = POST_COMMIT_TIMEOUT_MS,
  ) {
    assertSafeDestination(config);
    this.identity = s3BackendIdentity(config);
    this.destination = s3Destination(config);
  }

  sameRevision(left: string, right: string) {
    return left === right;
  }

  async readHead(signal?: AbortSignal): Promise<RemoteHead | undefined> {
    const object = await new S3Client(this.config, signal).getJson<LatestPointer>(latestKey(this.config));
    throwIfAborted(signal);
    if (object.missing) return undefined;
    const pointer = requirePointer(
      object.value,
      "Remote latest pointer is malformed.",
      this.config.destination.namespace,
    );
    this.registerChecksum(pointer.snapshot, pointer.sha256);
    return remoteHead(pointer, this.identity, object.etag);
  }

  async readSnapshot(reference: string, signal?: AbortSignal): Promise<Snapshot> {
    const expectedChecksum = this.checksums.get(reference) ?? (await this.resolveChecksum(reference, signal));
    const object = await new S3Client(this.config, signal).getBuffer(snapshotKey(this.config, reference));
    throwIfAborted(signal);
    if (!object.value) throw new Error(`Snapshot not found: ${reference}`);
    if (expectedChecksum && sha256(object.value) !== expectedChecksum) {
      throw new Error("Remote snapshot checksum mismatch.");
    }
    const snapshot = await decodeSnapshot(object.value, { signal });
    if (snapshot.id !== reference || snapshot.profile !== this.config.destination.namespace) {
      throw new Error("Remote snapshot identity mismatch.");
    }
    validateSnapshotBundle(snapshot);
    return snapshot;
  }

  async publishSnapshot(
    snapshot: Snapshot,
    expected: ExpectedRemoteHead,
    options: PublishSnapshotOptions = {},
  ): Promise<PublishSnapshotResult> {
    throwIfAborted(options.signal);
    assertSnapshotIdentity(snapshot, this.config.destination.namespace);
    const stagedKey = snapshotKey(this.config, snapshot.id);
    const encoded = await encodeSnapshot(snapshot);
    throwIfAborted(options.signal);
    const pointer = pointerFor(this.config, snapshot, sha256(encoded));
    const cancellableClient = new S3Client(this.config, options.signal);
    try {
      await cancellableClient.putBuffer(stagedKey, encoded, "application/gzip", {
        ifAbsent: true,
      });
    } catch (error) {
      if (!(error instanceof S3ObjectAlreadyExistsError)) throw error;
      const existing = await cancellableClient.getBuffer(stagedKey);
      if (!existing.value || sha256(existing.value) !== pointer.sha256) {
        throw new SyncBackendConflictError(
          `Immutable snapshot id already exists with different content: ${snapshot.id}`,
        );
      }
    }
    const currentObject = await cancellableClient.getJson<LatestPointer>(latestKey(this.config));
    throwIfAborted(options.signal);
    let current: RemoteHead | undefined;
    if (!currentObject.missing) {
      const currentPointer = requirePointer(
        currentObject.value,
        "Remote latest pointer is malformed.",
        this.config.destination.namespace,
      );
      this.registerChecksum(currentPointer.snapshot, currentPointer.sha256);
      current = remoteHead(currentPointer, this.identity, currentObject.etag);
    }
    if (!matchesExpected(current, expected)) {
      throw new SyncBackendConflictError("Remote changed while pushing. Run /sync pull first, then retry.", {
        currentHead: current,
      });
    }
    throwIfAborted(options.signal);
    options.onCommit?.();

    // The active-head PUT is the publication boundary. Do not bind it or its
    // verification to a user-cancellation signal after the boundary begins.
    const commitClient = new S3Client(this.config, AbortSignal.timeout(this.postCommitTimeoutMs));
    try {
      await commitClient.putJson(latestKey(this.config), pointer);
    } catch (error) {
      throw new SyncBackendPublicationOutcomeUnknownError(
        `Remote publication outcome is unknown: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let verifiedObject: RemoteObject<LatestPointer>;
    try {
      verifiedObject = await commitClient.getJson<LatestPointer>(latestKey(this.config));
    } catch (error) {
      throw new SyncBackendPublicationOutcomeUnknownError(
        `Remote snapshot may be active, but publication could not be verified: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    let verifiedPointer: LatestPointer;
    try {
      verifiedPointer = requirePointer(
        verifiedObject.value,
        "Remote latest pointer is malformed after publication.",
        this.config.destination.namespace,
      );
    } catch (error) {
      throw new SyncBackendPublicationOutcomeUnknownError(
        `Remote snapshot may be active, but publication verification was malformed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!samePointer(verifiedPointer, pointer)) {
      throw new SyncBackendConflictError(
        "Remote latest changed immediately after push. Run /sync status before continuing.",
        {
          phase: "after-commit",
          currentHead: remoteHead(verifiedPointer, this.identity, verifiedObject.etag),
          candidateMayHaveBeenActive: true,
        },
      );
    }
    this.registerChecksum(verifiedPointer.snapshot, verifiedPointer.sha256);
    const head = remoteHead(verifiedPointer, this.identity, verifiedObject.etag);
    const warning = await this.updateHistorySafely(commitClient, pointer);
    return { head, warnings: warning ? [warning] : [] };
  }

  async listHistory(signal?: AbortSignal): Promise<RemoteHistoryEntry[]> {
    const object = await new S3Client(this.config, signal).getJson<{
      version: number;
      snapshots: LatestPointer[];
    }>(historyKey(this.config));
    throwIfAborted(signal);
    if (object.missing) return [];
    const pointers = requireHistory(object.value, this.config.destination.namespace);
    for (const pointer of pointers) {
      const known = this.checksums.get(pointer.snapshot);
      if (known && known !== pointer.sha256) {
        throw new Error("Remote history conflicts with an already observed snapshot checksum.");
      }
    }
    for (const pointer of pointers) this.registerChecksum(pointer.snapshot, pointer.sha256);
    return pointers.map(remoteHistoryEntry);
  }

  async diagnose(signal?: AbortSignal): Promise<BackendDiagnostic[]> {
    throwIfAborted(signal);
    const diagnostics: BackendDiagnostic[] = [
      {
        key: "s3-config",
        level: "info",
        message: `s3 config: ok (${this.config.destination.bucket}/${storageRoot(this.config)})`,
      },
      ...sessionTokenWarnings(this.config.profile).map((message) => ({
        key: "s3-session-token",
        level: "warning" as const,
        message,
      })),
    ];
    const deadline = AbortSignal.timeout(10_000);
    const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const result = await new S3Client(this.config, probeSignal).diagnoseRead(latestKey(this.config));
      throwIfAborted(probeSignal);
      const messages = {
        readable: "s3 remote read: HTTP success. Snapshot contents and write access are not tested.",
        "missing-key":
          "s3 remote read: no snapshot at this path (NoSuchKey). Write access is not tested; verify the bucket and path before first sync.",
        "missing-bucket":
          "s3 remote read: bucket not found (NoSuchBucket). Create the bucket with your provider or edit the setup's bucket name.",
        "unknown-404":
          "s3 remote read: HTTP 404; cannot confirm whether the bucket or snapshot is missing. Verify the endpoint, bucket, and path with your provider. Write access is not tested.",
      };
      diagnostics.push({
        key: "s3-read",
        level: result === "readable" ? "info" : "warning",
        message: messages[result],
      });
    } catch (error) {
      throwIfAborted(signal);
      diagnostics.push({
        key: "s3-read",
        level: "warning",
        message: syncErrorGuidance(deadline.aborted ? new Error("S3 diagnostic request timed out.") : error),
      });
    }
    return diagnostics;
  }

  private async resolveChecksum(reference: string, signal?: AbortSignal) {
    await this.readHead(signal);
    const headChecksum = this.checksums.get(reference);
    if (headChecksum) return headChecksum;
    await this.listHistory(signal);
    return this.checksums.get(reference);
  }

  private registerChecksum(reference: string, checksum: string) {
    const known = this.checksums.get(reference);
    if (known && known !== checksum) {
      throw new Error("Remote snapshot reference was rebound to a different checksum.");
    }
    this.checksums.set(reference, checksum);
  }

  private async updateHistorySafely(client: S3Client, pointer: LatestPointer) {
    try {
      await this.updateHistory(client, pointer);
      return undefined;
    } catch (error) {
      return `Remote snapshot is active, but history could not be updated: ${errorMessage(error)}. Run /sync doctor before relying on history.`;
    }
  }

  private async updateHistory(client: S3Client, pointer: LatestPointer) {
    const object = await client.getJson<{ version: number; snapshots: LatestPointer[] }>(historyKey(this.config));
    const snapshots = object.missing ? [] : requireHistory(object.value, this.config.destination.namespace);
    const next = [...snapshots.filter((snapshot) => snapshot.snapshot !== pointer.snapshot), pointer].slice(-100);
    await client.putJson(historyKey(this.config), { version: VERSION, snapshots: next });
  }
}

export function latestKey(config: ResolvedS3Backend) {
  return posixJoin(storageRoot(config), "latest.json");
}

export function historyKey(config: ResolvedS3Backend) {
  return posixJoin(storageRoot(config), "history.json");
}

export function snapshotKey(config: ResolvedS3Backend, id: string) {
  requireSnapshotReference(id);
  return posixJoin(storageRoot(config), "snapshots", `${id}.json.gz`);
}

export function storageRoot(config: ResolvedS3Backend) {
  return config.destination.prefix === "./" ? "" : config.destination.prefix;
}

export function pointerFor(config: ResolvedS3Backend, snapshot: Snapshot, checksum: string): LatestPointer {
  return {
    version: VERSION,
    profile: config.destination.namespace,
    snapshot: snapshot.id,
    sha256: checksum,
    createdAt: snapshot.createdAt,
    machine: snapshot.machine,
    syncSessions: snapshot.syncSessions === true || snapshot.files.some((file) => file.path.startsWith("sessions/")),
    ...(snapshot.selection === undefined ? {} : { selection: snapshot.selection }),
  };
}

export function s3BackendIdentity(config: ResolvedS3Backend) {
  const destination = JSON.stringify([
    secretFreeEndpoint(config.profile.endpoint),
    trimSlashes(config.destination.bucket),
    trimSlashes(config.destination.prefix),
  ]);
  return `s3:${sha256(Buffer.from(destination))}`;
}

function s3Destination(config: ResolvedS3Backend) {
  let host = secretFreeEndpoint(config.profile.endpoint);
  try {
    host = new URL(host).hostname;
  } catch {
    host = "invalid S3 endpoint";
  }
  return `${host} · ${config.destination.bucket}/${storageRoot(config)}`;
}

function secretFreeEndpoint(value: string) {
  const normalized = value.trim();
  try {
    const url = new URL(normalized);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return normalized.replace(/\/\/[^/@\s]+@/u, "//");
  }
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

function remoteHistoryEntry(pointer: LatestPointer): RemoteHistoryEntry {
  return {
    snapshotRef: pointer.snapshot,
    snapshotId: pointer.snapshot,
    createdAt: pointer.createdAt,
    machine: pointer.machine,
    syncSessions: pointer.syncSessions === true,
  };
}

function remoteHead(pointer: LatestPointer, identity: string, etag?: string): RemoteHead {
  return {
    snapshotRef: pointer.snapshot,
    snapshotId: pointer.snapshot,
    revision: `s3:${sha256(Buffer.from(canonicalJson([identity, etag ?? null, pointer])))}`,
    createdAt: pointer.createdAt,
    machine: pointer.machine,
    syncSessions: pointer.syncSessions === true,
    ...(pointer.selection === undefined ? {} : { selection: pointer.selection }),
  };
}

function samePointer(left: LatestPointer, right: LatestPointer) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

function matchesExpected(head: RemoteHead | undefined, expected: ExpectedRemoteHead) {
  if (expected.kind === "missing") return head === undefined;
  return head?.revision === expected.revision;
}

function requirePointer(value: LatestPointer | undefined, message: string, expectedProfile: string) {
  if (
    !value ||
    value.version !== VERSION ||
    value.profile !== expectedProfile ||
    typeof value.snapshot !== "string" ||
    !isSafeSnapshotReference(value.snapshot) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.createdAt !== "string" ||
    !isSafeMetadata(value.createdAt, 64) ||
    typeof value.machine !== "string" ||
    !isSafeMetadata(value.machine, 256) ||
    (value.syncSessions !== undefined && typeof value.syncSessions !== "boolean")
  ) {
    throw new Error(message);
  }
  if (value.selection !== undefined) portableSnapshotSelection(value.selection);
  return value;
}

function requireHistory(value: { version: number; snapshots: LatestPointer[] } | undefined, expectedProfile: string) {
  if (!value || value.version !== VERSION || !Array.isArray(value.snapshots)) {
    throw new Error("Remote history is malformed.");
  }
  const pointers = value.snapshots.map((pointer) =>
    requirePointer(pointer, "Remote history entry is malformed.", expectedProfile),
  );
  const references = new Set<string>();
  for (const pointer of pointers) {
    if (references.has(pointer.snapshot)) {
      throw new Error("Remote history contains duplicate snapshot references.");
    }
    references.add(pointer.snapshot);
  }
  return pointers;
}

function assertSnapshotIdentity(snapshot: Snapshot, expectedProfile: string) {
  if (
    snapshot.version !== VERSION ||
    snapshot.profile !== expectedProfile ||
    !isSafeSnapshotReference(snapshot.id) ||
    !isSafeMetadata(snapshot.createdAt, 64) ||
    !isSafeMetadata(snapshot.machine, 256) ||
    !Array.isArray(snapshot.files)
  ) {
    throw new Error("Invalid snapshot identity for S3 publication.");
  }
}

function validateSnapshotBundle(snapshot: Snapshot) {
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.contentBase64 !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      paths.has(file.path)
    ) {
      throw new Error("Remote snapshot bundle is malformed.");
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.toString("base64") !== file.contentBase64 || sha256(content) !== file.sha256) {
      throw new Error("Remote snapshot file checksum mismatch.");
    }
    paths.add(file.path);
  }
}

function assertSafeDestination(config: ResolvedS3Backend) {
  for (const [label, value, allowEmpty] of [
    ["bucket", config.destination.bucket, false],
    ["prefix", config.destination.prefix, true],
    ["namespace", config.destination.namespace, false],
  ] as const) {
    if (label === "prefix" && value === "./") continue;
    if (
      (!allowEmpty && value.length === 0) ||
      value.includes("\\") ||
      hasControlCharacter(value) ||
      value.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(`Invalid S3 storage location ${label}.`);
    }
  }
}

function requireSnapshotReference(reference: string) {
  if (!isSafeSnapshotReference(reference)) {
    throw new Error("Invalid S3 snapshot reference.");
  }
}

function isSafeSnapshotReference(reference: string) {
  return (
    reference.length > 0 &&
    reference.length <= 512 &&
    reference !== "." &&
    reference !== ".." &&
    !reference.includes("/") &&
    !reference.includes("\\") &&
    !hasControlCharacter(reference)
  );
}

function isSafeMetadata(value: string, maxLength: number) {
  return value.length > 0 && value.length <= maxLength && !hasControlCharacter(value);
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export { encodeKey };
