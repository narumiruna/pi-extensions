import assert from "node:assert/strict";
import { test } from "vitest";
import { S3Client } from "../src/backends/s3/s3-client.js";
import { requiredConfig } from "./helpers.js";

test("S3 JSON reads reject oversized response bodies", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) })),
    async () => {
      await assert.rejects(new S3Client(s3Config()).getJson("latest.json"), /exceeds.*limit/i);
    },
  );
});

test("S3 errors redact configured credentials and bound response text", async () => {
  const base = s3Config();
  const config = {
    ...base,
    profile: { ...base.profile, endpoint: `${base.profile.endpoint}?token=query-secret` },
  };
  const responseBody = `${config.profile.accessKeyId} ${config.profile.secretAccessKey} ${config.profile.sessionToken} query-secret ${"x".repeat(128 * 1024)}`;
  await withFetch(
    async () => new Response(responseBody, { status: 403 }),
    async () => {
      await assert.rejects(new S3Client(config).getJson("latest.json"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /access-key|secret-key|session-token|query-secret/);
        assert.ok(error.message.length < 70 * 1024);
        return true;
      });
    },
  );
});

test("S3 requests enforce a hard transport deadline", async () => {
  await withFetch(
    async (_input, init) => hangingResponse(init?.signal),
    async () => {
      await assert.rejects(new S3Client(s3Config(), undefined, 5).getJson("latest.json"), /timed out/i);
      await assert.rejects(
        new S3Client(s3Config(), undefined, 5).putBuffer(
          "snapshots/new.json.gz",
          Buffer.from("snapshot"),
          "application/gzip",
        ),
        /timed out/i,
      );
    },
  );
});

test("R2 retries a rejected session token once without the token", async () => {
  const seenTokens: Array<string | null> = [];
  await withFetch(
    async (_input, init) => {
      const token = new Headers(init?.headers).get("x-amz-security-token");
      seenTokens.push(token);
      if (token) {
        return new Response("<Error><Code>InvalidArgument</Code><Message>X-Amz-Security-Token</Message></Error>", {
          status: 400,
        });
      }
      return Response.json({ snapshot: "ok" });
    },
    async () => {
      const result = await new S3Client(s3Config()).getJson<{ snapshot: string }>("latest.json");
      assert.equal(result.value?.snapshot, "ok");
      assert.deepEqual(seenTokens, ["session-token", null]);
    },
  );
});

test("S3 operations forward an already-aborted signal to transport", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await withFetch(
    async (_input, init) => {
      calls += 1;
      assert.equal(init?.signal?.aborted, true);
      throw init?.signal?.reason;
    },
    async () => {
      await assert.rejects(
        new S3Client(s3Config(), controller.signal).getJson("latest.json"),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(calls, 1);
    },
  );
});

function s3Config() {
  const flat = requiredConfig();
  return {
    type: "s3" as const,
    profile: {
      kind: "s3-compatible" as const,
      endpoint: flat.endpoint,
      region: "auto",
      accessKeyId: flat.accessKeyId,
      secretAccessKey: flat.secretAccessKey,
      sessionToken: "session-token",
    },
    destination: { bucket: flat.bucket, prefix: "pi-sync", namespace: "default" },
  };
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

async function withFetch<T>(fetch: typeof globalThis.fetch, fn: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
