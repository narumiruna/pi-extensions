import assert from "node:assert/strict";
import { test } from "vitest";
import { withCleanup } from "../src/lifecycle.js";

test("cleanup runs once after success and returns the action value", async () => {
  let calls = 0;
  assert.equal(
    await withCleanup(
      async () => 42,
      async () => {
        calls++;
      },
    ),
    42,
  );
  assert.equal(calls, 1);
});
test("successful cleanup preserves the original operation failure", async () => {
  const original = new Error("preimage changed");
  await assert.rejects(
    withCleanup(
      async () => {
        throw original;
      },
      async () => {},
    ),
    (error) => error === original,
  );
});
test("a cleanup failure never turns a committed operation into reported success", async () => {
  const cleanup = new Error("release acknowledgement lost");
  await assert.rejects(
    withCleanup(
      async () => "committed",
      async () => {
        throw cleanup;
      },
    ),
    (error) => error === cleanup,
  );
});
test("operation and cleanup failures retain both pieces of evidence", async () => {
  const original = new Error("apply failed");
  const cleanup = new Error("release failed");
  await assert.rejects(
    withCleanup(
      async () => {
        throw original;
      },
      async () => {
        throw cleanup;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, cleanup]);
      return true;
    },
  );
});
