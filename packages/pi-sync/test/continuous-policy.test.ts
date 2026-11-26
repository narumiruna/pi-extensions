import assert from "node:assert/strict";
import { test } from "vitest";
import { S3HttpError } from "../src/backends/s3/s3-client.js";
import { SyncBackendConflictError } from "../src/backends/sync-backend.js";
import { WebDavHttpError } from "../src/backends/webdav/webdav-client.js";
import { ContinuousError, continuousFailure, retryAfter } from "../src/sync/continuous-errors.js";

for (const [error, kind, retry] of [
  [new S3HttpError("secret", 503), "transient", true],
  [new WebDavHttpError("secret", 429), "transient", true],
  [new S3HttpError("secret", 401), "authentication", false],
  [new WebDavHttpError("secret", 403), "authentication", false],
  [new S3HttpError("secret", 400), "unknown", false],
  [new Error("outer", { cause: Object.assign(new Error("secret"), { code: "ECONNREFUSED" }) }), "transient", true],
  [Object.assign(new Error("secret"), { code: "ELOCKED" }), "contention", true],
  [Object.assign(new Error("secret"), { code: "ECOMPROMISED" }), "stale", true],
  [Object.assign(new Error("secret"), { code: "ENOSPC" }), "storage", false],
  [new SyncBackendConflictError("secret"), "stale", true],
  [new DOMException("secret", "TimeoutError"), "transient", true],
  [new DOMException("secret", "AbortError"), "unknown", false],
  [new Error("HTTP 503 ECONNRESET"), "unknown", false],
  [new ContinuousError("unsafe", "secret"), "unsafe", false],
  [new ContinuousError("model", "secret"), "model", false],
  [new ContinuousError("budget", "secret", 900_000), "budget", true],
] as const)
  test(`background category ${kind}/${String(error)}`, () => {
    const result = continuousFailure(error);
    assert.equal(result.kind, kind);
    assert.equal(result.retry, retry);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

test("retry delay parsing is bounded and rejects invalid values", () => {
  for (const [value, expected] of [
    ["20", 20_000],
    ["1000000", 300_000],
    ["-1", undefined],
    ["invalid", undefined],
    ["Infinity", undefined],
  ] as const)
    assert.equal(retryAfter(new Response(null, { headers: { "retry-after": value } })), expected);
  const time = Date.now();
  const delay = retryAfter(new Response(null, { headers: { "retry-after": new Date(time + 60_000).toUTCString() } }));
  assert.ok(delay !== undefined && delay <= 60_000 && delay >= 58_000);
  const circular = new Error("unknown");
  circular.cause = circular;
  assert.deepEqual(continuousFailure(circular), { kind: "unknown", retry: false });
});
