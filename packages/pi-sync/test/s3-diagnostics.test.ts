import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ResolvedS3Backend } from "../src/backends/backend-types.js";
import { S3SyncBackend } from "../src/backends/s3/s3-backend.js";
import { S3Client } from "../src/backends/s3/s3-client.js";

const config: ResolvedS3Backend = {
  type: "s3",
  profile: {
    kind: "s3-compatible",
    endpoint: "https://storage.example.com",
    region: "us-east-1",
    accessKeyId: "private-access",
    secretAccessKey: "private-secret",
  },
  destination: { bucket: "existing-bucket", prefix: "backups/work", namespace: "default" },
};

const cases = [
  {
    status: 200,
    body: "not validated snapshot data",
    outcome: "readable",
    message: /HTTP success.*Snapshot contents and write access are not tested/u,
  },
  {
    status: 404,
    body: "<Error><Code>NoSuchKey</Code></Error>",
    outcome: "missing-key",
    message: /no snapshot.*verify the bucket and path/u,
  },
  {
    status: 404,
    body: "<Error><Code>NoSuchBucket</Code></Error>",
    outcome: "missing-bucket",
    message: /bucket not found.*Create the bucket/u,
  },
  {
    status: 404,
    body: "Not found",
    outcome: "unknown-404",
    message: /cannot confirm whether the bucket or snapshot is missing/u,
  },
  {
    status: 404,
    body: "<Error><Code>AccessDenied</Code></Error>",
    outcome: "unknown-404",
    message: /cannot confirm/u,
  },
  {
    status: 401,
    body: "private-access private-secret",
    message: /credentials and remote permissions/u,
  },
  {
    status: 403,
    body: "private-access private-secret",
    message: /credentials and remote permissions/u,
  },
  { status: 500, body: "private-access private-secret", message: /HTTP 500/u },
];

test.each(cases)(
  "S3 read-only diagnostics classify HTTP $status ($outcome) without assuming write access",
  async ({ status, body, outcome, message }) => {
    const requests: RequestInit[] = [];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(init ?? {});
      return new Response(body, { status });
    });
    const before = structuredClone(config);
    if (outcome) assert.equal(await new S3Client(config).diagnoseRead("latest.json"), outcome);
    const output = (await new S3SyncBackend(config).diagnose()).map((entry) => entry.message).join("\n");
    assert.match(output, message);
    assert.doesNotMatch(output, /private-access|private-secret/u);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.deepEqual(config, before);
  },
);

test("R2 diagnostics retain the one-time static-key token fallback without writes", async () => {
  const requests: RequestInit[] = [];
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(init ?? {});
    return requests.length === 1
      ? new Response("<Code>InvalidArgument</Code><Message>X-Amz-Security-Token</Message>", {
          status: 400,
        })
      : new Response("<Code>NoSuchKey</Code>", { status: 404 });
  });
  const r2 = {
    ...config,
    profile: {
      ...config.profile,
      endpoint: "https://account.r2.cloudflarestorage.com",
      sessionToken: "private-token",
    },
  };
  const output = (await new S3SyncBackend(r2).diagnose()).map((entry) => entry.message).join("\n");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.equal(new Headers(requests[0]?.headers).get("x-amz-security-token"), "private-token");
  assert.equal(new Headers(requests[1]?.headers).has("x-amz-security-token"), false);
  assert.match(output, /no snapshot/u);
  assert.doesNotMatch(output, /private-token/u);
});

test.each([false, true])(
  "oversized R2 token error releases both response branches (declared length %s)",
  async (declaredLength) => {
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("x".repeat(70000), {
          status: 400,
          headers: declaredLength ? { "content-length": "70000" } : {},
        }),
    );
    const r2 = {
      ...config,
      profile: {
        ...config.profile,
        endpoint: "https://account.r2.cloudflarestorage.com",
        sessionToken: "private-token",
      },
    };
    const output = (await new S3SyncBackend(r2).diagnose()).map((entry) => entry.message).join("\n");
    assert.match(output, /exceeds the.*limit/u);
    assert.doesNotMatch(output, /private-token/u);
  },
);

test("successful S3 diagnostic cancels the unread response body", async () => {
  let cancelled = false;
  using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  assert.equal(await new S3Client(config).diagnoseRead("latest.json"), "readable");
  assert.equal(cancelled, true);
});

test("S3 diagnostic bounds error bodies and does not reveal response text", async () => {
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("private-secret".repeat(6000), { status: 404 }));
  const output = (await new S3SyncBackend(config).diagnose()).map((entry) => entry.message).join("\n");
  assert.match(output, /cannot confirm/u);
  assert.doesNotMatch(output, /private-secret/u);
  assert.ok(output.length < 1000);
});

test.each(["transport", "timeout", "cancel"])("S3 diagnostic handles $0 without writes", async (kind) => {
  const owner = new AbortController();
  const deadline = new AbortController();
  using _timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    assert.equal(init?.method, "GET");
    if (kind === "transport") throw new Error("ECONNREFUSED private-secret");
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      ready();
    });
  });
  const pending = new S3SyncBackend(config).diagnose(owner.signal);
  if (kind === "cancel") {
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await started;
    owner.abort(new DOMException("Session replaced", "AbortError"));
    await rejected;
  } else {
    if (kind === "timeout") {
      await started;
      deadline.abort(new DOMException("Deadline", "TimeoutError"));
    }
    const output = (await pending).map((entry) => entry.message).join("\n");
    assert.match(output, kind === "timeout" ? /timed out/u : /request failed/u);
    assert.match(output, /server address and network/u);
    assert.doesNotMatch(output, /private-secret/u);
  }
});
