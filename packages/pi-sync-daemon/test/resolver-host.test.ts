import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
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

test.each(["missing ID", "changed capability", "definition changed after review", "different auth source"] as const)(
  "the daemon rejects %s before calling the provider",
  async (scenario) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-binding-"));
    const modelsPath = path.join(root, "models.json");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline fixture must not fetch"));
    try {
      const definitions = {
        providers: {
          "catalog-fixture": {
            api: "openai-completions",
            baseUrl: "https://resolver.invalid/v1",
            apiKey: "fixture-api-key",
            models: [{ id: "shared", name: "Shared", reasoning: false, input: ["text"], maxTokens: 2048 }],
          },
        },
      };
      const checksAuth = scenario === "definition changed after review" || scenario === "different auth source";
      const authPath = path.join(root, "auth.json");
      const auth = "{}\n";
      if (checksAuth) await fs.writeFile(authPath, auth, { mode: 0o600 });
      await fs.writeFile(modelsPath, JSON.stringify(definitions));
      const metadata = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        refreshOnCreate: false,
      });
      const model = metadata.getModel("catalog-fixture", "shared");
      assert.ok(model);
      const host = await prepareResolverHost(root, {
        provider: model.provider,
        id: scenario === "missing ID" ? "new-id" : model.id,
        signature: modelSignature(
          scenario === "changed capability"
            ? { ...model, compat: { ...model.compat, supportsMidConvoEffort: true } }
            : model,
        ),
        authSource: scenario === "different auth source" ? "stored" : "models_json_key",
      });
      const guidance = /No fallback model was selected\. Align the host and daemon Pi model catalogs/u;
      try {
        if (scenario === "missing ID" || scenario === "changed capability") {
          assert.equal(host.model, undefined);
          assert.match(host.unavailable ?? "", guidance);
        } else {
          assert.deepEqual(host.model, model, "The exact definition passes the non-credential check.");
          if (scenario === "definition changed after review") {
            definitions.providers["catalog-fixture"].models[0].maxTokens += 1;
            await fs.writeFile(modelsPath, JSON.stringify(definitions));
          }
          await assert.rejects(host.registry.streamSimple(model, { messages: [] }).result(), guidance);
        }
      } finally {
        await host.settle();
      }
      assert.equal(fetch.mock.calls.length, 0);
      if (checksAuth) assert.equal(await fs.readFile(authPath, "utf8"), auth);
      else assert.deepEqual(await fs.readdir(root), ["models.json"], "Static refusal must not open auth storage.");
    } finally {
      fetch.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

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
