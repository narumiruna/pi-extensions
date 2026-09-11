import { randomBytes, randomUUID } from "node:crypto";
import net, { type AddressInfo, type Server, type Socket } from "node:net";
import type { BrokerCredentials } from "./types.js";

export const BROKER_HOST = "127.0.0.1" as const;
export const MAX_MESSAGE_BYTES = 48 * 1024;
export const MAX_MESSAGE_LINES = 1_992;
export const MAX_FRAME_BYTES = 384 * 1024;
export const MAX_ERROR_BYTES = 8 * 1024;
export const MAX_OUTSTANDING_REQUESTS = 4;
export const MAX_IDENTIFIER_LENGTH = 128;

const MAX_CONNECTIONS = 32;
const REQUEST_FRAME_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_RETAINED_CONSUMED_REQUESTS = 4;
const CHILD_WAIT_INTERRUPTED_ERROR =
  "Subagent wait was interrupted by an incoming main-agent request. The original request remains active.";

export type BrokerRequestOrigin = "main" | "child";

export interface BrokerInboundMessage {
  kind: "request" | "response";
  requestId: string;
  jobId: string;
  message: string;
}

export interface BrokerSendAcknowledgement {
  requestId: string;
  accepted: boolean;
  duplicate: boolean;
}

export interface MessageBrokerOptions {
  onMessage(message: BrokerInboundMessage): void;
  createServer?: (listener: (socket: Socket) => void) => Server;
  now?: () => number;
  requestFrameTimeoutMs?: number;
}

interface JobRecord {
  jobId: string;
  generation: number;
  token: string;
}

interface RequestWaiter {
  socket: Socket;
  timer?: NodeJS.Timeout;
}

interface RequestRecord {
  requestId: string;
  jobId: string;
  generation: number;
  origin: BrokerRequestOrigin;
  expectedResponder: BrokerRequestOrigin;
  message: string;
  createdAt: number;
  response?: string;
  consumedAt?: number;
  deliveryQueued?: boolean;
  waiter?: RequestWaiter;
}

type BrokerRequest =
  | {
      type: "send";
      token: string;
      recipient?: string;
      requestId?: string;
      message: string;
    }
  | { type: "wait"; token: string; requestId: string; timeoutMs?: number };

/** Session-scoped authenticated loopback transport for bidirectional requests and responses. */
export class MessageBroker {
  private server?: Server;
  private starting?: Promise<void>;
  private address?: { host: typeof BROKER_HOST; port: number };
  private failure?: string;
  private generation = 0;
  private readonly sockets = new Set<Socket>();
  private readonly jobsByToken = new Map<string, JobRecord>();
  private readonly tokenByJob = new Map<string, string>();
  private readonly requests = new Map<string, RequestRecord>();
  private readonly inboundMessageListeners = new Set<() => void>();
  private pendingInboundResponse = false;
  private readonly createServer: (listener: (socket: Socket) => void) => Server;
  private readonly now: () => number;
  private readonly requestFrameTimeoutMs: number;

  constructor(private readonly options: MessageBrokerOptions) {
    this.createServer = options.createServer ?? ((listener) => net.createServer(listener));
    this.now = options.now ?? Date.now;
    this.requestFrameTimeoutMs = options.requestFrameTimeoutMs ?? REQUEST_FRAME_TIMEOUT_MS;
    if (!Number.isFinite(this.requestFrameTimeoutMs) || this.requestFrameTimeoutMs <= 0) {
      throw new Error("Subagent broker frame timeout must be positive.");
    }
  }

