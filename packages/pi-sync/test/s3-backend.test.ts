import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import type { LatestPointer } from "../src/backends/backend-types.js";
import { S3SyncBackend, snapshotKey } from "../src/backends/s3/s3-backend.js";
import {
  expectedRemoteHead,
  SyncBackendConflictError,
  SyncBackendPublicationOutcomeUnknownError,
} from "../src/backends/sync-backend.js";
import type { SyncConfig } from "../src/settings/settings-types.js";
import type { Snapshot } from "../src/snapshot/snapshot-types.js";
import { createSyncBackend } from "./backend-factory-eager.js";
import { snapshot } from "./helpers.js";
import { s3ClientConfig, startS3TestServer } from "./s3-http-test-helpers.js";
import { S3ProbeHarness } from "./s3-probe-harness.js";

test("S3 factory exposes a stable secret-free identity, conditional capability, and read-only diagnostics", async () => {
  const config = s3Config();
  const backend = createSyncBackend(config);
  const sameDestination = createSyncBackend({
    ...config,
    backend: {
      ...config.backend,
      profile: {
        ...config.backend.profile,
        endpoint: `${config.backend.profile.endpoint}/`,
        accessKeyId: "different-access",
        secretAccessKey: "different-secret",
        sessionToken: "different-token",
      },
    },
    setupName: "other-local-setup",
  });

  assert.equal(backend.identity, sameDestination.identity);
  assert.equal(backend.capability, "conditional-required");
  assert.doesNotMatch(backend.identity, /access-key|secret-key|different/);
  assert.match(backend.destination, /example\.r2\.cloudflarestorage\.com/);
  await new S3Harness(snapshot([])).run(async () => {
    const diagnostics = await backend.diagnose();
    assert.deepEqual(diagnostics[0], {
      key: "s3-config",
      level: "info",
      message: "s3 config: ok (pi-sync-test/pi-sync)",
    });
    assert.equal(diagnostics[1]?.key, "s3-read");
    assert.match(diagnostics[1]?.message ?? "", /HTTP success/u);
  });
  assert.equal(
    backend.identity,
    createSyncBackend({
      ...config,
      snapshotIdentity: "work",
      backend: {
        ...config.backend,
        destination: { ...config.backend.destination, namespace: "work" },
      },
    }).identity,
  );
  assert.notEqual(
    backend.identity,
    createSyncBackend({
      ...config,
      backend: {
        ...config.backend,
        destination: { ...config.backend.destination, prefix: "pi-sync/work" },
      },
    }).identity,
  );
});

test("S3 loopback preserves an existing head when ignore policy changes at publication", async () => {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  const server = await startS3TestServer((request, response) => {
    const current = objects.get(request.path);
    if (request.method === "GET" || request.method === "HEAD") {
      if (!current) return void response.writeHead(404).end();
      return void response
        .writeHead(200, { etag: current.etag })
        .end(request.method === "GET" ? current.body : undefined);
    }
    if (request.method === "DELETE") {
      objects.delete(request.path);
      return void response.writeHead(204).end();
    }
    assert.equal(request.method, "PUT");
    if (
      (current && request.headers["if-none-match"] === "*") ||
      (request.headers["if-match"] && request.headers["if-match"] !== current?.etag)
    ) {
      return void response.writeHead(412).end();
    }
    const etag = `"${createHash("sha256").update(request.body).digest("hex")}"`;
    objects.set(request.path, { body: request.body, etag });
    response.writeHead(200, { etag }).end();
  });
  try {
    const backend = new S3SyncBackend(s3ClientConfig(server.url));
    const legacy = snapshot([{ path: "notes.md", content: Buffer.from("existing") }]);
    const first = await backend.publishSnapshot(legacy, { kind: "missing" });
    const next: Snapshot = {
      ...legacy,
      id: "ignore-activation",
      version: 6,
      selection: { version: 4, scope: "agent-directory", sessions: false, fingerprint: "a".repeat(64) },
    };
    await assert.rejects(
      backend.publishSnapshot(next, expectedRemoteHead(first.head), {
        validateIgnorePolicy: async () => {
          if (
            server.requests.some(({ method, path }) => method === "PUT" && path.endsWith("/ignore-activation.json.gz"))
          ) {
            throw new Error("ignore policy changed before head publication");
          }
        },
      }),
      /ignore policy changed/u,
    );
    assert.deepEqual(await backend.readHead(), first.head);
    const published = await backend.publishSnapshot(next, expectedRemoteHead(first.head));
    assert.deepEqual(await backend.readSnapshot(published.head.snapshotRef), next);
    assert.deepEqual(await backend.readSnapshot(first.head.snapshotRef), legacy);
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

test("S3 backend reads an opaque revision and validates immutable snapshot checksums", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const head = await backend.readHead();
    assert.equal(head?.snapshotRef, remote.id);
    assert.equal(head?.snapshotId, remote.id);
    assert.match(head?.revision ?? "", /^s3:/);
    const otherConfig = s3Config();
    otherConfig.backend.profile.endpoint = "https://other.example.com";
    const otherIdentityHead = await createSyncBackend(otherConfig).readHead();
    assert.notEqual(head?.revision, otherIdentityHead?.revision);
    assert.deepEqual(await backend.readSnapshot(remote.id), remote);
    harness.corruptSnapshot(remote.id);
    const freshBackend = createSyncBackend(s3Config());
    await assert.rejects(freshBackend.readSnapshot(remote.id), /checksum mismatch/i);
    await assert.rejects(createSyncBackend(s3Config()).readSnapshot("untracked"), /snapshot not found/i);
    const historical = { ...remote, id: "historical" };
    harness.addHistorical(historical);
    harness.corruptSnapshot(historical.id);
    const historyBackend = createSyncBackend(s3Config());
    await historyBackend.listHistory();
    await assert.rejects(historyBackend.readSnapshot(historical.id), /checksum mismatch/i);
  });
});

