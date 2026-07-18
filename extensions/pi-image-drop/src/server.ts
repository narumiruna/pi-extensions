import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessedImage } from "./batch.js";
import { BatchError, type BatchStore, type PublicBatchState } from "./batch.js";
import type { ProcessImageOptions } from "./images.js";
import type { ImageDropSettings } from "./settings.js";

const JSON_LIMIT = 64 * 1024;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface ImageDropServerOptions {
	batch: BatchStore;
	settings: ImageDropSettings;
	projectName: string;
	sessionName?: string;
	cwd: string;
	process: (source: Uint8Array, options: ProcessImageOptions) => Promise<ProcessedImage>;
	getAutoResize: () => Promise<boolean>;
	onStateChange?: (state: PublicBatchState) => void;
}

interface SseClient {
	id: string;
	response: ServerResponse;
}

interface ClientLease {
	clientId: string;
	generation: number;
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

export class ImageDropServer {
	readonly origin: string;
	private bootstrapToken?: string;
	private readonly sessionSecret = token();
	private readonly cookieName = `pi_image_drop_${randomBytes(8).toString("hex")}`;
	private readonly abortController = new AbortController();
	private readonly sockets = new Set<Socket>();
	private readonly sseClients = new Set<SseClient>();
	private activeClientId?: string;
	private activeClientGeneration = 0;
	private closed = false;
	private closePromise?: Promise<void>;

