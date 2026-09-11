import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ResolvedWebDavBackend } from "../src/backends/backend-types.js";

export interface MockWebDavOptions {
  username?: string;
  password?: string;
  ignoreConditions?: boolean;
  etag?: "strong" | "weak" | "missing";
  deny?: boolean;
  cleanupFails?: boolean;
  cleanupMultiStatus?: boolean;
  malformedXml?: boolean;
  delayMs?: number;
  redirectTo?: string;
  failLatestPut?: boolean;
  failHistoryPut?: boolean;
  constantEtag?: boolean;
}

export function webDavConfig(url: string): ResolvedWebDavBackend {
  return {
    type: "webdav",
    profile: { kind: "webdav", url, username: "user", password: "pass" },
    destination: { path: "pi-sync", namespace: "default" },
  };
}

export interface RecordedWebDavRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

export class MockWebDavServer {
  readonly requests: RecordedWebDavRequest[] = [];
  readonly resources = new Map<string, Buffer>();
  readonly collections = new Set<string>(["/dav"]);
  private readonly server = createServer((request, response) => void this.handle(request, response));
  private origin = "";

  constructor(readonly options: MockWebDavOptions = {}) {}

  get url() {
    return `${this.origin}/dav/`;
  }

  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mock WebDAV server did not bind.");
    this.origin = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async close() {
    this.server.close();
    await once(this.server, "close");
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? "GET";
    const path = decodeURIComponent(new URL(request.url ?? "/", this.origin).pathname).replace(/\/+$/u, "") || "/";
    this.requests.push({ method, path, headers: request.headers });
    if (this.options.redirectTo) {
      return send(response, 302, undefined, { location: this.options.redirectTo });
    }
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    const expectedAuth = `Basic ${Buffer.from(`${this.options.username ?? "user"}:${this.options.password ?? "pass"}`).toString("base64")}`;
    if (request.headers.authorization !== expectedAuth) return send(response, 401, "authentication required");
    if (this.options.deny) return send(response, 403, "permission denied");
    if (method === "MKCOL") return this.mkcol(path, response);
    if (method === "PROPFIND") return this.propfind(path, response);
    if (method === "GET") return this.get(path, response);
    if (method === "PUT") return this.put(path, request, response);
    if (method === "DELETE") return this.delete(path, response);
    return send(response, 405, "method not allowed");
  }

  private mkcol(path: string, response: ServerResponse) {
    if (this.collections.has(path)) return send(response, 405);
    if (!this.collections.has(parent(path))) return send(response, 409, "parent missing");
    this.collections.add(path);
    return send(response, 201);
  }

  private propfind(path: string, response: ServerResponse) {
    if (!this.collections.has(path)) return send(response, 404);
    if (this.options.malformedXml) return send(response, 207, "<broken", { "content-type": "application/xml" });
    const children = [
      entry(path, undefined, true),
      ...[...this.collections]
        .filter((item) => parent(item) === path && item !== path)
        .map((item) => entry(item, undefined, true)),
      ...[...this.resources]
        .filter(([item]) => parent(item) === path)
        .map(([item, body]) => entry(item, this.etag(body), false)),
    ].join("");
    return send(response, 207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${children}</d:multistatus>`, {
      "content-type": "application/xml",
    });
  }

  private get(path: string, response: ServerResponse) {
    const body = this.resources.get(path);
    if (!body) return send(response, 404);
    return send(response, 200, body, this.etagHeader(body));
  }

  private async put(path: string, request: IncomingMessage, response: ServerResponse) {
    if (this.options.failLatestPut && path.endsWith("/latest.json")) {
      return send(response, 500, "interrupted publication");
    }
    if (this.options.failHistoryPut && path.endsWith("/history.json")) {
      return send(response, 500, "history update failed");
    }
    if (!this.collections.has(parent(path))) return send(response, 409, "parent missing");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const existing = this.resources.get(path);
    if (!this.options.ignoreConditions) {
      if (request.headers["if-none-match"] === "*" && existing) return send(response, 412);
      const ifMatch = request.headers["if-match"];
      if (ifMatch && (!existing || ifMatch !== this.etag(existing))) return send(response, 412);
    }
    this.resources.set(path, body);
    return send(response, existing ? 204 : 201, undefined, this.etagHeader(body));
  }

  private delete(path: string, response: ServerResponse) {
    if (this.options.cleanupFails && path.includes(".pi-sync-probes")) return send(response, 500, "cleanup failed");
    if (this.options.cleanupMultiStatus && path.includes(".pi-sync-probes")) {
      return send(response, 207, "partial cleanup failed");
    }
    let found = this.collections.delete(path) || this.resources.delete(path);
    for (const key of [...this.collections]) {
      if (key.startsWith(`${path}/`)) {
        this.collections.delete(key);
        found = true;
      }
    }
    for (const key of [...this.resources.keys()]) {
      if (key.startsWith(`${path}/`)) {
        this.resources.delete(key);
        found = true;
      }
    }
    return send(response, found ? 204 : 404);
  }

  private etag(body: Buffer) {
    const value = this.options.constantEtag
      ? '"constant"'
      : `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
    return this.options.etag === "weak" ? `W/${value}` : value;
  }

  private etagHeader(body: Buffer): Record<string, string> {
    return this.options.etag === "missing" ? {} : { etag: this.etag(body) };
  }
}

function parent(value: string) {
  const index = value.lastIndexOf("/");
  return index <= 0 ? "/" : value.slice(0, index);
}

function entry(path: string, etag: string | undefined, collection: boolean) {
  return `<d:response><d:href>${escapeXml(path)}</d:href><d:propstat><d:prop>${etag ? `<d:getetag>${etag}</d:getetag>` : ""}<d:resourcetype>${collection ? "<d:collection/>" : ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function send(response: ServerResponse, status: number, body?: string | Buffer, headers: Record<string, string> = {}) {
  response.writeHead(status, headers);
  response.end(body);
}