test("S3 rejects unsafe snapshot references and mismatched immutable bundle identities", async () => {
  const config = s3Config();
  assert.throws(() => snapshotKey(config.backend, "../foreign"), /snapshot reference/i);
  const unsafeDestination = s3Config();
  unsafeDestination.backend.destination.prefix = "../foreign";
  assert.throws(() => createSyncBackend(unsafeDestination), /storage location/i);

  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  harness.replaceSnapshotPayload(remote.id, { ...remote, id: "different-id" });
  await harness.run(async () => {
    const backend = createSyncBackend(config);
    const head = await backend.readHead();
    await assert.rejects(backend.readSnapshot(head?.snapshotRef ?? ""), /identity mismatch/i);
    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "candidate", profile: "other" }, expectedRemoteHead(head)),
      /snapshot identity/i,
    );
  });
});

test("S3 rejects control-bearing or oversized remote display metadata", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  harness.replacePointerMetadata({
    machine: `host\u001b]8;;https://evil.example\u0007`,
    createdAt: "x".repeat(65),
  });
  await harness.run(async () => {
    await assert.rejects(createSyncBackend(s3Config()).readHead(), /malformed/i);
  });
});

test("S3 retained snapshots remain recoverable after history gaps and eviction", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const upload = { ...remote, id: "upload" };
  const harness = new S3Harness(remote);
  harness.failHistory = true;
  await harness.run(async () => {
    const writer = createSyncBackend(s3Config());
    const observed = await writer.readHead();
    await writer.publishSnapshot(upload, expectedRemoteHead(observed));
    harness.failHistory = false;
    harness.replaceHead({ ...remote, id: "advanced" });
    assert.deepEqual(await createSyncBackend(s3Config()).readSnapshot(upload.id), upload);
    harness.addHistorical(upload);
    harness.clearHistory();
    assert.deepEqual(await createSyncBackend(s3Config()).readSnapshot(upload.id), upload);
  });
});

test("S3 checksum registration rejects immutable-reference rebinding in either read order", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const changed = {
    ...remote,
    files: snapshot([{ path: "settings.json", content: Buffer.from("changed") }]).files,
  };

  const historyFirst = new S3Harness(remote);
  historyFirst.addHistorical(remote);
  await historyFirst.run(async () => {
    const backend = createSyncBackend(s3Config());
    await backend.listHistory();
    historyFirst.replaceHead(changed);
    await assert.rejects(backend.readHead(), /rebound/i);
  });

  const headFirst = new S3Harness(remote);
  await headFirst.run(async () => {
    const backend = createSyncBackend(s3Config());
    await backend.readHead();
    headFirst.addHistorical(changed);
    await assert.rejects(backend.listHistory(), /conflicts|rebound/i);
  });
});

test("S3 malformed history cannot partially prime snapshot integrity state", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const historical = { ...remote, id: "historical" };
  const harness = new S3Harness(remote);
  harness.addHistorical(historical);
  harness.addMalformedHistoryEntry();
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    await assert.rejects(backend.listHistory(), /history entry/i);
    await assert.rejects(backend.readSnapshot(historical.id), /history entry/i);
  });
});

