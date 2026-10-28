import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface ViewerServer {
  url: string;
  token: string;
  origin: string;
  invalidate(revision: number): void;
  close(): Promise<void>;
}
export interface ServerOptions {
  generation: string;
  signal: AbortSignal;
  snapshot(): unknown;
  branch(id: string, offset: number): unknown;
  detail(id: string, leaf: string): unknown;
  assets?: Map<string, { type: string; body: string | Buffer }>;
  assetBase?: URL;
}
export function sendRevision(response: { write(frame: string): boolean; destroy(): void }, frame: string): void {
  // No extension-owned queue: close a backpressured client; reconnect fetches a fresh snapshot.
  if (!response.write(frame)) response.destroy();
}
export async function startServer(options: ServerOptions): Promise<ViewerServer> {
  const assetBase = options.assetBase ?? new URL("../browser-dist/", import.meta.url);
  const assets =
    options.assets ??
    new Map([
      [
        "/",
        {
          type: "text/html; charset=utf-8",
          body: await readFile(new URL("index.html", assetBase), { signal: options.signal }),
        },
      ],
      [
        "/app.js",
        {
          type: "text/javascript; charset=utf-8",
          body: await readFile(new URL("app.js", assetBase), { signal: options.signal }),
        },
      ],
      [
        "/app.css",
        {
          type: "text/css; charset=utf-8",
          body: await readFile(new URL("app.css", assetBase), { signal: options.signal }),
        },
      ],
    ]);
  options.signal.throwIfAborted();
  const token = randomBytes(32).toString("base64url");
  const clients = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  let closed = false;
  let origin = "";
  let revision = 0;
  let closing: Promise<void> | undefined;
  const frame = () =>
    `id: ${revision}\ndata: ${JSON.stringify({ protocol: 1, generation: options.generation, revision })}\n\n`;
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const fail = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(message);
    };
    if (closed || options.signal.aborted) return fail(410, "Session closed");
    if (
      req.headers.host !== origin.slice("http://".length) ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return fail(403, "Forbidden");
    if (req.method !== "GET") return fail(405, "Read-only viewer");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", origin);
    } catch {
      return fail(400, "Invalid URL");
    }
    if (url.origin !== origin) return fail(403, "Forbidden");
    const asset = assets.get(url.pathname);
    if (asset && !url.search) {
      res.writeHead(200, { "Content-Type": asset.type });
      // Generation is a public epoch identifier, not a credential. Encoding keeps the HTML boundary inert.
      const body =
        url.pathname === "/"
          ? asset.body
              .toString()
              .replace(
                "<head>",
                `<head><meta name="inspector-generation" content="${encodeURIComponent(options.generation)}">`,
              )
          : asset.body;
      res.end(body);
      return;
    }
    if (!url.pathname.startsWith("/api/")) return fail(404, "Not found");
    const provided = req.headers["x-inspector-token"];
    if (
      typeof provided !== "string" ||
      Buffer.byteLength(provided) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
    )
      return fail(401, "Unauthorized");
    if (url.searchParams.get("generation") !== options.generation) return fail(409, "Session generation changed");
    if (url.pathname === "/api/events") {
      if (clients.size >= 8) return fail(429, "Too many viewers");
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      clients.add(res);
      res.on("close", () => clients.delete(res));
      sendRevision(res, frame());
      return;
    }
    try {
      let result: unknown;
      if (url.pathname === "/api/snapshot") result = options.snapshot();
      else if (url.pathname === "/api/branch") {
        const offset = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,8}$/.test(offset)) return fail(400, "Invalid offset");
        result = options.branch(url.searchParams.get("leaf") ?? "", Number(offset));
      } else if (url.pathname === "/api/detail") {
        result = options.detail(url.searchParams.get("id") ?? "", url.searchParams.get("leaf") ?? "");
      } else return fail(404, "Not found");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    } catch {
      fail(400, "Unavailable session data");
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  server.on("connection", (socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    options.signal.removeEventListener("abort", abort);
    for (const client of clients) client.destroy();
    clients.clear();
    for (const socket of sockets) socket.destroy();
    closing = new Promise((resolve) => server.close(() => resolve()));
    return closing;
  };
  const abort = () => {
    void close();
  };
  // Register before listen, and recheck after readiness to cover abort during startup.
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => reject(new Error("Server startup cancelled"));
      options.signal.addEventListener("abort", cancelled, { once: true });
      const failed = (error: Error) => {
        options.signal.removeEventListener("abort", cancelled);
        reject(error);
      };
      server.once("error", failed);
      server.listen({ port: 0, host: "127.0.0.1", signal: options.signal }, () => {
        options.signal.removeEventListener("abort", cancelled);
        server.removeListener("error", failed);
        resolve();
      });
    });
    options.signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("No loopback address");
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    token,
    origin,
    url: `${origin}/#${token}`,
    invalidate(next) {
      if (!closed) {
        revision = next;
        for (const res of clients) sendRevision(res, frame());
      }
    },
    close,
  };
}
