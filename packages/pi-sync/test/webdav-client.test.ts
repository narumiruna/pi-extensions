import assert from "node:assert/strict";
import { test } from "vitest";
import { WebDavClient } from "../src/backends/webdav/webdav-client.js";
import { MockWebDavServer, webDavConfig } from "./mock-webdav-server.js";

test("WebDAV client rejects unsafe authenticated base URLs", () => {
  const insecure = webDavConfig("http://example.com/dav/");
  assert.throws(() => new WebDavClient(insecure), /HTTPS is required/);
  const embedded = webDavConfig("https://user:password@example.com/dav/");
  assert.throws(() => new WebDavClient(embedded), /embedded credentials/);
});

test("WebDAV client authenticates, encodes paths, creates collections, and lists them", async () => {
  const server = await new MockWebDavServer().start();
  try {
    const client = new WebDavClient(webDavConfig(server.url));
    await client.ensureCollection("folder with space/child");
    await client.putBuffer("folder with space/child/value.json", Buffer.from("ok"), "application/json", {
      ifAbsent: true,
    });
    assert.equal((await client.getBuffer("folder with space/child/value.json")).value?.toString(), "ok");
    assert.ok(
      (await client.listCollection("folder with space/child")).some((entry) => entry.href.endsWith("value.json")),
    );
    assert.ok(server.requests.every((request) => request.headers.authorization?.startsWith("Basic ")));
  } finally {
    await server.close();
  }
});

test("WebDAV client reports authentication and malformed listing errors without secrets", async () => {
  const server = await new MockWebDavServer({ malformedXml: true }).start();
  try {
    const config = webDavConfig(server.url);
    const client = new WebDavClient(config);
    await assert.rejects(client.listCollection("missing"), /collection is missing/);
    await client.ensureCollection("list");
    await assert.rejects(client.listCollection("list"), /malformed/);
    config.profile.password = "wrong-private-password";
    await assert.rejects(
      new WebDavClient(config).getBuffer("item"),
      (error: unknown) =>
        error instanceof Error &&
        /authentication|required|HTTP 401/i.test(error.message) &&
        !error.message.includes("wrong-private-password"),
    );
  } finally {
    await server.close();
  }
});

test("WebDAV client redacts percent-encoded usernames from error bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("principal alice%40example.com denied", {
      status: 403,
    })) as typeof globalThis.fetch;
  try {
    const config = webDavConfig("http://127.0.0.1:1/dav/");
    config.profile.username = "alice@example.com";
    await assert.rejects(
      new WebDavClient(config).getBuffer("item"),
      (error: unknown) =>
        error instanceof Error &&
        /HTTP 403/.test(error.message) &&
        !error.message.includes("alice@example.com") &&
        !error.message.includes("alice%40example.com"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebDAV client cancels response bodies on early 404 and 412 exits", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  const responses = [404, 404, 404, 412];
  globalThis.fetch = (async () => {
    const status = responses.shift() ?? 500;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }),
      { status },
    );
  }) as typeof globalThis.fetch;
  try {
    const client = new WebDavClient(webDavConfig("http://127.0.0.1:1/dav/"));
    assert.equal((await client.getBuffer("missing")).missing, true);
    assert.equal((await client.getJson("missing")).missing, true);
    await assert.rejects(client.listCollection("missing"), /missing/);
    await assert.rejects(
      client.putBuffer("item", Buffer.from("value"), "text/plain", { ifAbsent: true }),
      /precondition/i,
    );
    assert.equal(cancelled, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebDAV client refuses ambiguous redirects for mutating requests", async () => {
  const options: { redirectTo?: string } = {};
  const server = await new MockWebDavServer(options).start();
  options.redirectTo = `${server.url}canonical`;
  try {
    await assert.rejects(
      new WebDavClient(webDavConfig(server.url)).putBuffer("item", Buffer.from("secret"), "application/octet-stream"),
      /ambiguous HTTP 302 redirect for PUT/,
    );
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("WebDAV client rejects cross-origin authenticated redirects", async () => {
  const server = await new MockWebDavServer({ redirectTo: "http://127.0.0.1:1/stolen" }).start();
  try {
    await assert.rejects(
      new WebDavClient(webDavConfig(server.url)).getBuffer("item"),
      /cross-origin authenticated redirect/,
    );
  } finally {
    await server.close();
  }
});

test("WebDAV client bounds JSON responses", async () => {
  const server = await new MockWebDavServer().start();
  try {
    server.resources.set("/dav/large.json", Buffer.alloc(1024 * 1024 + 1, 65));
    await assert.rejects(new WebDavClient(webDavConfig(server.url)).getJson("large.json"), /too large/);
  } finally {
    await server.close();
  }
});

test("WebDAV client honors caller cancellation and request timeout", async () => {
  const server = await new MockWebDavServer({ delayMs: 100 }).start();
  try {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(
      new WebDavClient(webDavConfig(server.url), controller.signal).getBuffer("item"),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await assert.rejects(new WebDavClient(webDavConfig(server.url), undefined, 10).getBuffer("item"), /request failed/);
  } finally {
    await server.close();
  }
});