test("S3 publication never overwrites an existing immutable snapshot id", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const observed = await backend.readHead();
    await assert.rejects(
      backend.publishSnapshot(
        {
          ...remote,
          files: snapshot([{ path: "settings.json", content: Buffer.from("different") }]).files,
        },
        expectedRemoteHead(observed),
      ),
      SyncBackendConflictError,
    );
    const idempotent = await backend.publishSnapshot(remote, expectedRemoteHead(observed));
    assert.equal(idempotent.head.snapshotId, remote.id);
  });
});

test("S3 publication stages immutably and rejects an observed stale revision", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const observed = await backend.readHead();
    harness.replaceHead({ ...remote, id: "advanced" });

    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "local" }, expectedRemoteHead(observed)),
      SyncBackendConflictError,
    );
    assert.equal(harness.snapshotPuts, 1);
    assert.equal(harness.latestPuts, 0);
  });
});

test("S3 publication returns the committed head and reports history repair separately", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const upload = { ...remote, id: "upload", createdAt: "2026-01-02T00:00:00.000Z" };
  const harness = new S3Harness(remote);
  harness.failHistory = true;
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const observed = await backend.readHead();
    let commits = 0;
    const result = await backend.publishSnapshot(upload, expectedRemoteHead(observed), {
      onCommit: () => {
        assert.equal(harness.snapshotPuts, 1);
        assert.equal(harness.latestPuts, 0);
        commits += 1;
      },
    });

    assert.equal(commits, 1);
    assert.equal(result.head.snapshotRef, upload.id);
    assert.equal(harness.latestPuts, 1);
    assert.equal(harness.historyPuts, 1);
    assert.match(result.warnings.join("\n"), /history could not be updated/);
  });
});

test("S3 publication reports an observed post-commit race as a typed conflict", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  harness.replaceAfterLatest = true;
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const observed = await backend.readHead();
    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "upload" }, expectedRemoteHead(observed)),
      (error: unknown) => {
        assert.ok(error instanceof SyncBackendConflictError);
        assert.equal(error.phase, "after-commit");
        assert.equal(error.currentHead?.snapshotId, "upload");
        assert.equal(error.candidateMayHaveBeenActive, true);
        return true;
      },
    );
  });
});

test("S3 publication bounds active-head commit and verification after the commit boundary", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  harness.hangLatest = true;
  await harness.run(async () => {
    const backend = new S3SyncBackend(s3Config().backend, 5);
    const observed = await backend.readHead();
    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "upload" }, expectedRemoteHead(observed)),
      SyncBackendPublicationOutcomeUnknownError,
    );
  });
});

test("S3 publication classifies active-head write failures as outcome unknown", async () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("remote") }]);
  const harness = new S3Harness(remote);
  harness.failLatest = true;
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const observed = await backend.readHead();
    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "upload" }, expectedRemoteHead(observed)),
      SyncBackendPublicationOutcomeUnknownError,
    );
  });
});

test.each([412, 409])("S3 conditional publication rejection %s is a proven pre-commit conflict", async (status) => {
  const remote = snapshot([]);
  const harness = new S3Harness(remote);
  harness.rejectLatest = status;
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const head = await backend.readHead();
    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "candidate" }, expectedRemoteHead(head)),
      (error: unknown) => {
        assert.ok(error instanceof SyncBackendConflictError);
        assert.equal(error.phase, "before-commit");
        assert.equal(error.candidateMayHaveBeenActive, false);
        return true;
      },
    );
    assert.equal(harness.latestCondition, '"latest-1"');
    assert.match(harness.latestSignedHeaders, /SignedHeaders=[^ ]*if-match/u);
    assert.equal(harness.historyPuts, 0);
    assert.equal((await backend.readHead())?.snapshotId, remote.id);
  });
});

test("S3 writer racing after the last read cannot be overwritten", async () => {
  const remote = snapshot([]);
  const harness = new S3Harness(remote);
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const head = await backend.readHead();
    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "candidate" }, expectedRemoteHead(head), {
        onCommit: () => harness.replaceHead({ ...remote, id: "winner" }),
      }),
      SyncBackendConflictError,
    );
    assert.equal((await backend.readHead())?.snapshotId, "winner");
    assert.equal(harness.historyPuts, 0);
  });
});

