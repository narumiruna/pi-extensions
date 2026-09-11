import { createHash, randomUUID } from "node:crypto";
import { decodeSnapshot, encodeSnapshot } from "../../snapshot/snapshot-codec.js";
import type { Snapshot } from "../../snapshot/snapshot-types.js";
import { syncErrorGuidance } from "../../sync/sync-error-guidance.js";
import { portableSnapshotSelection } from "../../sync/sync-policy.js";
import type { LatestPointer, RemoteObject, ResolvedWebDavBackend } from "../backend-types.js";
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
import { WebDavClient, WebDavHttpError, WebDavPreconditionError } from "./webdav-client.js";

const VERSION = 1;
const POST_COMMIT_TIMEOUT_MS = 30_000;

export class WebDavSyncBackend implements SyncBackend {
  readonly identity: string;
  readonly destination: string;
  private conditionalVerified = false;
  private readonly checksums = new Map<string, string>();
  private capabilityCheck?: Promise<void>;

  constructor(
    private readonly config: ResolvedWebDavBackend,
    private readonly postCommitTimeoutMs = POST_COMMIT_TIMEOUT_MS,
  ) {
    assertSafeDestination(config);
    this.identity = webDavBackendIdentity(config);
    this.destination = webDavStorageLocation(config);
  }

  get capability() {
    return this.conditionalVerified ? ("atomic-conditional" as const) : ("conditional-required" as const);
  }

  sameRevision(left: string, right: string) {
    return left === right;
  }

  async readHead(signal?: AbortSignal): Promise<RemoteHead | undefined> {
    const object = await new WebDavClient(this.config, signal).getJson<LatestPointer>(latestPath(this.config));
    throwIfAborted(signal);
    if (object.missing) return undefined;
    const pointer = requirePointer(object.value, this.config.destination.namespace);
    this.registerChecksum(pointer.snapshot, pointer.sha256);
    return remoteHead(pointer, this.identity, object.etag);
  }

