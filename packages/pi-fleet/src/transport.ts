import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, opendir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import {
  createSignedEndpointManifest,
  createSignedFrame,
  FixedWindowRateLimiter,
  FLEET_PROTOCOL_VERSION,
  type FleetAckCode,
  type FleetAckPayload,
  type FleetGroup,
  type FleetLocalPeerDescription,
  type FleetMessage,
  type FleetPeerDescription,
  JsonLineDecoder,
  ReplayWindow,
  type SignedEndpointManifest,
  type SignedFleetFrame,
  validateMessage,
  validateMessageTiming,
  validatePeerDescription,
  verifySignedEndpointManifest,
  verifySignedFrame,
} from "./protocol.js";
import {
  assertOwnedPath,
  cleanupStaleRuntimeEntries,
  createEndpointPaths,
  type EndpointPaths,
  endpointIdFromManifestName,
  ensureGroupRuntimeDirectory,
  MAX_MANIFEST_BYTES,
  MAX_RUNTIME_SCAN_ENTRIES,
  publishManifest,
  randomEndpointId,
  removeOwnedEndpoint,
} from "./runtime-directory.js";
import {
  closeSocketServer,
  isDeadEndpointError,
  listenSocketServer,
  readBoundedHandleUtf8,
  readBoundedUtf8,
  requestFrame,
  writeFrame,
} from "./transport-io.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_DISCOVERY_DEADLINE_MS = 2_000;
const DEFAULT_DISCOVERY_PROBE_TIMEOUT_MS = 500;
const MAX_DISCOVERY_MANIFESTS = 64;
const MAX_DISCOVERY_CONCURRENCY = 16;
const MAX_DISCOVERY_ISSUES = 32;
const MAX_PENDING_CONNECTIONS = 32;
const MAX_INFLIGHT_DELIVERIES = 8;
const MESSAGE_DEDUP_CAPACITY = 1_024;
const MESSAGE_DEDUP_TTL_MS = 10 * 60_000;
const FRAME_REPLAY_CAPACITY = 2_048;
const FRAME_REPLAY_TTL_MS = 2 * 60_000;
const MAX_REQUESTS_PER_MINUTE = 60;
const MAX_TOTAL_REQUESTS_PER_MINUTE = 240;
const RATE_WINDOW_MS = 60_000;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface FleetTransportOptions {
  group: FleetGroup;
  peer: FleetLocalPeerDescription;
  baseDirectory?: string;
  endpointId?: string;
  requestTimeoutMs?: number;
  discoveryDeadlineMs?: number;
  discoveryProbeTimeoutMs?: number;
  kickoffCapability?: string;
  onMessage(message: FleetMessage, signal: AbortSignal): Promise<void> | void;
  seenMessageIds?: readonly string[];
  kickoffConsumed?: boolean;
  now?: () => number;
}

export interface FleetSendAuthorization {
  kickoffCapability: string;
}

export interface FleetDeliveryAck {
  accepted: boolean;
  duplicate: boolean;
  code?: FleetAckCode;
  error?: string;
  retryAfterMs?: number;
}

export type FleetDiscoveryIssueCode =
  | "deadline_exceeded"
  | "identity_conflict"
  | "invalid_manifest"
  | "peer_unreachable"
  | "protocol_error"
  | "scan_saturated";

export interface FleetDiscoveryIssue {
  code: FleetDiscoveryIssueCode;
  sessionId?: string;
  endpointId?: string;
}

export interface FleetDiscoveryResult {
  peers: FleetPeerDescription[];
  issues: FleetDiscoveryIssue[];
  scannedEntries: number;
  saturated: boolean;
}

interface ManifestRecord {
  manifest: SignedEndpointManifest;
  manifestPath: string;
  socketPath: string;
  raw: string;
  socketIdentity?: { dev: bigint; ino: bigint };
}

interface ManifestReadResult {
  records: ManifestRecord[];
  issues: FleetDiscoveryIssue[];
  scannedEntries: number;
  saturated: boolean;
}