test.each(["if-match", "if-none-match", "missing-etag", "unchanged-etag", "cleanup"] as const)(
  "S3 unsafe capability %s stops before staging or publication",
  async (mode) => {
    const remote = snapshot([]);
    const harness = new S3Harness(remote);
    if (mode === "if-match" || mode === "if-none-match") harness.probes.ignore = mode;
    if (mode === "missing-etag") harness.probes.missingEtag = true;
    if (mode === "unchanged-etag") harness.probes.unchangedEtag = true;
    if (mode === "cleanup") harness.probes.failCleanup = true;
    await harness.run(async () => {
      const backend = createSyncBackend(s3Config());
      await assert.rejects(
        backend.publishSnapshot({ ...remote, id: "candidate" }, expectedRemoteHead(await backend.readHead())),
        /precondition|ETag|cleanup/u,
      );
      assert.equal(harness.snapshotPuts, 0);
      assert.equal(harness.latestPuts, 0);
      assert.equal(harness.probes.objects.size, mode === "cleanup" ? 1 : 0);
    });
  },
);

test("S3 cancellation during capability verification cleans the probe without publication", async () => {
  const remote = snapshot([]);
  const harness = new S3Harness(remote);
  const owner = new AbortController();
  harness.probes.onPut = () => owner.abort();
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    await assert.rejects(
      backend.publishSnapshot({ ...remote, id: "candidate" }, expectedRemoteHead(await backend.readHead()), {
        signal: owner.signal,
      }),
      { name: "AbortError" },
    );
    assert.equal(harness.latestPuts, 0);
    assert.equal(harness.probes.objects.size, 0);
  });
});

test("S3 first publication uses a signed create-only condition", async () => {
  const remote = snapshot([]);
  const harness = new S3Harness(remote);
  harness.missingHead = true;
  await harness.run(async () => {
    const result = await createSyncBackend(s3Config()).publishSnapshot({ ...remote, id: "first" }, { kind: "missing" });
    assert.equal(result.head.snapshotId, "first");
    assert.equal(harness.latestCondition, "*");
    assert.match(harness.latestSignedHeaders, /SignedHeaders=[^ ]*if-none-match/u);
    assert.equal(harness.probes.objects.size, 0);
  });
});

test("S3 competing first publisher is never overwritten", async () => {
  const remote = snapshot([]);
  const harness = new S3Harness(remote);
  harness.missingHead = true;
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    await assert.rejects(
      backend.publishSnapshot(
        { ...remote, id: "first" },
        { kind: "missing" },
        {
          onCommit: () => {
            harness.missingHead = false;
            harness.replaceHead({ ...remote, id: "winner" });
          },
        },
      ),
      SyncBackendConflictError,
    );
    assert.equal((await backend.readHead())?.snapshotId, "winner");
  });
});

test("S3 legacy weak-read revisions match only unchanged heads for inactive recovery, never publication", async () => {
  const harness = new S3Harness(snapshot([]));
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    harness.weakHeadEtag = true;
    const legacy = await backend.readHead();
    assert.ok(legacy);
    harness.weakHeadEtag = false;
    const current = await backend.readHead();
    assert.ok(current);
    assert.equal(backend.sameRevision(current.revision, legacy.revision), false);
    assert.equal(backend.matchesUncommittedRecoveryHead?.(current, legacy), true);
    await assert.rejects(
      backend.publishSnapshot({ ...snapshot([]), id: "candidate" }, expectedRemoteHead(legacy)),
      SyncBackendConflictError,
    );
    assert.equal(harness.latestPuts, 0);
    harness.replacePointerMetadata({ machine: "different-machine" });
    const changed = await backend.readHead();
    assert.ok(changed);
    assert.equal(backend.matchesUncommittedRecoveryHead?.(changed, legacy), false);
    assert.equal(backend.matchesUncommittedRecoveryHead?.(current, legacy), false);
    harness.missingHead = true;
    await backend.readHead();
    assert.equal(backend.matchesUncommittedRecoveryHead?.(current, legacy), false);
  });
});

test("S3 weak current ETags cannot supply a strong-read recovery alias", async () => {
  const harness = new S3Harness(snapshot([]));
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    harness.weakHeadEtag = true;
    const legacy = await backend.readHead();
    harness.weakHeadEtag = false;
    const current = await backend.readHead();
    assert.ok(legacy && current);
    assert.equal(backend.matchesUncommittedRecoveryHead?.(current, legacy), true);
    harness.weakHeadEtag = true;
    await backend.readHead();
    assert.equal(backend.matchesUncommittedRecoveryHead?.(current, legacy), false);
  });
});

