import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AttachmentError,
	type AttachmentLimits,
	AttachmentStore,
	type PreparedAttachment,
	type PublicAttachmentState,
} from "./attachments.js";
import type { ConversationEvent, ConversationProjection } from "./conversation.js";
import { type BrowserImageInput, DEFAULT_IMAGE_LIMITS } from "./images.js";

const JSON_LIMIT = 64 * 1024 * 1024;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_REQUESTS = 128;
const SSE_FLUSH_TIMEOUT_MS = 250;

export interface WebSendRequest {
	requestId: string;
	text: string;
	attachmentRevision?: number;
	attachmentIds?: string[];
	images: BrowserImageInput[];
	delivery: "next" | "steer";
	signal?: AbortSignal;
}

interface ParsedSendRequest {
	requestId: string;
	text: string;
	attachmentRevision: number;
	attachmentIds: string[];
	delivery: "next" | "steer";
}

export interface WebSendResult {
	delivery: "immediate" | "followUp" | "steer";
}

export interface WebUIServerOptions {
	conversation: ConversationProjection;
	send: (request: WebSendRequest) => Promise<WebSendResult>;
	processAttachment?: (source: Uint8Array, signal?: AbortSignal) => Promise<PreparedAttachment>;
	attachmentLimits?: AttachmentLimits;
	maxRequestBytes?: number;
}

interface SseClient {
	response: ServerResponse;
}

interface RequestRecord {
	hash: string;
	promise: Promise<WebSendResult>;
	settled: boolean;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly closeConnection = false,
	) {
		super(message);
	}
}

export class WebUIServer {
	readonly origin: string;
	private bootstrapToken?: string;
	private readonly sessionSecret = token();
	private readonly cookieName = `pi_webui_${randomBytes(8).toString("hex")}`;
	private readonly sockets = new Set<Socket>();
	private readonly sseClients = new Set<SseClient>();
	private readonly requests = new Map<string, RequestRecord>();
	private readonly activeSendControllers = new Set<AbortController>();
	private readonly activeAttachmentControllers = new Set<AbortController>();
	private readonly attachments: AttachmentStore;
	private readonly attachmentLimits: AttachmentLimits;
	private activeClientId?: string;
	private leaseGeneration = 0;
	private closed = false;
	private closePromise?: Promise<void>;
	private readonly unsubscribe: () => void;

