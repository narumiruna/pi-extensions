import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { AccountStore } from "../src/account-store.js";
import { createBuiltinProviderAdapters } from "../src/oauth.js";
import { RuntimeAuthCoordinator } from "../src/runtime-auth.js";
import { InMemoryAccountStorageBackend } from "../src/storage.js";

test("Radius publishes the selected account catalog through Pi's real model runtime", async () => {
  const requests: string[] = [];
  const refreshRequests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/oauth/token") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      refreshRequests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: "access-refreshed",
          refresh_token: "refresh-refreshed",
          expires_in: 3_600,
          scope: "gateway offline_access",
        }),
      );
      return;
    }
    if (request.url !== "/v1/config") {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization ?? "";
    requests.push(authorization);
    const account = authorization.endsWith("two") ? "two" : "one";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        baseUrl: `http://inference.${account}.radius.test/v1`,
        models: [
          {
            id: "radius-model",
            name: "Radius Model",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_000,
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "pi-accounts-radius-"));
  try {
    const modelsPath = join(root, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          radius: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            oauth: "radius",
          },
        },
      }),
    );
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const selectedModels: unknown[] = [];
    const pi = {
      registerProvider: registry.registerProvider.bind(registry),
      unregisterProvider: registry.unregisterProvider.bind(registry),
      async setModel(model: unknown) {
        selectedModels.push(model);
        return true;
      },
    };
    const radius = createBuiltinProviderAdapters().find((provider) => provider.id === "radius");
    assert.ok(radius);
    const coordinator = new RuntimeAuthCoordinator(pi as never, radius);
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.write({
      version: 1,
      providers: {
        radius: {
          active: "work",
          accounts: {
            work: {
              type: "oauth",
              access: "access-one",
              refresh: "refresh-one",
              expires: 0,
            },
          },
        },
      },
    });
    const firstContext = createMockContext({ modelRegistry: registry }).ctx;
    assert.equal((await coordinator.ensureActive(firstContext, store, "work")).status, "active");
    const firstModel = registry.find("radius", "radius-model");
    assert.equal(firstModel?.baseUrl, "http://inference.one.radius.test/v1");
    assert.deepEqual(requests, ["Bearer access-refreshed"]);
    assert.equal(refreshRequests.length, 1);
    assert.match(refreshRequests[0] ?? "", /refresh_token=refresh-one/);
    assert.equal((await store.readProviderAsync("radius")).accounts.work?.access, "access-refreshed");

    assert.equal((await coordinator.ensureActive(firstContext, store, "work")).status, "active");
    assert.deepEqual(requests, ["Bearer access-refreshed"]);
    assert.equal(refreshRequests.length, 1);

    await store.updateProvider("radius", (state) => ({
      ...state,
      accounts: {
        work: {
          type: "oauth",
          access: "access-two",
          refresh: "refresh-two",
          expires: Date.now() + 60 * 60 * 1000,
        },
      },
    }));
    const secondContext = createMockContext({ model: firstModel, modelRegistry: registry }).ctx;
    assert.equal((await coordinator.ensureActive(secondContext, store, "work")).status, "active");
    assert.deepEqual(requests, ["Bearer access-refreshed", "Bearer access-two"]);
    assert.equal(selectedModels.length, 0);
    assert.equal(firstModel?.baseUrl, "http://inference.two.radius.test/v1");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