test("S3 publication preserves strong JSON ETags by avoiding transfer compression", async () => {
  const remote = snapshot([]);
  const harness = new S3Harness(remote);
  harness.compressJson = true;
  harness.addHistorical(remote);
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const result = await backend.publishSnapshot(
      { ...remote, id: "candidate" },
      expectedRemoteHead(await backend.readHead()),
    );
    assert.equal(result.head.snapshotId, "candidate");
    assert.deepEqual(result.warnings, []);
    assert.equal(harness.latestCondition, '"latest-1"');
    assert.equal(harness.latestPuts, 1);
    assert.equal(harness.historyPuts, 1);
    assert.equal((await backend.listHistory()).length, 2);
  });
});

test.each(["missing", "weak"] as const)(
  "S3 existing pointer with a %s ETag cannot enter the commit boundary",
  async (mode) => {
    const harness = new S3Harness(snapshot([]));
    harness.missingHeadEtag = mode === "missing";
    harness.weakHeadEtag = mode === "weak";
    await harness.run(async () => {
      const backend = createSyncBackend(s3Config());
      const expected = expectedRemoteHead(await backend.readHead());
      await assert.rejects(
        backend.publishSnapshot({ ...snapshot([]), id: "candidate" }, expected, {
          onCommit: () => assert.fail("commit began"),
        }),
        /strong ETag/u,
      );
      assert.equal(harness.latestPuts, 0);
    });
  },
);

test("S3 history contention preserves the active publication with a warning", async () => {
  const harness = new S3Harness(snapshot([]));
  harness.rejectHistory = true;
  await harness.run(async () => {
    const backend = createSyncBackend(s3Config());
    const result = await backend.publishSnapshot(
      { ...snapshot([]), id: "candidate" },
      expectedRemoteHead(await backend.readHead()),
    );
    assert.equal(result.head.snapshotId, "candidate");
    assert.match(result.warnings.join("\n"), /history could not be updated/u);
    assert.equal((await backend.listHistory()).length, 0);
  });
});