export class FleetTransport {
  private server?: Server;
  private paths?: EndpointPaths;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private stopped = false;
  private ownsEndpointFiles = false;
  private readonly lifecycle = new AbortController();
  private readonly sockets = new Set<Socket>();
  private readonly pendingTasks = new Set<Promise<void>>();
  private readonly frameReplay = new ReplayWindow(FRAME_REPLAY_CAPACITY, FRAME_REPLAY_TTL_MS);
  private readonly responseReplay = new ReplayWindow(FRAME_REPLAY_CAPACITY, FRAME_REPLAY_TTL_MS);
  private readonly messageDedup = new ReplayWindow(MESSAGE_DEDUP_CAPACITY, MESSAGE_DEDUP_TTL_MS);
  private readonly senderRateLimiter = new FixedWindowRateLimiter(
    MAX_REQUESTS_PER_MINUTE,
    RATE_WINDOW_MS,
    MAX_DISCOVERY_MANIFESTS,
  );
  private readonly totalRateLimiter = new FixedWindowRateLimiter(MAX_TOTAL_REQUESTS_PER_MINUTE, RATE_WINDOW_MS, 1);
  private readonly peer: FleetPeerDescription;
  private kickoffConsumed = false;
  private kickoffPending = false;
  private inflightDeliveries = 0;
  private readonly pendingMessageIds = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: FleetTransportOptions) {
    if (process.platform === "win32") {
      throw new Error("Pi Fleet local transport requires a POSIX platform");
    }
    if (options.group.secret.length !== 32) throw new Error("Pi Fleet group secret is invalid");
    if (options.requestTimeoutMs !== undefined) {
      assertPositiveDuration(options.requestTimeoutMs, "Pi Fleet request timeout");
    }
    if (options.discoveryDeadlineMs !== undefined) {
      assertPositiveDuration(options.discoveryDeadlineMs, "Pi Fleet discovery deadline");
    }
    if (options.discoveryProbeTimeoutMs !== undefined) {
      assertPositiveDuration(options.discoveryProbeTimeoutMs, "Pi Fleet discovery probe timeout");
    }
    if (!SAFE_SESSION_ID.test(options.peer.sessionId)) {
      throw new Error("Pi Fleet local session id is invalid");
    }
    if (options.peer.protocolVersion !== FLEET_PROTOCOL_VERSION) {
      throw new Error("Pi Fleet local protocol version is invalid");
    }
    const endpointId = options.endpointId ?? randomEndpointId();
    this.peer = validatePeerDescription({ ...options.peer, endpointId });
    if (
      (options.kickoffCapability !== undefined && !SAFE_SESSION_ID.test(options.kickoffCapability)) ||
      Boolean(this.peer.launchId) !== Boolean(options.kickoffCapability)
    ) {
      throw new Error("Pi Fleet local kickoff capability is invalid");
    }
    this.now = options.now ?? Date.now;
    this.kickoffConsumed = options.kickoffConsumed === true;
    for (const id of options.seenMessageIds ?? []) {
      if (SAFE_SESSION_ID.test(id)) this.messageDedup.accept(id, this.now());
    }
  }

  setAcceptsRequests(value: boolean): void {
    this.peer.acceptsRequests = value;
  }

  get peerDescription(): FleetPeerDescription {
    return { ...this.peer };
  }

  get endpointManifest(): (EndpointPaths & { peer: FleetPeerDescription }) | undefined {
    return this.paths ? { ...this.paths, peer: { ...this.peer } } : undefined;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.stopped) throw new Error("Pi Fleet transport has already stopped");
    if (this.startPromise) return this.startPromise;
    throwIfAborted(signal, "Pi Fleet transport start aborted");
    const operationSignal = combineSignals(signal, this.lifecycle.signal);
    this.startPromise = this.startOwned(operationSignal).catch(async (error) => {
      await this.cleanup();
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  async discover(
    signal?: AbortSignal,
    deadlineMs = this.options.discoveryDeadlineMs ?? DEFAULT_DISCOVERY_DEADLINE_MS,
  ): Promise<FleetDiscoveryResult> {
    this.assertStarted();
    throwIfAborted(signal, "Pi Fleet peer discovery aborted");
    assertPositiveDuration(deadlineMs, "Pi Fleet discovery deadline");
    const deadline = deadlineSignal(deadlineMs, "Pi Fleet peer discovery deadline exceeded");
    const operationSignal = combineSignals(signal, this.lifecycle.signal, deadline.signal);
    try {
      const manifestResult = await this.readManifests(operationSignal);
      const issues = [...manifestResult.issues];
      const discovered: Array<{ peer: FleetPeerDescription; record: ManifestRecord }> = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < manifestResult.records.length && !operationSignal.aborted) {
          const index = cursor;
          cursor += 1;
          const record = manifestResult.records[index];
          if (!record || record.manifest.endpointId === this.peer.endpointId) continue;
          try {
            const response = await this.request(
              record,
              { kind: "describe" },
              operationSignal,
              this.options.discoveryProbeTimeoutMs ?? DEFAULT_DISCOVERY_PROBE_TIMEOUT_MS,
            );
            if (response.payload.kind !== "description") {
              throw new Error("Pi Fleet peer returned an invalid description response");
            }
            assertDescriptionMatchesManifest(response.payload.peer, record);
            if (response.payload.peer.sessionId === this.peer.sessionId) {
              addIssue(issues, {
                code: "identity_conflict",
                sessionId: this.peer.sessionId,
                endpointId: response.payload.peer.endpointId,
              });
              continue;
            }
            discovered.push({ peer: response.payload.peer, record });
          } catch (error) {
            if (signal?.aborted || this.lifecycle.signal.aborted) throw error;
            if (deadline.signal.aborted) break;
            if (isDeadEndpointError(error)) {
              addIssue(issues, {
                code: "peer_unreachable",
                sessionId: record.manifest.sessionId,
                endpointId: record.manifest.endpointId,
              });
              await this.removeStaleRecord(record);
            } else if (!isAbortError(error)) {
              addIssue(issues, {
                code: "protocol_error",
                sessionId: record.manifest.sessionId,
                endpointId: record.manifest.endpointId,
              });
            }
          }
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(MAX_DISCOVERY_CONCURRENCY, manifestResult.records.length),
          },
          () => worker(),
        ),
      );
      if (signal?.aborted || this.lifecycle.signal.aborted) {
        throw abortError("Pi Fleet peer discovery aborted");
      }
      if (deadline.signal.aborted) addIssue(issues, { code: "deadline_exceeded" });
      const peers: FleetPeerDescription[] = [];
      const bySession = new Map<string, Array<{ peer: FleetPeerDescription; record: ManifestRecord }>>();
      for (const item of discovered) {
        const matches = bySession.get(item.peer.sessionId) ?? [];
        matches.push(item);
        bySession.set(item.peer.sessionId, matches);
      }
      for (const [sessionId, matches] of bySession) {
        if (matches.length === 1 && matches[0]) {
          peers.push(matches[0].peer);
          continue;
        }
        addIssue(issues, { code: "identity_conflict", sessionId });
      }
      return {
        peers: peers.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
        issues,
        scannedEntries: manifestResult.scannedEntries,
        saturated: manifestResult.saturated,
      };
    } finally {
      deadline.dispose();
    }
  }

  async listPeers(signal?: AbortSignal, deadlineMs?: number): Promise<FleetPeerDescription[]> {
    return (await this.discover(signal, deadlineMs)).peers;
  }

  async send(
    targetSessionId: string,
    value: FleetMessage,
    signal?: AbortSignal,
    authorization?: FleetSendAuthorization,
  ): Promise<FleetDeliveryAck> {
    this.assertStarted();
    throwIfAborted(signal, "Pi Fleet message send aborted");
    if (!SAFE_SESSION_ID.test(targetSessionId)) {
      throw new Error("Pi Fleet target session id is invalid");
    }
    const message = validateMessage(value);
    validateMessageTiming(message, this.now());
    if (message.fromSessionId !== this.peer.sessionId) {
      throw new Error("Pi Fleet message sender does not match the local session");
    }
    if (message.toSessionId !== targetSessionId) {
      throw new Error("Pi Fleet message target does not match the selected session");
    }
    if (authorization && message.mode !== "kickoff") {
      throw new Error("Pi Fleet kickoff authorization is invalid for this message mode");
    }
    if (authorization && !SAFE_SESSION_ID.test(authorization.kickoffCapability)) {
      throw new Error("Pi Fleet kickoff authorization is invalid");
    }
    const manifestResult = await this.readManifests(signal);
    throwIfAborted(signal, "Pi Fleet message send aborted");
    const candidates = manifestResult.records.filter(({ manifest }) => manifest.sessionId === targetSessionId);
    if (candidates.length === 0) {
      throw new Error(`Pi Fleet session ${targetSessionId} is unavailable`);
    }
    const record =
      candidates.length === 1 ? candidates[0] : await this.resolveUniqueTarget(targetSessionId, candidates, signal);
    if (!record) throw new Error(`Pi Fleet session ${targetSessionId} is unavailable`);
    let response: SignedFleetFrame;
    try {
      response = await this.request(
        record,
        {
          kind: "message",
          message,
          ...(authorization ? { kickoffCapability: authorization.kickoffCapability } : {}),
        },
        signal,
      );
    } catch (error) {
      if (isDeadEndpointError(error)) await this.removeStaleRecord(record);
      throw error;
    }
    if (response.payload.kind !== "ack") {
      throw new Error("Pi Fleet peer returned an invalid delivery acknowledgement");
    }
    return deliveryAck(response.payload);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.lifecycle.abort();
    const start = this.startPromise;
    this.stopPromise = (async () => {
      await start?.catch(() => undefined);
      await this.cleanup();
    })();
    return this.stopPromise;
  }

  private async startOwned(signal?: AbortSignal): Promise<void> {
    const directory = await ensureGroupRuntimeDirectory(this.options.group.id, {
      ...(this.options.baseDirectory ? { baseDirectory: this.options.baseDirectory } : {}),
    });
    await cleanupStaleRuntimeEntries(directory, this.now());
    throwIfAborted(signal, "Pi Fleet transport start aborted");
    const paths = createEndpointPaths(directory, this.peer.endpointId);
    await assertEndpointPathsAvailable(paths);
    const server = createServer((socket) => this.acceptSocket(socket));
    this.server = server;
    this.paths = paths;
    await listenSocketServer(server, paths.socketPath, signal);
    this.ownsEndpointFiles = true;
    await chmod(paths.socketPath, 0o600);
    throwIfAborted(signal, "Pi Fleet transport start aborted");
    await publishManifest(
      paths.manifestPath,
      createSignedEndpointManifest(
        {
          groupId: this.options.group.id,
          endpointId: this.peer.endpointId,
          sessionId: this.peer.sessionId,
          socketName: basename(paths.socketPath),
          pid: this.peer.pid,
          publishedAt: this.now(),
        },
        this.options.group.secret,
      ),
    );
    throwIfAborted(signal, "Pi Fleet transport start aborted");
  }

  private acceptSocket(socket: Socket): void {
    if (
      this.stopped ||
      this.sockets.size >= MAX_PENDING_CONNECTIONS ||
      this.pendingTasks.size >= MAX_PENDING_CONNECTIONS
    ) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const connection = new AbortController();
    const timer = setTimeout(() => {
      connection.abort();
      socket.destroy();
    }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    timer.unref();
    let handled = false;
    const decoder = new JsonLineDecoder({
      onValue: (value) => {
        if (handled) {
          socket.destroy();
          return;
        }
        handled = true;
        const task = this.handleIncoming(socket, value, connection.signal);
        this.pendingTasks.add(task);
        void task.then(
          () => this.pendingTasks.delete(task),
          () => this.pendingTasks.delete(task),
        );
      },
      onError: () => socket.destroy(),
    });
    socket.on("data", (chunk) => decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    socket.on("end", () => decoder.finish());
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      connection.abort();
      this.sockets.delete(socket);
    });
  }

  private async handleIncoming(socket: Socket, value: unknown, signal: AbortSignal): Promise<void> {
    try {
      const now = this.now();
      const frame = verifySignedFrame(value, this.options.group.secret, {
        expectedGroupId: this.options.group.id,
        expectedTargetSessionId: this.peer.sessionId,
        expectedTargetEndpointId: this.peer.endpointId,
        now,
        replay: this.frameReplay,
      });
      const totalAccepted = this.totalRateLimiter.accept("all", now);
      const senderAccepted = this.senderRateLimiter.accept(frame.senderSessionId, now);
      if (!totalAccepted || !senderAccepted) {
        const retryAfterMs = Math.max(
          totalAccepted ? 0 : this.totalRateLimiter.retryAfterMs("all", now),
          senderAccepted ? 0 : this.senderRateLimiter.retryAfterMs(frame.senderSessionId, now),
        );
        await this.respond(socket, frame, {
          kind: "ack",
          status: "busy",
          code: "rate_limited",
          error: "Target session rate limit exceeded",
          retryAfterMs,
        });
        return;
      }
      if (frame.payload.kind === "describe") {
        await this.respond(socket, frame, { kind: "description", peer: this.peer });
        return;
      }
      if (frame.payload.kind !== "message") throw new Error("Unsupported Pi Fleet request payload");
      const message = frame.payload.message;
      validateMessageTiming(message, now);
      if (message.fromSessionId !== frame.senderSessionId || message.toSessionId !== this.peer.sessionId) {
        throw new Error("Pi Fleet message identity does not match its authenticated frame");
      }
      if (this.messageDedup.has(message.id, now)) {
        await this.respond(socket, frame, { kind: "ack", status: "duplicate" });
        return;
      }
      const policyError = this.messagePolicyError(message, frame.payload.kickoffCapability);
      if (policyError) {
        await this.respond(socket, frame, policyError);
        return;
      }
      if (this.pendingMessageIds.has(message.id) || this.inflightDeliveries >= MAX_INFLIGHT_DELIVERIES) {
        await this.respond(socket, frame, {
          kind: "ack",
          status: "busy",
          code: "target_busy",
          error: this.pendingMessageIds.has(message.id)
            ? "Target session is still delivering this message"
            : "Target session has too many in-flight deliveries",
        });
        return;
      }
      this.pendingMessageIds.add(message.id);
      this.inflightDeliveries += 1;
      if (message.mode === "kickoff") this.kickoffPending = true;
      try {
        const deliverySignal = combineSignals(signal, this.lifecycle.signal);
        await raceWithSignal(
          Promise.resolve(this.options.onMessage(message, deliverySignal)),
          deliverySignal,
          "Pi Fleet message delivery aborted",
        );
        this.messageDedup.record(message.id, this.now());
        if (message.mode === "kickoff") this.kickoffConsumed = true;
      } catch {
        if (signal.aborted || this.lifecycle.signal.aborted) throw abortError("Delivery aborted");
        await this.respond(socket, frame, {
          kind: "ack",
          status: "rejected",
          code: "delivery_failed",
          error: "Target session rejected the message",
        });
        return;
      } finally {
        this.pendingMessageIds.delete(message.id);
        this.inflightDeliveries -= 1;
        if (message.mode === "kickoff") this.kickoffPending = false;
      }
      await this.respond(socket, frame, { kind: "ack", status: "accepted" });
    } catch {
      socket.destroy();
    }
  }

  private messagePolicyError(message: FleetMessage, kickoffCapability?: string): FleetAckPayload | undefined {
    if (message.mode === "request" && !this.peer.acceptsRequests) {
      return {
        kind: "ack",
        status: "rejected",
        code: "requests_disabled",
        error: "Target session does not allow agent requests",
      };
    }
    if (message.mode === "kickoff") {
      if (
        !this.peer.launchId ||
        message.launchId !== this.peer.launchId ||
        !secretEqual(kickoffCapability, this.options.kickoffCapability)
      ) {
        return {
          kind: "ack",
          status: "rejected",
          code: "launch_mismatch",
          error: "Launch kickoff does not match the target session",
        };
      }
      if (this.kickoffConsumed || this.kickoffPending) {
        return {
          kind: "ack",
          status: "rejected",
          code: "kickoff_consumed",
          error: "Launch kickoff has already been consumed",
        };
      }
    }
    return undefined;
  }

  private async respond(
    socket: Socket,
    request: SignedFleetFrame,
    payload: SignedFleetFrame["payload"],
  ): Promise<void> {
    const response = createSignedFrame(
      {
        groupId: this.options.group.id,
        requestId: request.requestId,
        targetSessionId: request.senderSessionId,
        targetEndpointId: request.senderEndpointId,
        senderSessionId: this.peer.sessionId,
        senderEndpointId: this.peer.endpointId,
        issuedAt: this.now(),
        nonce: randomId("nonce"),
        payload,
      },
      this.options.group.secret,
    );
    await writeFrame(socket, response);
    socket.end();
  }

  private async readManifests(signal?: AbortSignal): Promise<ManifestReadResult> {
    const paths = this.paths;
    if (!paths) throw new Error("Pi Fleet transport is not started");
    throwIfAborted(signal, "Pi Fleet peer discovery aborted");
    const records: ManifestRecord[] = [];
    const issues: FleetDiscoveryIssue[] = [];
    let scannedEntries = 0;
    let saturated = false;
    const directory = await opendir(paths.directory);
    try {
      for await (const entry of directory) {
        throwIfAborted(signal, "Pi Fleet peer discovery aborted");
        if (scannedEntries >= MAX_RUNTIME_SCAN_ENTRIES) {
          saturated = true;
          addIssue(issues, { code: "scan_saturated" });
          break;
        }
        scannedEntries += 1;
        if (!entry.isFile()) continue;
        const endpointId = endpointIdFromManifestName(entry.name);
        if (!endpointId) {
          if (entry.name.endsWith(".json")) addIssue(issues, { code: "invalid_manifest" });
          continue;
        }
        if (records.length >= MAX_DISCOVERY_MANIFESTS) {
          saturated = true;
          addIssue(issues, { code: "scan_saturated" });
          continue;
        }
        try {
          records.push(
            await readManifest(paths.directory, resolve(paths.directory, entry.name), endpointId, this.options.group),
          );
        } catch {
          addIssue(issues, { code: "invalid_manifest", endpointId });
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    throwIfAborted(signal, "Pi Fleet peer discovery aborted");
    records.sort((left, right) => left.manifest.endpointId.localeCompare(right.manifest.endpointId));
    return { records, issues, scannedEntries, saturated };
  }

  private async request(
    record: ManifestRecord,
    payload: SignedFleetFrame["payload"],
    signal?: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<SignedFleetFrame> {
    throwIfAborted(signal, "Pi Fleet request aborted");
    const requestId = randomId("req");
    const frame = createSignedFrame(
      {
        groupId: this.options.group.id,
        requestId,
        targetSessionId: record.manifest.sessionId,
        targetEndpointId: record.manifest.endpointId,
        senderSessionId: this.peer.sessionId,
        senderEndpointId: this.peer.endpointId,
        issuedAt: this.now(),
        nonce: randomId("nonce"),
        payload,
      },
      this.options.group.secret,
    );
    const value = await requestFrame(record.socketPath, frame, signal, timeoutMs);
    throwIfAborted(signal, "Pi Fleet request aborted");
    const response = verifySignedFrame(value, this.options.group.secret, {
      expectedGroupId: this.options.group.id,
      expectedTargetSessionId: this.peer.sessionId,
      expectedTargetEndpointId: this.peer.endpointId,
      now: this.now(),
      replay: this.responseReplay,
    });
    if (
      response.requestId !== requestId ||
      response.senderSessionId !== record.manifest.sessionId ||
      response.senderEndpointId !== record.manifest.endpointId
    ) {
      throw new Error("Pi Fleet response identity does not match its request");
    }
    return response;
  }

  private async resolveUniqueTarget(
    targetSessionId: string,
    candidates: ManifestRecord[],
    signal?: AbortSignal,
  ): Promise<ManifestRecord | undefined> {
    const live: ManifestRecord[] = [];
    await Promise.all(
      candidates.map(async (record) => {
        try {
          const response = await this.request(
            record,
            { kind: "describe" },
            signal,
            this.options.discoveryProbeTimeoutMs ?? DEFAULT_DISCOVERY_PROBE_TIMEOUT_MS,
          );
          if (response.payload.kind !== "description") return;
          assertDescriptionMatchesManifest(response.payload.peer, record);
          live.push(record);
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (isDeadEndpointError(error)) await this.removeStaleRecord(record);
        }
      }),
    );
    if (live.length > 1) {
      throw new Error(`Pi Fleet session ${targetSessionId} has conflicting live endpoints`);
    }
    return live[0];
  }

  private async removeStaleRecord(record: ManifestRecord): Promise<void> {
    try {
      const current = await readBoundedUtf8(record.manifestPath, MAX_MANIFEST_BYTES);
      if (current !== record.raw) return;
      await rm(record.manifestPath, { force: true });
      if (record.socketIdentity) {
        const info = await lstat(record.socketPath, { bigint: true }).catch(() => undefined);
        if (info?.isSocket() && info.dev === record.socketIdentity.dev && info.ino === record.socketIdentity.ino) {
          await rm(record.socketPath, { force: true });
        }
      }
    } catch {
      // A concurrent owner change wins over stale cleanup.
    }
  }

  private assertStarted(): void {
    if (!this.startPromise || !this.paths || this.stopped) {
      throw new Error("Pi Fleet transport is not started");
    }
  }

  private async cleanup(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await closeSocketServer(server);
    await Promise.allSettled([...this.pendingTasks]);
    this.pendingTasks.clear();
    this.pendingMessageIds.clear();
    this.kickoffPending = false;
    this.inflightDeliveries = 0;
    const paths = this.paths;
    if (paths && this.ownsEndpointFiles) await removeOwnedEndpoint(paths);
    this.ownsEndpointFiles = false;
    this.paths = undefined;
  }
}

async function assertEndpointPathsAvailable(paths: EndpointPaths): Promise<void> {
  for (const path of [paths.manifestPath, paths.socketPath]) {
    try {
      await lstat(path);
      throw new Error("Pi Fleet endpoint identity is already in use");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

async function readManifest(
  directory: string,
  manifestPath: string,
  endpointId: string,
  group: FleetGroup,
): Promise<ManifestRecord> {
  assertOwnedPath(directory, manifestPath, ".json");
  const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(MAX_MANIFEST_BYTES)) {
      throw new Error("Pi Fleet endpoint manifest is invalid");
    }
    if (typeof process.getuid === "function" && Number(info.uid) !== process.getuid()) {
      throw new Error("Pi Fleet endpoint manifest has another owner");
    }
    if ((Number(info.mode) & 0o777) !== 0o600) {
      throw new Error("Pi Fleet endpoint manifest permissions are not private");
    }
    const raw = await readBoundedHandleUtf8(handle, MAX_MANIFEST_BYTES);
    const manifest = verifySignedEndpointManifest(JSON.parse(raw) as unknown, group.secret, {
      expectedGroupId: group.id,
      expectedEndpointId: endpointId,
    });
    const socketPath = join(directory, manifest.socketName);
    if (dirname(resolve(socketPath)) !== resolve(directory)) {
      throw new Error("Pi Fleet endpoint socket path is invalid");
    }
    const socketInfo = await lstat(socketPath, { bigint: true }).catch(() => undefined);
    if (socketInfo) {
      if (!socketInfo.isSocket()) throw new Error("Pi Fleet endpoint path is not a Unix socket");
      if (typeof process.getuid === "function" && Number(socketInfo.uid) !== process.getuid()) {
        throw new Error("Pi Fleet endpoint socket has another owner");
      }
      if ((Number(socketInfo.mode) & 0o777) !== 0o600) {
        throw new Error("Pi Fleet endpoint socket permissions are not private");
      }
    }
    return {
      manifest,
      manifestPath,
      socketPath,
      raw,
      ...(socketInfo ? { socketIdentity: { dev: socketInfo.dev, ino: socketInfo.ino } } : {}),
    };
  } finally {
    await handle.close();
  }
}

function assertDescriptionMatchesManifest(peer: FleetPeerDescription, record: ManifestRecord): void {
  if (
    peer.sessionId !== record.manifest.sessionId ||
    peer.endpointId !== record.manifest.endpointId ||
    peer.pid !== record.manifest.pid
  ) {
    throw new Error("Pi Fleet peer identity does not match its endpoint manifest");
  }
}

function deliveryAck(payload: FleetAckPayload): FleetDeliveryAck {
  return {
    accepted: payload.status === "accepted" || payload.status === "duplicate",
    duplicate: payload.status === "duplicate",
    ...(payload.code ? { code: payload.code } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.retryAfterMs !== undefined ? { retryAfterMs: payload.retryAfterMs } : {}),
  };
}

function addIssue(issues: FleetDiscoveryIssue[], issue: FleetDiscoveryIssue): void {
  if (issues.length >= MAX_DISCOVERY_ISSUES) return;
  if (
    issues.some(
      (existing) =>
        existing.code === issue.code &&
        existing.sessionId === issue.sessionId &&
        existing.endpointId === issue.endpointId,
    )
  ) {
    return;
  }
  issues.push(issue);
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const concrete = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return concrete.length === 0
    ? new AbortController().signal
    : concrete.length === 1
      ? concrete[0]
      : AbortSignal.any(concrete);
}

function deadlineSignal(milliseconds: number, message: string): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(abortError(message)), milliseconds);
  timer.unref();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function secretEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function raceWithSignal<T>(task: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(message));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => settle(() => rejectPromise(abortError(message)));
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (value) => settle(() => resolvePromise(value)),
      (error) => settle(() => rejectPromise(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw abortError(message);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${label} is invalid`);
}