	private constructor(
		private readonly server: Server,
		private readonly options: WebUIServerOptions,
		port: number,
	) {
		this.origin = `http://127.0.0.1:${port}`;
		this.attachmentLimits = options.attachmentLimits ?? {
			maxImages: DEFAULT_IMAGE_LIMITS.maxImages,
			maxImageBytes: DEFAULT_IMAGE_LIMITS.maxImageBytes,
			maxPromptBytes: DEFAULT_IMAGE_LIMITS.maxPromptBytes,
		};
		this.attachments = new AttachmentStore({
			limits: this.attachmentLimits,
			process:
				options.processAttachment ??
				(async () => {
					throw new Error("Image processing is unavailable.");
				}),
			onChange: (state) => this.broadcastControl("attachments", state),
		});
		server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.once("close", () => this.sockets.delete(socket));
		});
		server.unref();
		this.unsubscribe = options.conversation.subscribe((event) => this.broadcastEvent(event));
	}

	static async start(options: WebUIServerOptions): Promise<WebUIServer> {
		let instance: WebUIServer | undefined;
		const server = createServer((request, response) => {
			if (!instance) {
				response.writeHead(503).end();
				return;
			}
			void instance.handle(request, response);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("Pi WebUI server did not receive a TCP port");
		}
		instance = new WebUIServer(server, options, address.port);
		return instance;
	}

	issueLink(): string {
		if (this.closed) throw new Error("Pi WebUI server is closed");
		this.bootstrapToken = token();
		return `${this.origin}/bootstrap?token=${encodeURIComponent(this.bootstrapToken)}`;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.closeNow();
		return this.closePromise;
	}

	private async closeNow(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.bootstrapToken = undefined;
		this.unsubscribe();
		for (const controller of this.activeSendControllers) controller.abort();
		for (const controller of this.activeAttachmentControllers) controller.abort();
		this.activeSendControllers.clear();
		this.activeAttachmentControllers.clear();
		this.attachments.close();
		this.requests.clear();
		const responses = [...this.sseClients].map((client) => client.response);
		this.broadcastControl("session-ended", { message: "Pi session ended" });
		await Promise.all(responses.map((response) => finishResponse(response)));
		this.sseClients.clear();
		this.server.closeAllConnections?.();
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		this.secureHeaders(response);
		try {
			if (this.closed) throw new HttpError(410, "Pi session ended");
			if (request.headers.host !== new URL(this.origin).host) {
				throw new HttpError(421, "Unexpected Host header");
			}
			const url = new URL(request.url ?? "/", this.origin);
			if (request.method === "GET" && url.pathname === "/bootstrap") {
				this.bootstrap(url, response);
				return;
			}
			this.authenticate(request);
			if (request.method === "GET" && url.pathname === "/") {
				await this.asset(response, "index.html", "text/html; charset=utf-8");
				return;
			}
			if (
				request.method === "GET" &&
				["/app.js", "/state.js", "/markdown.js", "/transcript.js"].includes(url.pathname)
			) {
				await this.asset(response, url.pathname.slice(1), "text/javascript; charset=utf-8");
				return;
			}
			if (request.method === "GET" && url.pathname === "/styles.css") {
				await this.asset(response, "styles.css", "text/css; charset=utf-8");
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/state") {
				this.json(response, 200, {
					...this.options.conversation.snapshot(),
					lease: this.leaseSnapshot(),
					attachments: this.attachments.publicState(),
				});
				return;
			}
			const previewId = attachmentPathId(url.pathname, "preview");
			if (request.method === "GET" && previewId) {
				const preview = this.attachments.preview(previewId);
				response.writeHead(200, {
					"Content-Type": preview.mimeType,
					"Content-Length": preview.bytes.byteLength,
				});
				response.end(preview.bytes);
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/events") {
				this.events(url, request, response);
				return;
			}
			this.assertMutation(request);
			if (request.method === "POST" && url.pathname === "/api/lease") {
				const body = await readJson(request, 8 * 1024);
				if (!isRecord(body)) throw new HttpError(400, "Invalid lease request");
				const clientId = stringField(body, "clientId");
				if (!CLIENT_ID.test(clientId) || request.headers["x-pi-web-client"] !== clientId) {
					throw new HttpError(400, "Invalid client id");
				}
				this.activeClientId = clientId;
				this.leaseGeneration += 1;
				for (const controller of this.activeSendControllers) controller.abort();
				for (const controller of this.activeAttachmentControllers) controller.abort();
				this.attachments.cancelInFlight("Editing moved to another browser tab.");
				this.broadcastControl("lease", {
					activeClientId: clientId,
					generation: this.leaseGeneration,
				});
				this.json(response, 200, {
					activeClientId: clientId,
					generation: this.leaseGeneration,
				});
				return;
			}
			const lease = this.assertActiveClient(request);
			if (request.method === "POST" && url.pathname === "/api/attachments/reserve") {
				const body = requireRecord(await readJson(request, 64 * 1024), "attachment reservation");
				this.assertLease(lease);
				const state = this.attachments.reserve(
					parseAttachmentReservations(body.items),
					numberField(body, "revision"),
				);
				this.assertLease(lease);
				this.json(response, 201, state);
				return;
			}
			const uploadId = attachmentPathId(url.pathname, "upload");
			if (request.method === "POST" && uploadId) {
				const revision = revisionParameter(url);
				let source: Buffer;
				try {
					source = await readBytes(request, this.attachmentLimits.maxImageBytes);
				} catch (error) {
					this.assertLease(lease);
					try {
						this.attachments.failUpload(uploadId, `Upload failed: ${formatError(error)}`);
					} catch (failure) {
						if (!(failure instanceof AttachmentError) || failure.status !== 409) throw failure;
					}
					throw error;
				}
				this.assertLease(lease);
				const state = await this.runAttachmentOperation(request, response, (signal) =>
					this.attachments.upload(uploadId, source, revision, signal),
				);
				this.assertLease(lease);
				this.json(response, 200, state);
				return;
			}
			const retryId = attachmentPathId(url.pathname, "retry");
			if (request.method === "POST" && retryId) {
				const body = requireRecord(await readJson(request, 8 * 1024), "attachment retry");
				this.assertLease(lease);
				const state = await this.runAttachmentOperation(request, response, (signal) =>
					this.attachments.retry(retryId, numberField(body, "revision"), signal),
				);
				this.assertLease(lease);
				this.json(response, 200, state);
				return;
			}
			const deleteId = attachmentPathId(url.pathname);
			if (request.method === "DELETE" && deleteId) {
				const state = this.attachments.remove(deleteId, revisionParameter(url));
				this.assertLease(lease);
				this.json(response, 200, state);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/attachments/reorder") {
				const body = requireRecord(await readJson(request, 64 * 1024), "attachment reorder");
				this.assertLease(lease);
				const state = this.attachments.reorder(
					stringArrayField(body, "ids"),
					numberField(body, "revision"),
				);
				this.assertLease(lease);
				this.json(response, 200, state);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/attachments/clear") {
				const body = requireRecord(await readJson(request, 8 * 1024), "attachment clear");
				this.assertLease(lease);
				const state = this.attachments.clear(numberField(body, "revision"));
				this.assertLease(lease);
				this.json(response, 200, state);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/messages") {
				const body = await readJson(request, this.options.maxRequestBytes ?? JSON_LIMIT);
				this.assertLease(lease);
				const message = parseSendRequest(body);
				const result = await this.sendDeduplicated(message, request, response);
				this.json(response, 202, {
					accepted: true,
					requestId: message.requestId,
					...result,
					attachments: this.attachments.publicState(),
				});
				return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) {
			const status =
				error instanceof HttpError || error instanceof AttachmentError ? error.status : 500;
			if (error instanceof HttpError && error.closeConnection)
				response.setHeader("Connection", "close");
			this.json(response, status, { error: formatError(error) });
			if (error instanceof HttpError && error.closeConnection) request.socket?.destroySoon?.();
		}
	}

	private bootstrap(url: URL, response: ServerResponse): void {
		const presented = url.searchParams.get("token");
		const expected = this.bootstrapToken;
		if (!presented || !expected || !secretEqual(presented, expected)) {
			throw new HttpError(401, "Invalid or expired bootstrap token");
		}
		this.bootstrapToken = undefined;
		response.setHeader(
			"Set-Cookie",
			`${this.cookieName}=${this.sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
		);
		response.writeHead(303, { Location: "/" }).end();
	}

	private authenticate(request: IncomingMessage): void {
		const cookies = parseCookies(request.headers.cookie);
		const presented = cookies.get(this.cookieName);
		if (!presented || !secretEqual(presented, this.sessionSecret)) {
			throw new HttpError(401, "Authentication required");
		}
	}

	private assertMutation(request: IncomingMessage): void {
		if (request.headers.origin !== this.origin) throw new HttpError(403, "Unexpected Origin");
	}

	private assertActiveClient(request: IncomingMessage): { clientId: string; generation: number } {
		const clientId = request.headers["x-pi-web-client"];
		if (typeof clientId !== "string" || clientId !== this.activeClientId) {
			throw new HttpError(409, "This browser tab is stale");
		}
		return { clientId, generation: this.leaseGeneration };
	}

	private assertLease(lease: { clientId: string; generation: number }): void {
		if (lease.clientId !== this.activeClientId || lease.generation !== this.leaseGeneration) {
			throw new HttpError(409, "This browser tab became stale");
		}
	}

	private async runAttachmentOperation(
		request: IncomingMessage,
		response: ServerResponse,
		operation: (signal: AbortSignal) => PublicAttachmentState | Promise<PublicAttachmentState>,
	): Promise<PublicAttachmentState> {
		const controller = new AbortController();
		this.activeAttachmentControllers.add(controller);
		const abort = () => controller.abort();
		request.once("aborted", abort);
		response.once("close", abort);
		try {
			return await operation(controller.signal);
		} finally {
			request.off("aborted", abort);
			response.off("close", abort);
			this.activeAttachmentControllers.delete(controller);
		}
	}

	private async sendDeduplicated(
		message: ParsedSendRequest,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<WebSendResult> {
		const hash = messageDigest(message);
		const current = this.requests.get(message.requestId);
		if (current) {
			if (current.hash !== hash)
				throw new HttpError(409, "Request id was reused with different content");
			return current.promise;
		}
		const reservation =
			message.attachmentIds.length > 0
				? this.attachments.beginSend(message.attachmentIds, message.attachmentRevision)
				: undefined;
		const controller = new AbortController();
		this.activeSendControllers.add(controller);
		const abort = () => controller.abort();
		request.once("aborted", abort);
		response.once("close", abort);
		let attachmentReservationSettled = false;
		const promise = this.options
			.send({ ...message, images: reservation?.images ?? [], signal: controller.signal })
			.then((result) => {
				if (reservation) this.attachments.finishSend(reservation.token, true);
				attachmentReservationSettled = true;
				const record = this.requests.get(message.requestId);
				if (record?.promise === promise) {
					record.settled = true;
					this.trimRequests();
				}
				return result;
			})
			.catch((error) => {
				if (reservation && !attachmentReservationSettled) {
					try {
						this.attachments.finishSend(reservation.token, false);
					} catch {
						// Session shutdown may already have released the reservation.
					}
					attachmentReservationSettled = true;
				}
				if (this.requests.get(message.requestId)?.promise === promise) {
					this.requests.delete(message.requestId);
				}
				if (controller.signal.aborted) throw new HttpError(409, "Browser send was cancelled");
				throw error;
			})
			.finally(() => {
				request.off("aborted", abort);
				response.off("close", abort);
				this.activeSendControllers.delete(controller);
			});
		this.requests.set(message.requestId, { hash, promise, settled: false });
		this.trimRequests();
		return promise;
	}

	private trimRequests(): void {
		if (this.requests.size <= MAX_REQUESTS) return;
		for (const [requestId, record] of this.requests) {
			if (!record.settled) continue;
			this.requests.delete(requestId);
			if (this.requests.size <= MAX_REQUESTS) return;
		}
	}

	private events(url: URL, request: IncomingMessage, response: ServerResponse): void {
		const sinceText = url.searchParams.get("since") ?? "0";
		if (!/^\d+$/.test(sinceText)) throw new HttpError(400, "Invalid event cursor");
		const since = Number(sinceText);
		if (!Number.isSafeInteger(since)) throw new HttpError(400, "Invalid event cursor");
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			Connection: "keep-alive",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		});
		response.flushHeaders();
		const client: SseClient = { response };
		this.sseClients.add(client);
		if (!response.write(": connected\n\n")) {
			this.sseClients.delete(client);
			response.end();
			return;
		}
		this.writeSse(client, "lease", this.leaseSnapshot());
		this.writeSse(client, "attachments", this.attachments.publicState());
		const replay = this.options.conversation.eventsAfter(since);
		if (replay === undefined) {
			this.writeSse(client, "snapshot", this.options.conversation.snapshot());
		} else {
			for (const event of replay) this.writeSse(client, "conversation", event);
		}
		request.once("close", () => this.sseClients.delete(client));
	}

	private leaseSnapshot(): { activeClientId?: string; generation: number } {
		return {
			...(this.activeClientId ? { activeClientId: this.activeClientId } : {}),
			generation: this.leaseGeneration,
		};
	}

	private broadcastEvent(event: ConversationEvent): void {
		for (const client of [...this.sseClients]) this.writeSse(client, "conversation", event);
	}

	private broadcastControl(event: string, payload: unknown): void {
		for (const client of [...this.sseClients]) this.writeSse(client, event, payload);
	}

	private writeSse(client: SseClient, event: string, payload: unknown): void {
		if (client.response.destroyed || client.response.writableEnded) {
			this.sseClients.delete(client);
			return;
		}
		const accepted = client.response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
		if (!accepted) {
			this.sseClients.delete(client);
			client.response.end();
		}
	}

	private async asset(response: ServerResponse, name: string, contentType: string): Promise<void> {
		const content = await readAsset(name);
		response.writeHead(200, { "Content-Type": contentType, "Content-Length": content.byteLength });
		response.end(content);
	}

	private secureHeaders(response: ServerResponse): void {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		);
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("X-Frame-Options", "DENY");
		response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	}

	private json(response: ServerResponse, status: number, value: unknown): void {
		if (response.headersSent || response.writableEnded) return;
		const body = JSON.stringify(value);
		response.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(body),
		});
		response.end(body);
	}
}

function finishResponse(response: ServerResponse): Promise<void> {
	if (response.destroyed || response.writableFinished) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve();
		};
		const timeout = setTimeout(done, SSE_FLUSH_TIMEOUT_MS);
		if (response.writableEnded) {
			response.once("finish", done);
			response.once("close", done);
		} else {
			response.end(done);
		}
	});
}

async function readAsset(name: string): Promise<Buffer> {
	const runtimePath = join(fileURLToPath(new URL(".", import.meta.url)), "web", name);
	try {
		return await readFile(runtimePath);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return readFile(join(process.cwd(), "extensions", "pi-webui", "src", "web", name));
	}
}

function messageDigest(message: ParsedSendRequest): string {
	const hash = createHash("sha256");
	for (const value of [
		message.requestId,
		message.delivery,
		message.text,
		String(message.attachmentRevision),
		...message.attachmentIds,
	]) {
		hash
			.update(String(Buffer.byteLength(value)))
			.update(":")
			.update(value);
	}
	return hash.digest("hex");
}

function parseSendRequest(value: unknown): ParsedSendRequest {
	if (!isRecord(value)) throw new HttpError(400, "Invalid message request");
	const requestId = stringField(value, "requestId");
	if (!REQUEST_ID.test(requestId)) throw new HttpError(400, "Invalid request id");
	const text = stringField(value, "text");
	const attachmentRevision = numberField(value, "attachmentRevision");
	const attachmentIds = stringArrayField(value, "attachmentIds");
	if (!text.trim() && attachmentIds.length === 0)
		throw new HttpError(400, "Message cannot be empty");
	const delivery = value.delivery;
	if (delivery !== "next" && delivery !== "steer")
		throw new HttpError(400, "Invalid delivery mode");
	return { requestId, text, attachmentRevision, attachmentIds, delivery };
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
	const length = Number(request.headers["content-length"] ?? "0");
	if (Number.isFinite(length) && length > limit) {
		throw new HttpError(413, "Request body is too large", true);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > limit) throw new HttpError(413, "Request body is too large", true);
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > limit) throw new HttpError(413, "Request body is too large", true);
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new HttpError(400, "Invalid JSON body");
	}
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new HttpError(400, `Invalid ${label}`);
	return value;
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new HttpError(400, `Invalid ${key}`);
	return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (!Number.isSafeInteger(field) || (field as number) < 0) {
		throw new HttpError(400, `Invalid ${key}`);
	}
	return field as number;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
	const field = value[key];
	if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
		throw new HttpError(400, `Invalid ${key}`);
	}
	return field;
}

function parseAttachmentReservations(value: unknown): Array<{
	id: string;
	name: string;
	size: number;
	mimeType?: string;
}> {
	if (!Array.isArray(value)) throw new HttpError(400, "Invalid attachment list");
	return value.map((entry) => {
		const item = requireRecord(entry, "attachment");
		return {
			id: stringField(item, "id"),
			name: stringField(item, "name"),
			size: numberField(item, "size"),
			...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
		};
	});
}

function revisionParameter(url: URL): number {
	const value = url.searchParams.get("revision");
	if (!value || !/^\d+$/.test(value)) throw new HttpError(400, "Invalid attachment revision");
	const revision = Number(value);
	if (!Number.isSafeInteger(revision)) throw new HttpError(400, "Invalid attachment revision");
	return revision;
}

function attachmentPathId(
	pathname: string,
	action?: "upload" | "retry" | "preview",
): string | undefined {
	const suffix = action ? `/${action}` : "";
	const match = new RegExp(`^/api/attachments/([A-Za-z0-9_-]{1,128})${suffix}$`).exec(pathname);
	return match?.[1];
}

function token(): string {
	return randomBytes(32).toString("base64url");
}

function secretEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function parseCookies(header: string | undefined): Map<string, string> {
	const cookies = new Map<string, string>();
	for (const part of header?.split(";") ?? []) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
	}
	return cookies;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