function s3Config(): SyncConfig {
  return {
    backend: {
      type: "s3",
      profile: {
        kind: "r2",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
      destination: { bucket: "pi-sync-test", prefix: "pi-sync", namespace: "default" },
    },
    setupName: "default",
    connectionName: "default",
    storagePath: "pi-sync",
    snapshotIdentity: "default",
    include: [],
    automatic: false,
    onSwitch: "switch-only",
    skipSecretScan: false,
    showStatus: true,
  };
}

class S3Harness {
  private originalFetch = globalThis.fetch;
  private snapshots = new Map<string, Buffer>();
  private pointer: LatestPointer;
  private historyPointers: LatestPointer[] = [];
  private etagRevision = 1;
  private replaceOnNextLatestRead = false;
  snapshotPuts = 0;
  latestPuts = 0;
  historyPuts = 0;
  failLatest = false;
  missingHead = false;
  missingHeadEtag = false;
  weakHeadEtag = false;
  compressJson = false;
  rejectLatest?: number;
  rejectHistory = false;
  latestSignedHeaders = "";
  latestCondition: string | null = null;
  hangLatest = false;
  failHistory = false;
  replaceAfterLatest = false;

  constructor(initial: Snapshot) {
    const encoded = encode(initial);
    this.snapshots.set(initial.id, encoded);
    this.pointer = pointer(initial, encoded);
  }

  addHistorical(value: Snapshot) {
    const encoded = encode(value);
    this.snapshots.set(value.id, encoded);
    this.historyPointers.push(pointer(value, encoded));
  }

  clearHistory() {
    this.historyPointers = [];
  }

  addMalformedHistoryEntry() {
    this.historyPointers.push({ ...this.pointer, snapshot: "../foreign" });
  }

  corruptSnapshot(reference: string) {
    this.snapshots.set(reference, Buffer.from("corrupt"));
  }

  replaceSnapshotPayload(reference: string, value: Snapshot) {
    const encoded = encode(value);
    this.snapshots.set(reference, encoded);
    this.pointer = {
      ...this.pointer,
      sha256: createHash("sha256").update(encoded).digest("hex"),
    };
  }

  replacePointerMetadata(value: Partial<LatestPointer>) {
    this.pointer = { ...this.pointer, ...value };
  }

  replaceHead(value: Snapshot) {
    const encoded = encode(value);
    this.snapshots.set(value.id, encoded);
    this.pointer = pointer(value, encoded);
    this.etagRevision += 1;
  }

  async run<T>(fn: () => Promise<T>) {
    globalThis.fetch = this.fetch as typeof globalThis.fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = this.originalFetch;
    }
  }

  readonly probes = new S3ProbeHarness();

  private fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const probe = this.probes.handle(input, init);
    if (probe) return probe;
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/latest.json")) {
      if (method === "PUT") {
        this.latestPuts += 1;
        if (this.hangLatest) return hangingResponse(init?.signal);
        if (this.failLatest) return new Response("latest failed", { status: 503 });
        const headers = new Headers(init?.headers);
        this.latestCondition = headers.get("if-match") ?? headers.get("if-none-match");
        this.latestSignedHeaders = headers.get("authorization") ?? "";
        const matches = this.missingHead
          ? headers.get("if-none-match") === "*"
          : headers.get("if-match") === `"latest-${this.etagRevision}"`;
        if (this.rejectLatest || !matches) {
          return new Response(null, { status: this.rejectLatest ?? 412 });
        }
        this.pointer = parseJsonBody(init?.body) as unknown as LatestPointer;
        this.missingHead = false;
        this.etagRevision += 1;
        this.replaceOnNextLatestRead = this.replaceAfterLatest;
        return new Response(null, { status: 200 });
      }
      if (this.replaceOnNextLatestRead) {
        this.replaceOnNextLatestRead = false;
        return Response.json(
          { ...this.pointer, backendMetadata: "concurrent-writer" },
          { headers: { etag: '"concurrent"' } },
        );
      }
      if (this.missingHead) return new Response(null, { status: 404 });
      return Response.json(this.pointer, {
        headers: this.missingHeadEtag
          ? {}
          : { etag: `${this.weakHeadEtag ? "W/" : ""}${this.jsonEtag(`"latest-${this.etagRevision}"`, init)}` },
      });
    }
    if (url.pathname.includes("/snapshots/")) {
      const reference = decodeURIComponent(url.pathname.split("/").at(-1) ?? "").replace(/\.json\.gz$/, "");
      if (method === "PUT") {
        this.snapshotPuts += 1;
        const headers = new Headers(init?.headers);
        if (headers.get("if-none-match") === "*" && this.snapshots.has(reference)) {
          return new Response("already exists", { status: 412 });
        }
        this.snapshots.set(reference, Buffer.from(init?.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const value = this.snapshots.get(reference);
      return value ? new Response(new Uint8Array(value), { status: 200 }) : new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/history.json")) {
      if (method === "PUT") {
        this.historyPuts += 1;
        if (this.failHistory) return new Response("history failed", { status: 503 });
        if (this.rejectHistory) return new Response(null, { status: 412 });
        const headers = new Headers(init?.headers);
        const matches = this.historyPointers.length
          ? headers.get("if-match") === '"history"'
          : headers.get("if-none-match") === "*";
        if (!matches) return new Response(null, { status: 412 });
        const body = parseJsonBody(init?.body) as { snapshots?: LatestPointer[] };
        this.historyPointers = body.snapshots ?? [];
        return new Response(null, { status: 200 });
      }
      return this.historyPointers.length > 0
        ? Response.json(
            { version: 1, snapshots: this.historyPointers },
            { headers: { etag: this.jsonEtag('"history"', init) } },
          )
        : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  private jsonEtag(etag: string, init?: RequestInit) {
    return this.compressJson && new Headers(init?.headers).get("accept-encoding") !== "identity" ? `W/${etag}` : etag;
  }
}

function hangingResponse(signal?: AbortSignal | null) {
  return new Promise<Response>((_resolve, reject) => {
    const keepAlive = setInterval(() => undefined, 1_000);
    signal?.addEventListener(
      "abort",
      () => {
        clearInterval(keepAlive);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function encode(value: Snapshot) {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

function pointer(value: Snapshot, encoded: Buffer): LatestPointer {
  return {
    version: 1,
    profile: value.profile,
    snapshot: value.id,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    createdAt: value.createdAt,
    machine: value.machine,
    syncSessions: value.syncSessions,
  };
}

function parseJsonBody(body: BodyInit | null | undefined) {
  if (!body) throw new Error("Expected request body");
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array) {
    return JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
  }
  throw new Error("Unexpected request body");
}