	private constructor(
		private readonly server: Server,
		private readonly options: ImageDropServerOptions,
		port: number,
	) {
		this.origin = `http://127.0.0.1:${port}`;
		server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.once("close", () => this.sockets.delete(socket));
		});
		server.unref();
	}

	static async start(options: ImageDropServerOptions): Promise<ImageDropServer> {
		let instance: ImageDropServer | undefined;
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
			throw new Error("Image Drop server did not receive a TCP port");
		}
		instance = new ImageDropServer(server, options, address.port);
		return instance;
	}

	issueLink(): string {
		if (this.closed) throw new Error("Image Drop server is closed");
		this.bootstrapToken = token();
		return `${this.origin}/bootstrap?token=${encodeURIComponent(this.bootstrapToken)}`;
	}

	broadcastState(): void {
		if (this.closed) return;
		const state = this.options.batch.publicState();
		try {
			this.options.onStateChange?.(state);
		} catch {
			// A stale Pi UI context must not roll back an accepted browser mutation.
		}
		this.broadcast("state", this.statePayload());
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
		this.abortController.abort();
		this.broadcast("session-ended", { message: "Pi session ended" });
		const ending = [...this.sseClients].map(
			(client) =>
				new Promise<void>((resolve) => {
					if (client.response.destroyed || client.response.writableEnded) resolve();
					else client.response.end(resolve);
				}),
		);
		this.sseClients.clear();
		await Promise.all(ending);
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
				this.json(response, 200, this.statePayload());
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/events") {
				this.events(url, request, response);
				return;
			}
			const previewMatch = /^\/api\/items\/([A-Za-z0-9_-]{1,80})\/preview$/.exec(url.pathname);
			if (request.method === "GET" && previewMatch) {
				const preview = this.options.batch.preview(previewMatch[1] as string);
				response.setHeader("Content-Type", preview.mimeType);
				response.setHeader("Content-Length", preview.bytes.byteLength);
				response.writeHead(200).end(preview.bytes);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/lease") {
				this.assertMutation(request);
				const body = await readJson(request, JSON_LIMIT);
				const clientId = stringField(body, "clientId");
				if (!CLIENT_ID.test(clientId) || request.headers["x-image-drop-client"] !== clientId) {
					throw new HttpError(400, "Invalid client id");
				}
				this.takeLease(clientId);
				this.broadcastState();
				this.json(response, 200, this.statePayload());
				return;
			}
			this.assertMutation(request);
			const lease = this.assertActiveClient(request);
			if (request.method === "POST" && url.pathname === "/api/items") {
				const body = await readJson(request, JSON_LIMIT);
				this.assertLease(lease);
				const revision = integerField(body, "revision");
				const inputs = arrayField(body, "items").map((item) => {
					if (!isRecord(item)) throw new HttpError(400, "Invalid item reservation");
					return {
						id: stringField(item, "id"),
						name: stringField(item, "name"),
						size: integerField(item, "size"),
					};
				});
				this.options.batch.reserveItems(inputs, revision);
				this.respondWithState(response);
				return;
			}
			const contentMatch = /^\/api\/items\/([A-Za-z0-9_-]{1,80})\/content$/.exec(url.pathname);
			if (request.method === "PUT" && contentMatch) {
				const id = contentMatch[1] as string;
				let source: Buffer;
				try {
					source = await readBody(request, this.options.settings.maxImageBytes);
				} catch (error) {
					this.assertLease(lease);
					try {
						this.options.batch.failUpload(id, `Upload failed: ${formatError(error)}`);
					} catch (failure) {
						if (!isHandledUploadError(failure)) throw failure;
					}
					this.broadcastState();
					throw error;
				}
				this.assertLease(lease);
				this.options.batch.startProcessing(id, source);
				this.broadcastState();
				const completed = await this.processItem(id, source, request, lease);
				this.broadcastState();
				this.json(response, 200, { ...this.statePayload(), duplicateOf: completed.duplicateOf });
				return;
			}
			const failureMatch = /^\/api\/items\/([A-Za-z0-9_-]{1,80})\/fail$/.exec(url.pathname);
			if (request.method === "POST" && failureMatch) {
				const body = await readJson(request, JSON_LIMIT);
				this.assertLease(lease);
				this.options.batch.failUpload(failureMatch[1] as string, stringField(body, "error"));
				this.respondWithState(response);
				return;
			}
			const retryMatch = /^\/api\/items\/([A-Za-z0-9_-]{1,80})\/retry$/.exec(url.pathname);
			if (request.method === "POST" && retryMatch) {
				const id = retryMatch[1] as string;
				const source = this.options.batch.retrySource(id);
				this.broadcastState();
				const completed = await this.processItem(id, source, request, lease);
				this.broadcastState();
				this.json(response, 200, { ...this.statePayload(), duplicateOf: completed.duplicateOf });
				return;
			}
			const itemMatch = /^\/api\/items\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
			if (request.method === "DELETE" && itemMatch) {
				this.options.batch.delete(itemMatch[1] as string, queryInteger(url, "revision"));
				this.respondWithState(response);
				return;
			}
			if (request.method === "PUT" && url.pathname === "/api/order") {
				const body = await readJson(request, JSON_LIMIT);
				this.assertLease(lease);
				const ids = arrayField(body, "ids").map((id) => {
					if (typeof id !== "string") throw new HttpError(400, "Invalid image order");
					return id;
				});
				this.options.batch.reorder(ids, integerField(body, "revision"));
				this.respondWithState(response);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/clear") {
				const body = await readJson(request, JSON_LIMIT);
				this.assertLease(lease);
				this.options.batch.clear(integerField(body, "revision"));
				this.respondWithState(response);
				return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) {
			this.error(response, error);
		}
	}

	private bootstrap(url: URL, response: ServerResponse): void {
		const supplied = url.searchParams.get("token") ?? "";
		if (!this.bootstrapToken || !secretEquals(supplied, this.bootstrapToken)) {
			throw new HttpError(401, "Invalid or expired bootstrap token");
		}
		this.bootstrapToken = undefined;
		response.setHeader(
			"Set-Cookie",
			`${this.cookieName}=${this.sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
		);
		response.setHeader("Location", "/");
		response.writeHead(303).end();
	}

	private authenticate(request: IncomingMessage): void {
		const cookies = parseCookies(request.headers.cookie);
		if (!secretEquals(cookies.get(this.cookieName) ?? "", this.sessionSecret)) {
			throw new HttpError(401, "Authentication required");
		}
	}

	private assertMutation(request: IncomingMessage): void {
		if (request.headers.origin !== this.origin) throw new HttpError(403, "Unexpected Origin");
	}

	private assertActiveClient(request: IncomingMessage): ClientLease {
		const clientId = request.headers["x-image-drop-client"];
		if (typeof clientId !== "string" || clientId !== this.activeClientId) {
			throw new HttpError(409, "This page no longer owns the editing lease");
		}
		return { clientId, generation: this.activeClientGeneration };
	}

	private assertLease(lease: ClientLease): void {
		if (
			lease.clientId !== this.activeClientId ||
			lease.generation !== this.activeClientGeneration
		) {
			throw new HttpError(409, "This page no longer owns the editing lease");
		}
	}

	private takeLease(clientId: string): void {
		const previous = this.activeClientId;
		if (previous !== clientId) this.activeClientGeneration += 1;
		this.activeClientId = clientId;
		if (previous && previous !== clientId) {
			this.options.batch.cancelInFlight(
				"Upload cancelled because the Image Drop page was replaced.",
			);
			for (const client of [...this.sseClients]) {
				if (client.id !== previous) continue;
				writeSse(client.response, "stale", { message: "Image Drop opened in another tab" });
				client.response.end();
				this.sseClients.delete(client);
			}
		}
	}

	private events(url: URL, request: IncomingMessage, response: ServerResponse): void {
		const clientId = url.searchParams.get("client") ?? "";
		if (!CLIENT_ID.test(clientId) || clientId !== this.activeClientId) {
			throw new HttpError(409, "This page no longer owns the editing lease");
		}
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			Connection: "keep-alive",
		});
		response.write("retry: 1000\n\n");
		const client = { id: clientId, response };
		this.sseClients.add(client);
		writeSse(response, "state", this.statePayload());
		request.once("close", () => this.sseClients.delete(client));
	}

	private async processItem(
		id: string,
		source: Buffer,
		request: IncomingMessage,
		lease: ClientLease,
	): Promise<{ duplicateOf?: string }> {
		const requestAbort = new AbortController();
		request.once("aborted", () => requestAbort.abort());
		const signal = AbortSignal.any([this.abortController.signal, requestAbort.signal]);
		try {
			const autoResize = await this.options.getAutoResize();
			this.assertLease(lease);
			const processed = await this.options.process(source, {
				autoResize,
				maxImagePixels: this.options.settings.maxImagePixels,
				signal,
			});
			this.assertLease(lease);
			const completion = this.options.batch.complete(id, processed, autoResize);
			return completion.kind === "duplicate" ? { duplicateOf: completion.existingId } : {};
		} catch (error) {
			if (error instanceof HttpError) throw error;
			if (this.closed || signal.aborted || isDiscardedItemError(error)) return {};
			this.assertLease(lease);
			if (!this.failItem(id, formatError(error))) return {};
			throw new HttpError(422, formatError(error));
		} finally {
			this.broadcastState();
		}
	}

	private failItem(id: string, error: string): boolean {
		try {
			this.options.batch.fail(id, error);
			return true;
		} catch (failure) {
			if (isDiscardedItemError(failure)) return false;
			throw failure;
		}
	}

	private statePayload() {
		return {
			projectName: this.options.projectName,
			sessionName: this.options.sessionName,
			cwd: this.options.cwd,
			activeClientId: this.activeClientId,
			batch: this.options.batch.publicState(),
		};
	}

	private respondWithState(response: ServerResponse): void {
		this.broadcastState();
		this.json(response, 200, this.statePayload());
	}

	private broadcast(event: string, data: unknown): void {
		for (const client of [...this.sseClients]) {
			if (client.response.destroyed || client.response.writableEnded) {
				this.sseClients.delete(client);
				continue;
			}
			writeSse(client.response, event, data);
		}
	}

	private async asset(response: ServerResponse, name: string, contentType: string): Promise<void> {
		const data = await readAsset(name);
		response.setHeader("Content-Type", contentType);
		response.setHeader("Content-Length", data.byteLength);
		response.writeHead(200).end(data);
	}

	private secureHeaders(response: ServerResponse): void {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("X-Frame-Options", "DENY");
	}

	private json(response: ServerResponse, status: number, value: unknown): void {
		const body = Buffer.from(JSON.stringify(value));
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.setHeader("Content-Length", body.byteLength);
		response.writeHead(status).end(body);
	}

	private error(response: ServerResponse, error: unknown): void {
		if (response.headersSent || response.writableEnded) {
			response.destroy();
			return;
		}
		if (error instanceof BatchError) {
			const statuses = {
				closed: 410,
				frozen: 423,
				stale: 409,
				limit: 413,
				invalid: 400,
				"not-found": 404,
				"not-ready": 409,
			} as const;
			this.json(response, statuses[error.code], { error: error.message, code: error.code });
			return;
		}
		if (error instanceof HttpError) {
			if (error.closeConnection) response.setHeader("Connection", "close");
			this.json(response, error.status, { error: error.message });
			return;
		}
		this.json(response, 500, { error: "Internal Image Drop error" });
	}
}

async function readAsset(name: string): Promise<Buffer> {
	const runtimePath = fileURLToPath(new URL(`./web/${name}`, import.meta.url));
	try {
		return await readFile(runtimePath);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return readFile(join(process.cwd(), "extensions", "pi-image-drop", "src", "web", name));
	}
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
	const body = await readBody(request, limit);
	try {
		const value = JSON.parse(body.toString("utf8")) as unknown;
		if (!isRecord(value)) throw new Error("JSON body must be an object");
		return value;
	} catch (error) {
		throw new HttpError(400, `Invalid JSON body: ${formatError(error)}`);
	}
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
	const declared = Number(request.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limit) {
		request.pause();
		return Promise.reject(new HttpError(413, "Request body is too large", true));
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		request.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const buffer = Buffer.from(chunk);
			bytes += buffer.byteLength;
			if (bytes > limit) {
				settled = true;
				request.pause();
				reject(new HttpError(413, "Request body is too large", true));
				return;
			}
			chunks.push(buffer);
		});
		request.once("end", () => {
			if (!settled) resolve(Buffer.concat(chunks));
		});
		request.once("aborted", () => reject(new HttpError(400, "Request was aborted")));
		request.once("error", reject);
	});
}

function parseCookies(header?: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const pair of header?.split(";") ?? []) {
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		result.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
	}
	return result;
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
	try {
		response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	} catch {
		response.destroy();
	}
}

function token(): string {
	return randomBytes(32).toString("base64url");
}

function secretEquals(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new HttpError(400, `${key} must be a string`);
	return field;
}

function integerField(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (!Number.isSafeInteger(field) || (field as number) < 0) {
		throw new HttpError(400, `${key} must be a non-negative integer`);
	}
	return field as number;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
	const field = value[key];
	if (!Array.isArray(field)) throw new HttpError(400, `${key} must be an array`);
	return field;
}

function queryInteger(url: URL, key: string): number {
	const value = url.searchParams.get(key);
	if (!value || !/^\d+$/.test(value)) throw new HttpError(400, `${key} is required`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new HttpError(400, `${key} is invalid`);
	return parsed;
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

function isDiscardedItemError(error: unknown): boolean {
	return error instanceof BatchError && (error.code === "not-found" || error.code === "closed");
}

function isHandledUploadError(error: unknown): boolean {
	return isDiscardedItemError(error) || (error instanceof BatchError && error.code === "invalid");
}