  async start(): Promise<void> {
    if (this.server && this.address && !this.failure) return;
    if (this.starting) return this.starting;
    const ownerGeneration = ++this.generation;
    this.failure = undefined;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = this.createServer((socket) => this.accept(socket));
      server.maxConnections = MAX_CONNECTIONS;
      const onStartError = (error: Error) => {
        server.close(() => undefined);
        reject(error);
      };
      server.once("error", onStartError);
      server.listen({ host: BROKER_HOST, port: 0 }, () => {
        server.off("error", onStartError);
        if (ownerGeneration !== this.generation) {
          server.close(() => undefined);
          reject(new Error("Subagent message broker start was superseded."));
          return;
        }
        const address = server.address();
        if (!isLoopbackAddress(address)) {
          server.close(() => undefined);
          reject(new Error("Subagent message broker did not bind to loopback."));
          return;
        }
        this.server = server;
        this.address = { host: BROKER_HOST, port: address.port };
        server.on("error", (error) => this.fail(error));
        server.unref();
        resolve();
      });
    })
      .catch((error) => {
        const message = truncateError(error instanceof Error ? error.message : String(error));
        this.failure = message;
        throw new Error(`Subagent message broker failed to start: ${message}`);
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  assertReady(): void {
    if (this.server && this.address && !this.failure) return;
    throw new Error(
      this.failure
        ? `Subagent messaging is unavailable: ${this.failure}`
        : "Subagent messaging is unavailable because the session broker is not ready.",
    );
  }

  issueCredentials(input: { jobId: string; generation: number }): BrokerCredentials {
    this.assertReady();
    if (this.tokenByJob.has(input.jobId)) {
      throw new Error(`Subagent messaging credentials already exist for ${input.jobId}.`);
    }
    const token = randomBytes(32).toString("hex");
    const record: JobRecord = { ...input, token };
    this.jobsByToken.set(token, record);
    this.tokenByJob.set(input.jobId, token);
    return { host: BROKER_HOST, port: this.address?.port ?? 0, token };
  }

  createMainRequest(jobId: string, message: string): BrokerSendAcknowledgement {
    this.assertReady();
    const job = this.requireJob(jobId);
    return this.createRequest(job, "main", message);
  }

  replyFromMain(requestId: string, message: string): BrokerSendAcknowledgement {
    this.assertReady();
    return this.acceptResponse("main", undefined, requestId, message);
  }

  rollbackMainRequest(requestId: string): void {
    const request = this.requests.get(requestId);
    if (request?.origin === "main" && request.response === undefined) {
      this.clearWaiter(request);
      this.requests.delete(requestId);
    }
  }

  revokeJob(jobId: string, reason = "Subagent job is no longer active."): void {
    const token = this.tokenByJob.get(jobId);
    if (token) {
      this.tokenByJob.delete(jobId);
      this.jobsByToken.delete(token);
    }
    for (const request of [...this.requests.values()]) {
      if (request.jobId !== jobId) continue;
      if (request.waiter) this.respondError(request.waiter.socket, reason);
      this.clearWaiter(request);
      this.requests.delete(request.requestId);
    }
  }

  hasPendingMainRequest(): boolean {
    return [...this.requests.values()].some((request) => request.origin === "child" && request.response === undefined);
  }

  takePendingInboundResponse(): boolean {
    const pending = this.pendingInboundResponse;
    this.pendingInboundResponse = false;
    return pending;
  }

  markMainRequestQueued(requestId: string): boolean {
    const request = this.requests.get(requestId);
    if (request?.origin !== "main") {
      throw new Error("Unknown or expired main-agent subagent request.");
    }
    request.deliveryQueued = true;
    return request.response === undefined;
  }

  interruptChildWaits(jobId: string): number {
    let interrupted = 0;
    for (const request of this.requests.values()) {
      if (request.jobId !== jobId || request.origin !== "child" || !request.waiter) continue;
      const socket = request.waiter.socket;
      this.clearWaiter(request);
      this.respondError(socket, CHILD_WAIT_INTERRUPTED_ERROR);
      interrupted++;
    }
    return interrupted;
  }

  subscribeInboundMessage(listener: () => void): () => void {
    this.inboundMessageListeners.add(listener);
    if (this.hasPendingMainRequest()) listener();
    return () => this.inboundMessageListeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    ++this.generation;
    const starting = this.starting;
    if (starting) await starting.catch(() => undefined);
    for (const jobId of [...this.tokenByJob.keys()]) {
      this.revokeJob(jobId, "Subagent session shut down.");
    }
    this.requests.clear();
    this.inboundMessageListeners.clear();
    this.pendingInboundResponse = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    this.failure = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private requireJob(jobId: string): JobRecord {
    const token = this.tokenByJob.get(jobId);
    const job = token ? this.jobsByToken.get(token) : undefined;
    if (!job) throw new Error("Unknown or inactive subagent job.");
    return job;
  }

  private hasQueuedRequestForChild(jobId: string): boolean {
    return [...this.requests.values()].some(
      (request) =>
        request.jobId === jobId &&
        request.origin === "main" &&
        request.deliveryQueued === true &&
        request.response === undefined,
    );
  }

  private createRequest(job: JobRecord, origin: BrokerRequestOrigin, message: string): BrokerSendAcknowledgement {
    validateMessage(message, "Subagent request");
    const outstanding = [...this.requests.values()].filter(
      (request) => request.jobId === job.jobId && request.consumedAt === undefined,
    ).length;
    if (outstanding >= MAX_OUTSTANDING_REQUESTS) {
      throw new Error(`Subagent job may have at most ${MAX_OUTSTANDING_REQUESTS} outstanding requests.`);
    }
    const request: RequestRecord = {
      requestId: `req_${randomUUID()}`,
      jobId: job.jobId,
      generation: job.generation,
      origin,
      expectedResponder: origin === "main" ? "child" : "main",
      message,
      createdAt: this.now(),
    };
    this.requests.set(request.requestId, request);
    if (origin === "child") {
      try {
        this.deliverInbound({
          kind: "request",
          requestId: request.requestId,
          jobId: request.jobId,
          message: request.message,
        });
      } catch (error) {
        this.requests.delete(request.requestId);
        throw error;
      }
    }
    return { requestId: request.requestId, accepted: true, duplicate: false };
  }

  private acceptResponse(
    responder: BrokerRequestOrigin,
    job: JobRecord | undefined,
    requestId: string,
    message: string,
  ): BrokerSendAcknowledgement {
    validateRequestId(requestId);
    validateMessage(message, "Subagent response");
    const request = this.requests.get(requestId);
    if (
      !request ||
      request.expectedResponder !== responder ||
      (job && (request.jobId !== job.jobId || request.generation !== job.generation))
    ) {
      throw new Error("Unknown, expired, or unauthorized subagent request.");
    }
    if (request.response !== undefined) {
      return { requestId, accepted: false, duplicate: true };
    }
    request.response = message;
    if (responder === "child") {
      try {
        this.deliverInbound({
          kind: "response",
          requestId,
          jobId: request.jobId,
          message,
        });
        this.markConsumed(request);
      } catch (error) {
        request.response = undefined;
        throw error;
      }
    } else if (request.waiter) {
      const socket = request.waiter.socket;
      this.clearWaiter(request);
      this.respond(socket, { ok: true, response: message }, () => this.markConsumed(request));
    }
    return { requestId, accepted: true, duplicate: false };
  }

  private deliverInbound(message: BrokerInboundMessage): void {
    this.options.onMessage(message);
    if (message.kind === "response" && this.inboundMessageListeners.size === 0) {
      this.pendingInboundResponse = true;
    }
    for (const listener of [...this.inboundMessageListeners]) {
      try {
        listener();
      } catch {
        // Runtime wait observers cannot interrupt broker delivery.
      }
    }
  }

  private accept(socket: Socket): void {
    if (!this.server || this.failure || this.sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let frame = Buffer.alloc(0);
    let handled = false;
    const frameTimer = setTimeout(() => {
      if (handled) return;
      handled = true;
      this.respondError(socket, "Subagent broker request frame timed out.");
    }, this.requestFrameTimeoutMs);
    frameTimer.unref();
    const cleanup = () => {
      clearTimeout(frameTimer);
      this.sockets.delete(socket);
      for (const request of this.requests.values()) {
        if (request.waiter?.socket === socket) this.clearWaiter(request);
      }
    };
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      frame = Buffer.concat([frame, chunk]);
      if (frame.byteLength > MAX_FRAME_BYTES) {
        handled = true;
        clearTimeout(frameTimer);
        this.respondError(socket, "Subagent broker request exceeded its size limit.");
        return;
      }
      const newline = frame.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      clearTimeout(frameTimer);
      socket.removeAllListeners("data");
      const trailing = frame
        .subarray(newline + 1)
        .toString("utf8")
        .trim();
      if (trailing) {
        this.respondError(socket, "Subagent broker accepts one request per connection.");
        return;
      }
      this.handleFrame(socket, frame.subarray(0, newline).toString("utf8"));
    });
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  }

  private handleFrame(socket: Socket, frame: string): void {
    let request: BrokerRequest;
    try {
      const parsed = JSON.parse(frame) as unknown;
      if (!isRecord(parsed)) throw new Error();
      request = parsed as BrokerRequest;
    } catch {
      this.respondError(socket, "Malformed subagent broker request.");
      return;
    }
    const job = typeof request.token === "string" ? this.jobsByToken.get(request.token) : undefined;
    if (!job) {
      this.respondError(socket, "Unauthenticated subagent broker request.");
      return;
    }
    try {
      if (request.type === "send") {
        this.handleSend(socket, job, request);
        return;
      }
      if (request.type === "wait") {
        this.handleWait(socket, job, request);
        return;
      }
      throw new Error("Unsupported subagent broker request.");
    } catch (error) {
      this.respondError(socket, error instanceof Error ? error.message : String(error));
    }
  }

  private handleSend(socket: Socket, job: JobRecord, request: Extract<BrokerRequest, { type: "send" }>): void {
    if (typeof request.message !== "string") {
      throw new Error("subagent_send requires a message string.");
    }
    const hasRecipient = typeof request.recipient === "string";
    const hasRequestId = typeof request.requestId === "string";
    if (hasRecipient === hasRequestId) {
      throw new Error("subagent_send requires exactly one of recipient or requestId.");
    }
    const acknowledgement = hasRecipient
      ? request.recipient === "main"
        ? this.createRequest(job, "child", request.message)
        : (() => {
            throw new Error('A subagent may send new requests only to recipient "main".');
          })()
      : this.acceptResponse("child", job, request.requestId ?? "", request.message);
    this.respond(socket, { ok: true, ...acknowledgement });
  }

  private handleWait(socket: Socket, job: JobRecord, request: Extract<BrokerRequest, { type: "wait" }>): void {
    if (typeof request.requestId !== "string") {
      throw new Error("Subagent wait requires a request ID.");
    }
    validateRequestId(request.requestId);
    if (request.timeoutMs !== undefined) validateTimeout(request.timeoutMs);
    const record = this.requests.get(request.requestId);
    if (record?.origin !== "child" || record.jobId !== job.jobId || record.generation !== job.generation) {
      throw new Error("Unknown or expired subagent request.");
    }
    if (record.consumedAt !== undefined && record.response !== undefined) {
      this.respond(socket, { ok: true, response: record.response });
      return;
    }
    if (record.response !== undefined) {
      this.respond(socket, { ok: true, response: record.response }, () => this.markConsumed(record));
      return;
    }
    if (this.hasQueuedRequestForChild(job.jobId)) {
      this.respondError(socket, CHILD_WAIT_INTERRUPTED_ERROR);
      return;
    }
    if (record.waiter) {
      throw new Error(`A wait is already active for subagent request ${request.requestId}.`);
    }
    const waiter: RequestWaiter = { socket };
    record.waiter = waiter;
    if (request.timeoutMs !== undefined) {
      waiter.timer = setTimeout(() => {
        if (record.waiter !== waiter) return;
        this.clearWaiter(record);
        this.respondError(socket, "Subagent response wait timed out.");
      }, request.timeoutMs);
      waiter.timer.unref();
    }
  }

  private markConsumed(request: RequestRecord): void {
    if (this.requests.get(request.requestId) !== request || request.response === undefined) return;
    request.consumedAt ??= this.now();
    const consumed = [...this.requests.values()]
      .filter((candidate) => candidate.jobId === request.jobId && candidate.consumedAt !== undefined)
      .sort((left, right) => (left.consumedAt ?? 0) - (right.consumedAt ?? 0));
    for (const expired of consumed.slice(0, Math.max(0, consumed.length - MAX_RETAINED_CONSUMED_REQUESTS))) {
      this.requests.delete(expired.requestId);
    }
  }

  private clearWaiter(request: RequestRecord): void {
    if (request.waiter?.timer) clearTimeout(request.waiter.timer);
    request.waiter = undefined;
  }

  private respondError(socket: Socket, error: string): void {
    this.respond(socket, { ok: false, error: truncateError(error) });
  }

  private respond(socket: Socket, value: Record<string, unknown>, onFlushed?: () => void): void {
    if (socket.destroyed) return;
    let content = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_FRAME_BYTES) {
      content = `${JSON.stringify({ ok: false, error: "Subagent broker response exceeded its size limit." })}\n`;
    }
    socket.end(content, onFlushed);
  }

  private fail(error: Error): void {
    this.failure = truncateError(error.message);
    for (const jobId of [...this.tokenByJob.keys()]) {
      this.revokeJob(jobId, "Subagent message broker failed.");
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.address = undefined;
  }
}

export function validateMessage(message: string, label: string): void {
  if (!message.trim()) throw new Error(`${label} is required.`);
  if (message.includes("\0")) throw new Error(`${label} must not contain NUL bytes.`);
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`${label} must be at most ${MAX_MESSAGE_BYTES} UTF-8 bytes.`);
  }
  if (lineCount(message) > MAX_MESSAGE_LINES) {
    throw new Error(`${label} must contain at most ${MAX_MESSAGE_LINES} lines.`);
  }
}

export function sanitizeTerminalText(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (character === "\n" || character === "\t") return true;
      if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
      return !((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069));
    })
    .join("");
}

function validateRequestId(requestId: string): void {
  if (
    requestId.length > MAX_IDENTIFIER_LENGTH ||
    !/^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestId)
  ) {
    throw new Error("Invalid subagent request ID.");
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Subagent wait timeout is outside the supported range.");
  }
}

function lineCount(value: string): number {
  let count = 1;
  for (const character of value) if (character === "\n") count++;
  return count;
}

function truncateError(error: string): string {
  const bytes = Buffer.from(error, "utf8");
  if (bytes.length <= MAX_ERROR_BYTES) return error;
  return `${bytes
    .subarray(0, Math.max(0, MAX_ERROR_BYTES - 18))
    .toString("utf8")
    .replace(/�+$/gu, "")}\n… [truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackAddress(address: AddressInfo | string | null): address is AddressInfo {
  return Boolean(address && typeof address !== "string" && address.address === BROKER_HOST);
}
