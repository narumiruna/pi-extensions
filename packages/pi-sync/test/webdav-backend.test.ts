import assert from "node:assert/strict";
import { test } from "vitest";
import { SyncBackendPublicationOutcomeUnknownError } from "../src/backends/sync-backend.js";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { snapshot } from "./helpers.js";
import { MockWebDavServer, webDavConfig } from "./mock-webdav-server.js";

test("WebDAV doctor verifies conditional publication and cleans its probe", async () => {
  const server = await new MockWebDavServer().start();
  try {
    const backend = new WebDavSyncBackend(webDavConfig(server.url));
    assert.equal(backend.capability, "conditional-required");
    const diagnostics = await backend.diagnose();
    assert.equal(backend.capability, "atomic-conditional");
    assert.ok(diagnostics.some((item) => item.message.includes("atomic-conditional (verified)")));
    assert.ok(diagnostics.some((item) => item.message.includes("cleanup: ok")));
    assert.ok(diagnostics.some((item) => /temporary write\/delete probe; repair/u.test(item.message)));
    assert.equal(
      [...server.resources.keys()].some((key) => key.includes(".pi-sync-probes")),
      false,
    );
  } finally {
    await server.close();
  }
});

test("WebDAV diagnostics honor caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const backend = new WebDavSyncBackend(webDavConfig("http://127.0.0.1:1/dav/"));
  await assert.rejects(
    backend.diagnose(controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("WebDAV cancellation before and after the commit boundary is classified correctly", async () => {
  const delayedOptions: { delayMs?: number } = { delayMs: 30 };
  const delayed = await new MockWebDavServer(delayedOptions).start();
  try {
    const controller = new AbortController();
    const publication = new WebDavSyncBackend(webDavConfig(delayed.url)).publishSnapshot(
      snapshot([]),
      { kind: "missing" },
      { signal: controller.signal },
    );
    while (delayed.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(publication, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(delayed.resources.has("/dav/pi-sync/latest.json"), false);
  } finally {
    await delayed.close();
  }

  const server = await new MockWebDavServer().start();
  try {
    const controller = new AbortController();
    const result = await new WebDavSyncBackend(webDavConfig(server.url)).publishSnapshot(
      snapshot([]),
      { kind: "missing" },
      {
        signal: controller.signal,
        onCommit: () => controller.abort(new DOMException("late cancel", "AbortError")),
      },
    );
    assert.equal(result.head.snapshotId, "snap");
    assert.equal(controller.signal.aborted, true);
  } finally {
    await server.close();
  }
});

test("WebDAV servers with non-rotating strong ETags remain read-only", async () => {
  const server = await new MockWebDavServer({ constantEtag: true }).start();
  try {
    const backend = new WebDavSyncBackend(webDavConfig(server.url));
    await assert.rejects(backend.publishSnapshot(snapshot([]), { kind: "missing" }), /strong ETag|rotate|changed/i);
    assert.equal(backend.capability, "conditional-required");
  } finally {
    await server.close();
  }
});

test.each(["pi-sync", "./"])("WebDAV servers that ignore preconditions remain read-only at %s", async (storagePath) => {
  const server = await new MockWebDavServer({ ignoreConditions: true }).start();
  try {
    const config = webDavConfig(server.url);
    config.destination.path = storagePath;
    const backend = new WebDavSyncBackend(config);
    await assert.rejects(
      backend.publishSnapshot(snapshot([]), { kind: "missing" }),
      /ignored If-None-Match|read-only/i,
    );
    assert.ok(![...server.resources.keys()].some((key) => key.endsWith("/latest.json")));
    assert.ok((await backend.diagnose()).some((item) => item.level === "error"));
    assert.equal(backend.capability, "conditional-required");
  } finally {
    await server.close();
  }
});

test("WebDAV rejects control-bearing remote pointer metadata and references", async () => {
  for (const unsafe of [
    { snapshot: "snapshot", machine: "unsafe\u001b[31m" },
    { snapshot: "unsafe\u009b31m", machine: "machine" },
  ]) {
    const server = await new MockWebDavServer().start();
    try {
      server.resources.set(
        "/dav/pi-sync/latest.json",
        Buffer.from(
          JSON.stringify({
            version: 1,
            profile: "default",
            snapshot: unsafe.snapshot,
            sha256: "a".repeat(64),
            createdAt: "2026-01-01T00:00:00.000Z",
            machine: unsafe.machine,
          }),
        ),
      );
      await assert.rejects(new WebDavSyncBackend(webDavConfig(server.url)).readHead(), /malformed/);
    } finally {
      await server.close();
    }
  }
});

test("WebDAV weak or missing ETags fail closed", async () => {
  for (const etag of ["weak", "missing"] as const) {
    const server = await new MockWebDavServer({ etag }).start();
    try {
      await assert.rejects(
        new WebDavSyncBackend(webDavConfig(server.url)).publishSnapshot(snapshot([]), {
          kind: "missing",
        }),
        /strong ETag/,
      );
    } finally {
      await server.close();
    }
  }
});

test("WebDAV revalidates conditional support before every publication", async () => {
  const options: { ignoreConditions?: boolean } = {};
  const server = await new MockWebDavServer(options).start();
  try {
    const backend = new WebDavSyncBackend(webDavConfig(server.url));
    const first = snapshot([]);
    const head = (await backend.publishSnapshot(first, { kind: "missing" })).head;
    options.ignoreConditions = true;
    await assert.rejects(
      backend.publishSnapshot({ ...first, id: "unsafe-second" }, { kind: "revision", revision: head.revision }),
      /ignored If-None-Match|read-only/i,
    );
    assert.equal((await backend.readHead())?.snapshotId, first.id);
    assert.equal(backend.capability, "conditional-required");
  } finally {
    await server.close();
  }
});

test("WebDAV opaque revisions retain If-Match across backend instances", async () => {
  const server = await new MockWebDavServer().start();
  try {
    const config = webDavConfig(server.url);
    const first = snapshot([]);
    const firstHead = (await new WebDavSyncBackend(config).publishSnapshot(first, { kind: "missing" })).head;
    const observed = await new WebDavSyncBackend(config).readHead();
    assert.equal(observed?.revision, firstHead.revision);
    const second = { ...first, id: "second", createdAt: "2026-01-02T00:00:00.000Z" };
    const result = await new WebDavSyncBackend(config).publishSnapshot(second, {
      kind: "revision",
      revision: observed?.revision ?? "missing",
    });
    assert.equal(result.head.snapshotId, "second");
    assert.ok(
      server.requests.some(
        (request) => request.path.endsWith("/latest.json") && typeof request.headers["if-match"] === "string",
      ),
    );
  } finally {
    await server.close();
  }
});

test("WebDAV doctor repairs a missing active snapshot history entry", async () => {
  const options: { failHistoryPut?: boolean } = { failHistoryPut: true };
  const server = await new MockWebDavServer(options).start();
  try {
    const backend = new WebDavSyncBackend(webDavConfig(server.url));
    const published = await backend.publishSnapshot(snapshot([]), { kind: "missing" });
    assert.match(published.warnings.join("\n"), /history could not be updated/);
    assert.deepEqual(await backend.listHistory(), []);

    options.failHistoryPut = false;
    const diagnostics = await backend.diagnose();
    assert.ok(diagnostics.some((item) => /history.*repaired/i.test(item.message)));
    assert.deepEqual(
      (await backend.listHistory()).map((item) => item.snapshotId),
      ["snap"],
    );
  } finally {
    await server.close();
  }
});

test("WebDAV active-head transport failures report an unknown publication outcome", async () => {
  const server = await new MockWebDavServer({ failLatestPut: true }).start();
  try {
    await assert.rejects(
      new WebDavSyncBackend(webDavConfig(server.url)).publishSnapshot(snapshot([]), {
        kind: "missing",
      }),
      SyncBackendPublicationOutcomeUnknownError,
    );
  } finally {
    await server.close();
  }
});

test("WebDAV authentication and permission diagnostics remain actionable", async () => {
  for (const setup of [
    { options: { username: "other", password: "other" }, expected: /HTTP 401/ },
    { options: { deny: true }, expected: /HTTP 403/ },
  ] as const) {
    const server = await new MockWebDavServer(setup.options).start();
    try {
      const output = (await new WebDavSyncBackend(webDavConfig(server.url)).diagnose())
        .map((item) => item.message)
        .join("\n");
      assert.match(output, setup.expected);
      assert.match(output, /read-only/);
      assert.match(output, /credentials and remote permissions/u);
      assert.doesNotMatch(output, /Basic [A-Za-z0-9+/=]+/);
    } finally {
      await server.close();
    }
  }
});

test("WebDAV probe cleanup failures are explicit without exposing credentials", async () => {
  for (const cleanupOptions of [{ cleanupFails: true }, { cleanupMultiStatus: true }]) {
    const server = await new MockWebDavServer({
      ...cleanupOptions,
      username: "private-user",
      password: "private-password",
    }).start();
    try {
      const config = webDavConfig(server.url);
      config.profile.username = "private-user";
      config.profile.password = "private-password";
      const backend = new WebDavSyncBackend(config);
      const diagnostics = await backend.diagnose();
      const output = diagnostics.map((item) => item.message).join("\n");
      assert.match(output, /cleanup (also )?failed/);
      assert.doesNotMatch(output, /private-user|private-password/);
      assert.equal(backend.capability, "conditional-required");
    } finally {
      await server.close();
    }
  }
});
