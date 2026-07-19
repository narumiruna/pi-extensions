import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationEvent, ConversationProjection } from "./conversation.js";
import type { BrowserImageInput } from "./images.js";

const JSON_LIMIT = 64 * 1024 * 1024;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_REQUESTS = 128;

export interface WebSendRequest {
	requestId: string;
	text: string;
	images: BrowserImageInput[];
	delivery: "next" | "steer";
	signal?: AbortSignal;
}

export interface WebSendResult {
	delivery: "immediate" | "followUp" | "steer";
}

export interface WebUIServerOptions {
	conversation: ConversationProjection;
	send: (request: WebSendRequest) => Promise<WebSendResult>;
	maxRequestBytes?: number;
}

interface SseClient {
	response: ServerResponse;
}

interface RequestRecord {
	hash: string;
	promise: Promise<WebSendResult>;
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
		this.activeSendControllers.clear();
		this.broadcastControl("session-ended", { message: "Pi session ended" });
		for (const client of this.sseClients) client.response.end();
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
				(url.pathname === "/app.js" || url.pathname === "/state.js")
			) {
				await this.asset(response, url.pathname.slice(1), "text/javascript; charset=utf-8");
				return;
			}
			if (request.method === "GET" && url.pathname === "/styles.css") {
				await this.asset(response, "styles.css", "text/css; charset=utf-8");
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/state") {
				this.json(response, 200, this.options.conversation.snapshot());
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
			if (request.method === "POST" && url.pathname === "/api/messages") {
				const body = await readJson(request, this.options.maxRequestBytes ?? JSON_LIMIT);
				this.assertLease(lease);
				const message = parseSendRequest(body);
				const result = await this.sendDeduplicated(message, request);
				this.json(response, 202, { accepted: true, requestId: message.requestId, ...result });
				return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
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

	private async sendDeduplicated(
		message: WebSendRequest,
		request: IncomingMessage,
	): Promise<WebSendResult> {
		const hash = messageDigest(message);
		const current = this.requests.get(message.requestId);
		if (current) {
			if (current.hash !== hash)
				throw new HttpError(409, "Request id was reused with different content");
			return current.promise;
		}
		const controller = new AbortController();
		this.activeSendControllers.add(controller);
		const abort = () => controller.abort();
		request.once("aborted", abort);
		const promise = this.options
			.send({ ...message, signal: controller.signal })
			.catch((error) => {
				if (controller.signal.aborted) throw new HttpError(409, "Browser send was cancelled");
				throw error;
			})
			.finally(() => {
				request.off("aborted", abort);
				this.activeSendControllers.delete(controller);
			});
		this.requests.set(message.requestId, { hash, promise });
		while (this.requests.size > MAX_REQUESTS) {
			const oldest = this.requests.keys().next().value;
			if (typeof oldest !== "string") break;
			this.requests.delete(oldest);
		}
		return promise;
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
		const replay = this.options.conversation.eventsAfter(since);
		if (replay === undefined) {
			this.writeSse(client, "snapshot", this.options.conversation.snapshot());
		} else {
			for (const event of replay) this.writeSse(client, "conversation", event);
		}
		request.once("close", () => this.sseClients.delete(client));
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

async function readAsset(name: string): Promise<Buffer> {
	const runtimePath = join(fileURLToPath(new URL(".", import.meta.url)), "web", name);
	try {
		return await readFile(runtimePath);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return readFile(join(process.cwd(), "extensions", "pi-webui", "src", "web", name));
	}
}

function messageDigest(message: WebSendRequest): string {
	const hash = createHash("sha256");
	for (const value of [message.requestId, message.delivery, message.text]) {
		hash
			.update(String(Buffer.byteLength(value)))
			.update(":")
			.update(value);
	}
	for (const image of message.images) {
		for (const value of [image.name ?? "", image.mimeType ?? "", image.data]) {
			hash
				.update(String(Buffer.byteLength(value)))
				.update(":")
				.update(value);
		}
	}
	return hash.digest("hex");
}

function parseSendRequest(value: unknown): WebSendRequest {
	if (!isRecord(value)) throw new HttpError(400, "Invalid message request");
	const requestId = stringField(value, "requestId");
	if (!REQUEST_ID.test(requestId)) throw new HttpError(400, "Invalid request id");
	const text = stringField(value, "text");
	const imagesValue = value.images;
	if (!Array.isArray(imagesValue)) throw new HttpError(400, "Invalid image list");
	if (!text.trim() && imagesValue.length === 0) throw new HttpError(400, "Message cannot be empty");
	const delivery = value.delivery;
	if (delivery !== "next" && delivery !== "steer")
		throw new HttpError(400, "Invalid delivery mode");
	const images = imagesValue.map((image) => {
		if (!isRecord(image) || typeof image.data !== "string")
			throw new HttpError(400, "Invalid image");
		return {
			data: image.data,
			...(typeof image.name === "string" ? { name: image.name } : {}),
			...(typeof image.mimeType === "string" ? { mimeType: image.mimeType } : {}),
		};
	});
	return { requestId, text, images, delivery };
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

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new HttpError(400, `Invalid ${key}`);
	return field;
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
