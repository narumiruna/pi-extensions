import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { modelSignature } from "../src/model-signature.js";
import { prepareResolverHost } from "../src/resolver-host.js";

test("model signatures preserve the legacy JSON identity and need no raw model headers", () => {
  assert.notEqual(
    modelSignature({ id: "x", headers: { authorization: "private" } }),
    modelSignature({ headers: { authorization: "private" }, id: "x" }),
  );
  assert.notEqual(modelSignature({ id: "x" }), modelSignature({ id: "y" }));
});

test("a parent-only provider remains unavailable without loading extensions or selecting a fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-model-"));
  try {
    const host = await prepareResolverHost(root, {
      provider: "parent-only-provider",
      id: "private-runtime-model",
      signature: modelSignature({}),
      authSource: "stored",
    });
    assert.equal(host.model, undefined);
    assert.match(host.unavailable ?? "", /unavailable/u);
    await host.settle();
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("missing authorization and cancellation do not create credential files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-no-model-"));
  try {
    assert.equal((await prepareResolverHost(root, undefined)).model, undefined);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      prepareResolverHost(root, undefined, controller.signal),
      (error) => error instanceof Error && error.name === "AbortError",
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