  async readSnapshot(reference: string, signal?: AbortSignal): Promise<Snapshot> {
    requireSnapshotReference(reference);
    const expectedChecksum = this.checksums.get(reference) ?? (await this.resolveChecksum(reference, signal));
    const object = await new WebDavClient(this.config, signal).getBuffer(snapshotPath(this.config, reference));
    throwIfAborted(signal);
    if (!object.value) throw new Error(`Snapshot not found: ${reference}`);
    if (!expectedChecksum || sha256(object.value) !== expectedChecksum) {
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
    await this.ensureAtomicConditions(options.signal);
    throwIfAborted(options.signal);
    const client = new WebDavClient(this.config, options.signal);
    await client.ensureCollection(snapshotsPath(this.config));
    const encoded = await encodeSnapshot(snapshot);
    throwIfAborted(options.signal);
    const pointer = pointerFor(this.config, snapshot, sha256(encoded));
    const stagedPath = snapshotPath(this.config, snapshot.id);
    try {
      await client.putBuffer(stagedPath, encoded, "application/gzip", { ifAbsent: true });
    } catch (error) {
      if (!(error instanceof WebDavPreconditionError)) throw error;
      const existing = await client.getBuffer(stagedPath);
      if (!existing.value || sha256(existing.value) !== pointer.sha256) {
        throw new SyncBackendConflictError(
          `Immutable snapshot id already exists with different content: ${snapshot.id}`,
        );
      }
    }
    const currentObject = await client.getJson<LatestPointer>(latestPath(this.config));
    throwIfAborted(options.signal);
    const current = currentObject.missing
      ? undefined
      : remoteHead(
          requirePointer(currentObject.value, this.config.destination.namespace),
          this.identity,
          currentObject.etag,
        );
    if (!matchesExpected(current, expected)) {
      throw new SyncBackendConflictError("Remote changed while pushing. Run /sync pull first, then retry.", {
        currentHead: current,
      });
    }
    const condition = publicationCondition(currentObject, expected, this.identity);
    throwIfAborted(options.signal);
    options.onCommit?.();
    const commitClient = new WebDavClient(
      this.config,
      AbortSignal.timeout(this.postCommitTimeoutMs),
      this.postCommitTimeoutMs,
    );
    try {
      await commitClient.putJson(latestPath(this.config), pointer, condition);
    } catch (error) {
      if (error instanceof WebDavPreconditionError) {
        const latest = await this.readHeadAfterCommit(commitClient).catch(() => undefined);
        throw new SyncBackendConflictError("Remote changed while publishing the WebDAV pointer.", {
          currentHead: latest,
        });
      }
      throw new SyncBackendPublicationOutcomeUnknownError(
        `Remote publication outcome is unknown: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    let verifiedObject: RemoteObject<LatestPointer>;
    try {
      verifiedObject = await commitClient.getJson<LatestPointer>(latestPath(this.config));
    } catch (error) {
      throw new SyncBackendPublicationOutcomeUnknownError(
        `Remote snapshot may be active, but publication could not be verified: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    let verified: LatestPointer;
    try {
      verified = requirePointer(verifiedObject.value, this.config.destination.namespace);
    } catch (error) {
      throw new SyncBackendPublicationOutcomeUnknownError(
        `Remote snapshot may be active, but publication verification was malformed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!samePointer(pointer, verified)) {
      throw new SyncBackendConflictError(
        "Remote latest changed immediately after push. Run /sync status before continuing.",
        {
          phase: "after-commit",
          currentHead: remoteHead(verified, this.identity, verifiedObject.etag),
          candidateMayHaveBeenActive: true,
        },
      );
    }
    if (!strongEtag(verifiedObject.etag)) {
      throw new SyncBackendPublicationOutcomeUnknownError(
        "Remote snapshot is active, but the WebDAV server returned no strong ETag.",
      );
    }
    this.registerChecksum(verified.snapshot, verified.sha256);
    const head = remoteHead(verified, this.identity, verifiedObject.etag);
    const warning = await this.updateHistorySafely(commitClient, pointer);
    return { head, warnings: warning ? [warning] : [] };
  }

  async listHistory(signal?: AbortSignal): Promise<RemoteHistoryEntry[]> {
    const object = await new WebDavClient(this.config, signal).getJson<{
      version: number;
      snapshots: LatestPointer[];
    }>(historyPath(this.config));
    throwIfAborted(signal);
    if (object.missing) return [];
    const pointers = requireHistory(object.value, this.config.destination.namespace);
    for (const pointer of pointers) this.registerChecksum(pointer.snapshot, pointer.sha256);
    return pointers.map(remoteHistoryEntry);
  }

  async diagnose(signal?: AbortSignal): Promise<BackendDiagnostic[]> {
    const diagnostics: BackendDiagnostic[] = [
      {
        key: "webdav-url",
        level: "info",
        message: `webdav URL/TLS/auth: configured (${webDavStorageLocation(this.config)})`,
      },
      {
        key: "webdav-scope",
        level: "info",
        message:
          "webdav check scope: temporary write/delete probe; repair the active snapshot's history entry if missing. No local content is applied.",
      },
    ];
    try {
      await this.runCapabilityProbe(signal);
      diagnostics.push(
        { key: "webdav-collection", level: "info", message: "webdav collection read/write: ok" },
        {
          key: "webdav-conditional",
          level: "info",
          message: "webdav conditional publication: atomic-conditional (verified)",
        },
        { key: "webdav-cleanup", level: "info", message: "webdav probe cleanup: ok" },
      );
    } catch (error) {
      this.capabilityCheck = undefined;
      this.conditionalVerified = false;
      if (error instanceof Error && error.name === "AbortError") throw error;
      diagnostics.push({
        key: "webdav-probe",
        level: "error",
        message: `webdav publication is read-only until diagnostics pass: ${syncErrorGuidance(error)}`,
      });
      return diagnostics;
    }
    try {
      diagnostics.push({
        key: "webdav-history",
        level: "info",
        message: await this.reconcileActiveHistory(signal),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      diagnostics.push({
        key: "webdav-history",
        level: "error",
        message: `webdav history repair failed: ${syncErrorGuidance(error)}`,
      });
    }
    return diagnostics;
  }

  private ensureAtomicConditions(signal?: AbortSignal) {
    if (this.capabilityCheck) return this.capabilityCheck;
    this.conditionalVerified = false;
    const check = this.runCapabilityProbe(signal).finally(() => {
      if (this.capabilityCheck === check) this.capabilityCheck = undefined;
    });
    this.capabilityCheck = check;
    return check;
  }

  private async runCapabilityProbe(signal?: AbortSignal) {
    throwIfAborted(signal);
    const probeCollection = joinRemote(rootPath(this.config), ".pi-sync-probes", randomUUID());
    const probe = `${probeCollection}/conditional.txt`;
    const client = new WebDavClient(this.config, signal);
    let created = false;
    let operationError: unknown;
    try {
      created = true;
      await client.ensureCollection(probeCollection);
      await client.listCollection(probeCollection);
      await client.putBuffer(probe, Buffer.from("first"), "text/plain", { ifAbsent: true });
      const read = await client.getBuffer(probe);
      const etag = strongEtag(read.etag);
      if (!read.value || !etag) {
        throw new Error("WebDAV server did not return a strong ETag for the capability probe.");
      }
      await expectPrecondition(
        client.putBuffer(probe, Buffer.from("replace"), "text/plain", { ifAbsent: true }),
        "If-None-Match",
      );
      await expectPrecondition(
        client.putBuffer(probe, Buffer.from("replace"), "text/plain", {
          ifMatch: '"pi-sync-deliberately-stale"',
        }),
        "If-Match",
      );
      const unchanged = await client.getBuffer(probe);
      if (!unchanged.value?.equals(Buffer.from("first"))) {
        throw new Error("WebDAV server changed a probe despite a failed precondition.");
      }
      await client.putBuffer(probe, Buffer.from("second"), "text/plain", { ifMatch: etag });
      const changed = await client.getBuffer(probe);
      const changedEtag = strongEtag(changed.etag);
      if (!changed.value?.equals(Buffer.from("second")) || !changedEtag || changedEtag === etag) {
        throw new Error("WebDAV server did not rotate its strong ETag after changing the capability probe.");
      }
    } catch (error) {
      operationError = error;
    }
    if (created) {
      try {
        await new WebDavClient(this.config, undefined).delete(probeCollection);
      } catch (cleanupError) {
        const operationDetail = operationError ? `WebDAV probe failed: ${errorMessage(operationError)}; ` : "";
        throw new Error(
          `${operationDetail}probe cleanup also failed; remove ${probeCollection}: ${errorMessage(cleanupError)}`,
          { cause: operationError ?? cleanupError },
        );
      }
    }
    if (operationError) throw operationError;
    this.conditionalVerified = true;
  }

  private async resolveChecksum(reference: string, signal?: AbortSignal) {
    await this.readHead(signal);
    if (this.checksums.has(reference)) return this.checksums.get(reference);
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

  private async readHeadAfterCommit(client: WebDavClient) {
    const object = await client.getJson<LatestPointer>(latestPath(this.config));
    if (object.missing) return undefined;
    return remoteHead(requirePointer(object.value, this.config.destination.namespace), this.identity, object.etag);
  }

  private async reconcileActiveHistory(signal?: AbortSignal) {
    const client = new WebDavClient(this.config, signal);
    const object = await client.getJson<LatestPointer>(latestPath(this.config));
    throwIfAborted(signal);
    if (object.missing) return "webdav history: no active snapshot";
    const pointer = requirePointer(object.value, this.config.destination.namespace);
    this.registerChecksum(pointer.snapshot, pointer.sha256);
    const repaired = await this.ensureHistoryPointer(client, pointer);
    return repaired
      ? "webdav history: repaired active snapshot entry"
      : "webdav history: active snapshot entry present";
  }

  private async ensureHistoryPointer(client: WebDavClient, pointer: LatestPointer) {
    const object = await client.getJson<{ version: number; snapshots: LatestPointer[] }>(historyPath(this.config));
    const snapshots = object.missing ? [] : requireHistory(object.value, this.config.destination.namespace);
    const existing = snapshots.find((entry) => entry.snapshot === pointer.snapshot);
    if (existing) {
      if (!samePointer(existing, pointer)) {
        throw new Error("Remote history rebound an immutable snapshot reference.");
      }
      return false;
    }
    const next = [...snapshots, pointer].slice(-100);
    const condition = object.missing ? { ifAbsent: true } : { ifMatch: requireStrongEtag(object.etag, "history") };
    await client.putJson(historyPath(this.config), { version: VERSION, snapshots: next }, condition);
    return true;
  }

  private async updateHistorySafely(client: WebDavClient, pointer: LatestPointer) {
    try {
      await this.ensureHistoryPointer(client, pointer);
      return undefined;
    } catch (error) {
      return `Remote snapshot is active, but history could not be updated: ${errorMessage(error)}. Run /sync doctor before relying on history.`;
    }
  }
}

export function rootPath(config: ResolvedWebDavBackend) {
  return config.destination.path === "./" ? "" : config.destination.path;
}

export function latestPath(config: ResolvedWebDavBackend) {
  return joinRemote(rootPath(config), "latest.json");
}

export function historyPath(config: ResolvedWebDavBackend) {
  return joinRemote(rootPath(config), "history.json");
}

export function snapshotsPath(config: ResolvedWebDavBackend) {
  return joinRemote(rootPath(config), "snapshots");
}

export function snapshotPath(config: ResolvedWebDavBackend, reference: string) {
  requireSnapshotReference(reference);
  return joinRemote(snapshotsPath(config), `${reference}.json.gz`);
}

export function webDavBackendIdentity(config: ResolvedWebDavBackend) {
  return `webdav:${sha256(Buffer.from(JSON.stringify([secretFreeUrl(config.profile.url), config.destination.path])))}`;
}

function webDavStorageLocation(config: ResolvedWebDavBackend) {
  const url = new URL(secretFreeUrl(config.profile.url));
  return `${url.host} · ${config.destination.path}`;
}

function pointerFor(config: ResolvedWebDavBackend, snapshot: Snapshot, checksum: string): LatestPointer {
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

function remoteHead(pointer: LatestPointer, identity: string, etag?: string): RemoteHead {
  return {
    snapshotRef: pointer.snapshot,
    snapshotId: pointer.snapshot,
    revision: encodeRevision(identity, etag, pointer),
    createdAt: pointer.createdAt,
    machine: pointer.machine,
    syncSessions: pointer.syncSessions === true,
    ...(pointer.selection === undefined ? {} : { selection: pointer.selection }),
  };
}

function encodeRevision(identity: string, etag: string | undefined, pointer: LatestPointer) {
  return `webdav-v1:${Buffer.from(JSON.stringify({ identity, etag: etag ?? null, pointer: sha256(Buffer.from(canonicalJson(pointer))) })).toString("base64url")}`;
}

function decodeRevision(value: string, identity: string) {
  try {
    if (!value.startsWith("webdav-v1:")) return undefined;
    const parsed = JSON.parse(Buffer.from(value.slice(10), "base64url").toString("utf8")) as {
      identity?: unknown;
      etag?: unknown;
    };
    if (parsed.identity !== identity || typeof parsed.etag !== "string") return undefined;
    return strongEtag(parsed.etag);
  } catch {
    return undefined;
  }
}

function publicationCondition(current: RemoteObject<LatestPointer>, expected: ExpectedRemoteHead, identity: string) {
  if (expected.kind === "missing") return { ifAbsent: true };
  const etag = decodeRevision(expected.revision, identity) ?? strongEtag(current.etag);
  if (!etag) throw new SyncBackendConflictError("WebDAV head has no usable strong ETag.");
  return { ifMatch: etag };
}

async function expectPrecondition(operation: Promise<unknown>, header: string) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof WebDavPreconditionError) return;
    throw error;
  }
  throw new Error(`WebDAV server ignored ${header}; publication is read-only for safety.`);
}

function requireStrongEtag(value: string | undefined, resource: string) {
  const etag = strongEtag(value);
  if (!etag) throw new Error(`WebDAV ${resource} has no strong ETag.`);
  return etag;
}

function strongEtag(value: string | undefined) {
  return value && !value.startsWith("W/") && /^"[^"\r\n]+"$/u.test(value) ? value : undefined;
}

function requirePointer(value: LatestPointer | undefined, expectedProfile: string) {
  if (
    !value ||
    value.version !== VERSION ||
    value.profile !== expectedProfile ||
    !isSafeReference(value.snapshot) ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    !isSafeMetadata(value.createdAt, 64) ||
    !isSafeMetadata(value.machine, 256) ||
    (value.syncSessions !== undefined && typeof value.syncSessions !== "boolean")
  ) {
    throw new Error("Remote latest pointer is malformed.");
  }
  if (value.selection !== undefined) portableSnapshotSelection(value.selection);
  return value;
}

function requireHistory(value: { version: number; snapshots: LatestPointer[] } | undefined, expectedProfile: string) {
  if (!value || value.version !== VERSION || !Array.isArray(value.snapshots)) {
    throw new Error("Remote history is malformed.");
  }
  const pointers = value.snapshots.map((item) => requirePointer(item, expectedProfile));
  if (new Set(pointers.map((item) => item.snapshot)).size !== pointers.length) {
    throw new Error("Remote history contains duplicate snapshot references.");
  }
  return pointers;
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

function assertSnapshotIdentity(snapshot: Snapshot, namespace: string) {
  if (
    snapshot.version !== VERSION ||
    snapshot.profile !== namespace ||
    !isSafeReference(snapshot.id) ||
    !isSafeMetadata(snapshot.createdAt, 64) ||
    !isSafeMetadata(snapshot.machine, 256) ||
    !Array.isArray(snapshot.files)
  ) {
    throw new Error("Invalid snapshot identity for WebDAV publication.");
  }
}

function validateSnapshotBundle(snapshot: Snapshot) {
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (
      !file ||
      !isSafeSnapshotPath(file.path) ||
      paths.has(file.path) ||
      typeof file.contentBase64 !== "string" ||
      typeof file.sha256 !== "string"
    ) {
      throw new Error("Remote snapshot bundle is malformed.");
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.toString("base64") !== file.contentBase64 || sha256(content) !== file.sha256) {
      throw new Error("Remote snapshot bundle is malformed.");
    }
    paths.add(file.path);
  }
}

function isSafeSnapshotPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\\")) {
    return false;
  }
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function assertSafeDestination(config: ResolvedWebDavBackend) {
  const url = new URL(config.profile.url);
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid WebDAV URL.");
  for (const [label, value] of [
    ["path", config.destination.path],
    ["namespace", config.destination.namespace],
  ]) {
    if (label === "path" && value === "./") continue;
    if (
      !value ||
      value.includes("\\") ||
      [...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      }) ||
      value.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("Invalid WebDAV storage location.");
    }
  }
}

function isSafeMetadata(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  );
}

function requireSnapshotReference(reference: string) {
  if (!isSafeReference(reference)) throw new Error("Invalid WebDAV snapshot reference.");
}

function isSafeReference(value: string) {
  return (
    !!value &&
    value.length <= 512 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remote references cannot contain terminal controls.
    !/[\\/\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function matchesExpected(head: RemoteHead | undefined, expected: ExpectedRemoteHead) {
  return expected.kind === "missing" ? head === undefined : head?.revision === expected.revision;
}

function samePointer(left: LatestPointer, right: LatestPointer) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonicalJson(item))));
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, JSON.parse(canonicalJson((value as Record<string, unknown>)[key]))]),
    ),
  );
}

function joinRemote(...parts: string[]) {
  return parts
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .join("/");
}

function secretFreeUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function errorMessage(error: unknown) {
  if (error instanceof WebDavHttpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
