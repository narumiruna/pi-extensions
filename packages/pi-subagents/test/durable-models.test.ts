import assert from "node:assert/strict";
import {
  type AnyModel,
  type Api,
  type ClassifierOptions,
  createAssistantMessageEventStream,
  createProvider,
  fauxAssistantMessage,
  type ImagesOptions,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Models,
  type Provider,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDurableModels } from "../src/durable-models.js";

const providerId = "durable-bridge-fixture";
const envName = "PI_DURABLE_BRIDGE_FIXTURE_KEY";
const chat: Model<Api> = {
  id: "physical-chat",
  name: "Physical chat",
  api: "fixture-chat",
  provider: providerId,
  baseUrl: "https://fixture.invalid/v1",
  input: ["text"],
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image = { ...chat, type: "image" as const, api: "fixture-image", output: ["image" as const] };
const classifier = { ...chat, type: "classifier" as const, api: "fixture-classifier" };
const context = { messages: [{ role: "user" as const, content: "request", timestamp: 1 }] };

function requireChat(models: Models, provider = providerId, id = chat.id): Model<Api> {
  const model = models.getModel(provider, id);
  assert.ok(model);
  return model;
}

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  vi.stubEnv(envName, "");
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  // Construct before registration to detect a copied provider catalog/runtime.
  const models = createDurableModels(registry);
  const calls: {
    model: AnyModel;
    options: StreamOptions | ImagesOptions | ClassifierOptions | undefined;
    context: unknown;
  }[] = [];
  let behavior: "success" | "throw" | "wait" | "deferred" = "success";
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const dispatch = (model: Model<Api>, transcript: TranscriptContext, options?: StreamOptions) => {
    calls.push({ model, options, context: transcript });
    started();
    if (behavior === "throw") throw new Error("synthetic provider failure");
    const events = createAssistantMessageEventStream();
    const message = {
      ...fauxAssistantMessage("answer"),
      api: model.api,
      provider: model.provider,
      model: model.id,
    };
    events.push({ type: "start", partial: message });
    if (behavior === "wait") {
      const abort = () => {
        options?.signal?.removeEventListener("abort", abort);
        const error = { ...message, stopReason: "aborted" as const, errorMessage: "synthetic cancellation" };
        events.push({ type: "error", reason: "aborted", error });
        events.end();
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    } else if (behavior === "deferred") {
      events.push({
        type: "done",
        reason: "deferred",
        message: {
          ...message,
          stopReason: "deferred",
          deferred: { id: "opaque-job", provider: model.provider, modelId: model.id, api: model.api },
        },
      });
      events.end();
    } else {
      events.push({ type: "text_delta", contentIndex: 0, delta: "answer", partial: message });
      events.push({ type: "done", reason: "stop", message });
      events.end();
    }
    return events;
  };
  const provider = createProvider({
    id: providerId,
    models: [chat, image, classifier],
    auth: {
      apiKey: {
        name: "Fixture key",
        check: async ({ credential, ctx }) =>
          credential?.key || (await ctx.env(envName)) ? { type: "api_key" } : undefined,
        resolve: async ({ credential, ctx }) => {
          const key = credential?.key ?? (await ctx.env(envName));
          return key ? { auth: { apiKey: key, headers: { "x-fixture-auth": key } } } : undefined;
        },
      },
      oauth: {
        name: "Fixture OAuth",
        login: async () => {
          throw new Error("Unexpected login");
        },
        refresh: async (credential) => ({
          ...credential,
          access: "refreshed-access-secret",
          expires: Date.now() + 3_600_000,
        }),
        toAuth: async (credential) => ({
          apiKey: credential.access,
          baseUrl: "https://oauth.fixture.invalid/v1",
          headers: { "x-fixture-oauth": credential.access },
        }),
      },
    },
    api: { stream: dispatch, streamSimple: dispatch },
    images: {
      "fixture-image": {
        generateImages: async (model, input, options) => {
          calls.push({ model, context: input, options });
          options?.signal?.throwIfAborted();
          if (behavior === "throw") throw new Error("synthetic image failure");
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "stop",
            timestamp: 1,
          };
        },
      },
    },
    classifiers: {
      "fixture-classifier": {
        classify: async (model, input, options) => {
          calls.push({ model, context: input, options });
          options?.signal?.throwIfAborted();
          if (behavior === "throw") throw new Error("synthetic classifier failure");
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            answers: {},
            stopReason: "stop",
            timestamp: 1,
          };
        },
      },
    },
  });
  registry.registerProvider(provider);
  return {
    credentials,
    runtime,
    registry,
    models,
    calls,
    provider,
    requestStarted,
    setBehavior(value: typeof behavior) {
      behavior = value;
    },
    async storeKey(key = "stored-key-secret") {
      await credentials.modify(providerId, async () => ({ type: "api_key", key }));
    },
  };
}

describe("durable public ModelRegistry adapter", () => {
  test("reads live catalogs, distinct operation identities, and provider registrations", async () => {
    const f = await fixture();
    const model = f.registry.find(providerId, chat.id);
    expect(f.models.getModel(providerId, chat.id)).toBe(model);
    expect(f.models.getModels(providerId)).toEqual([model]);
    expect(f.models.getAllModels(providerId).map((entry) => entry.type ?? "chat")).toEqual([
      "chat",
      "image",
      "classifier",
    ]);
    expect(f.models.getModelsOfType("image", providerId)[0]).toBe(
      f.registry.getModelOfType("image", providerId, chat.id),
    );
    expect(f.models.getModelOfType("classifier", providerId, chat.id)).toBe(
      f.registry.findOfType("classifier", providerId, chat.id),
    );
    expect(f.models.getProvider(providerId)).toBe(f.registry.getProvider(providerId));
    expect(f.models.getProviders()).toContain(f.registry.getProvider(providerId));
    const empty: Provider = { ...f.provider, id: "empty-fixture", getModels: () => [], getAllModels: () => [] };
    f.registry.registerProvider(empty);
    expect(f.models.getProviders()).toContain(f.registry.getProvider(empty.id));
    f.registry.unregisterProvider(providerId);
    expect(f.models.getModel(providerId, chat.id)).toBeUndefined();
    expect(f.models.getAllModels(providerId)).toEqual([]);
  });

  test.each(["stream", "streamSimple", "complete", "completeSimple"] as const)(
    "%s preserves physical response identity, caller options, and normalized input",
    async (method) => {
      const f = await fixture();
      await f.storeKey();
      const model = requireChat(f.models);
      const settings = Object.freeze({
        stream: Object.freeze({
          sessionId: "durable-conversation",
          maxTokens: 123,
          headers: Object.freeze({ "x-request": "ok" }),
        }),
      });
      const before = JSON.stringify(settings);
      const options = Object.freeze({ ...settings.stream, signal: new AbortController().signal });
      const response = f.models[method](model, context, options);
      const result = await ("result" in response ? response.result() : response);
      expect(result).toMatchObject({ provider: providerId, api: chat.api, model: chat.id, stopReason: "stop" });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.model).toBe(model);
      expect(f.calls[0]?.context).toEqual(context);
      expect(f.calls[0]?.options).toMatchObject({
        apiKey: "stored-key-secret",
        sessionId: "durable-conversation",
        signal: options.signal,
        maxTokens: 123,
        headers: { "x-fixture-auth": "stored-key-secret", "x-request": "ok" },
      });
      expect(JSON.stringify(settings)).toBe(before);
      expect(options).not.toHaveProperty("apiKey");
      expect(JSON.stringify({ settings, catalog: f.models.getAllModels(providerId), result })).not.toContain(
        "stored-key-secret",
      );
    },
  );

  test("resolves changed stored, environment, and runtime API keys for each request", async () => {
    const f = await fixture();
    const request = () => f.models.completeSimple(chat, context);
    vi.stubEnv(envName, "environment-one-secret");
    await request();
    vi.stubEnv(envName, "environment-two-secret");
    await request();
    await f.storeKey("stored-one-secret");
    await request();
    await f.storeKey("stored-two-secret");
    await request();
    await f.runtime.setRuntimeApiKey(providerId, "runtime-one-secret");
    await request();
    await f.runtime.setRuntimeApiKey(providerId, "runtime-two-secret");
    await request();
    await f.runtime.removeRuntimeApiKey(providerId);
    await request();
    expect(f.calls.map((call) => call.options?.apiKey)).toEqual([
      "environment-one-secret",
      "environment-two-secret",
      "stored-one-secret",
      "stored-two-secret",
      "runtime-one-secret",
      "runtime-two-secret",
      "stored-two-secret",
    ]);
  });

  test("refreshes OAuth in the parent store and never writes tokens into request settings", async () => {
    const f = await fixture();
    await f.credentials.modify(providerId, async () => ({
      type: "oauth",
      access: "expired-access-secret",
      refresh: "refresh-token-secret",
      expires: 1,
    }));
    const settings = Object.freeze({ stream: Object.freeze({ sessionId: "oauth-durable" }) });
    const result = await f.models.completeSimple(chat, context, settings.stream);
    expect(result.stopReason).toBe("stop");
    expect(f.calls[0]?.options?.apiKey).toBe("refreshed-access-secret");
    expect(f.calls[0]?.model.baseUrl).toBe("https://oauth.fixture.invalid/v1");
    expect(await f.credentials.read(providerId)).toMatchObject({ access: "refreshed-access-secret" });
    expect(JSON.stringify({ settings, result, catalog: f.models.getModels(providerId) })).not.toMatch(/secret/);
  });

  test("does not fall back to environment auth after a failed OAuth refresh", async () => {
    const f = await fixture();
    vi.stubEnv(envName, "must-not-use-environment-secret");
    await f.credentials.modify(providerId, async () => ({
      type: "oauth",
      access: "expired-access-secret",
      refresh: "refresh-token-secret",
      expires: 1,
    }));
    const oauth = f.provider.auth.oauth;
    assert.ok(oauth);
    f.registry.registerProvider({
      ...f.provider,
      auth: {
        ...f.provider.auth,
        oauth: {
          ...oauth,
          refresh: async () => {
            throw new Error("synthetic OAuth failure");
          },
        },
      },
    });
    const options = Object.freeze({ sessionId: "failed-oauth" });
    const result = await f.models.completeSimple(chat, context, options);
    expect(result.stopReason).toBe("error");
    expect(f.calls).toHaveLength(0);
    expect(await f.credentials.read(providerId)).toMatchObject({ access: "expired-access-secret" });
    expect(JSON.stringify({ options, result })).not.toContain("secret");
  });

  test("uses extension compatibility providers and their reconfiguration without copying them", async () => {
    const f = await fixture();
    const id = "legacy-bridge-fixture";
    const seen: (string | undefined)[] = [];
    const register = (key: string) =>
      f.registry.registerProvider(id, {
        api: chat.api,
        apiKey: key,
        baseUrl: chat.baseUrl,
        models: [chat],
        streamSimple: (model, _context, options) => {
          seen.push(options?.apiKey);
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "done",
            reason: "stop",
            message: { ...fauxAssistantMessage("legacy"), provider: model.provider, api: model.api, model: model.id },
          });
          stream.end();
          return stream;
        },
      });
    register("legacy-one-secret");
    expect((await f.models.completeSimple(requireChat(f.models, id), context)).provider).toBe(id);
    register("legacy-two-secret");
    await f.models.completeSimple(requireChat(f.models, id), context);
    expect(seen).toEqual(["legacy-one-secret", "legacy-two-secret"]);
  });

  test("returns current authenticated availability for all model types", async () => {
    const f = await fixture();
    expect(await f.models.getAvailable(providerId)).toEqual([]);
    expect(await f.models.getAllAvailable(providerId)).toEqual([]);
    await f.storeKey();
    expect(await f.models.getAvailable(providerId)).toEqual(f.models.getModels(providerId));
    expect(await f.models.getAvailableOfType("classifier", providerId)).toEqual(
      f.models.getModelsOfType("classifier", providerId),
    );
    expect(await f.models.getAllAvailable(providerId)).toEqual(f.models.getAllModels(providerId));
    await f.credentials.delete(providerId);
    expect(await f.models.getAllAvailable(providerId)).toEqual([]);
  });

  test("streams provider events and propagates provider, missing-auth, and pre-abort errors", async () => {
    const f = await fixture();
    const unauthenticated = await f.models.completeSimple(chat, context);
    expect(unauthenticated.stopReason).toBe("error");
    expect(f.calls).toHaveLength(0);
    await f.storeKey();
    const events = f.models.streamSimple(chat, context);
    const types: string[] = [];
    for await (const event of events) types.push(event.type);
    expect(types).toEqual(["start", "text_delta", "done"]);
    f.setBehavior("throw");
    expect(await f.models.completeSimple(chat, context)).toMatchObject({
      stopReason: "error",
      errorMessage: "synthetic provider failure",
    });
    const count = f.calls.length;
    const aborted = await f.models.completeSimple(chat, context, { signal: AbortSignal.abort() });
    // Pi's lazy auth setup reports pre-dispatch cancellation as an error, not an aborted provider response.
    expect(aborted).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/abort/i) });
    expect(f.calls).toHaveLength(count);
  });

  test("passes cancellation to an active provider and terminates its stream", async () => {
    const f = await fixture();
    await f.storeKey();
    f.setBehavior("wait");
    const controller = new AbortController();
    const result = f.models.completeSimple(chat, context, { signal: controller.signal });
    await f.requestStarted;
    expect(f.calls[0]?.options?.signal).toBe(controller.signal);
    controller.abort();
    expect(await result).toMatchObject({ stopReason: "aborted", errorMessage: "synthetic cancellation" });
    expect(f.calls).toHaveLength(1);
  });

  test("delegates image and classifier requests with current auth and structured errors", async () => {
    const f = await fixture();
    const input = { input: [{ type: "text" as const, text: "image" }] };
    const questions = { state: {}, questions: {} };
    const options = Object.freeze({ metadata: Object.freeze({ durable: true }) });
    expect((await f.models.generateImages(image, input, options)).stopReason).toBe("error");
    expect((await f.models.classify(classifier, questions)).stopReason).toBe("error");
    await f.storeKey("media-one-secret");
    expect((await f.models.generateImages(image, input, options)).stopReason).toBe("stop");
    await f.storeKey("media-two-secret");
    expect((await f.models.classify(classifier, questions)).stopReason).toBe("stop");
    expect(f.calls.map((call) => call.options?.apiKey)).toEqual(["media-one-secret", "media-two-secret"]);
    expect(f.calls[0]?.context).toBe(input);
    expect(f.calls[1]?.context).toBe(questions);
    expect(options).not.toHaveProperty("apiKey");
    f.setBehavior("throw");
    expect(await f.models.generateImages(image, input)).toMatchObject({
      stopReason: "error",
      errorMessage: "synthetic image failure",
    });
    expect(await f.models.classify(classifier, questions)).toMatchObject({
      stopReason: "error",
      errorMessage: "synthetic classifier failure",
    });
    const signal = AbortSignal.abort();
    expect((await f.models.generateImages(image, input, { signal })).stopReason).toBe("aborted");
    expect((await f.models.classify(classifier, questions, { signal })).stopReason).toBe("aborted");
  });

  test("reports unsupported dedicated operations without a chat fallback", async () => {
    const f = await fixture();
    await f.storeKey();
    f.registry.registerProvider({ ...f.provider, generateImages: undefined, classify: undefined });
    const generated = await f.models.generateImages(image, { input: [{ type: "text", text: "image" }] });
    const classified = await f.models.classify(classifier, { state: {}, questions: {} });
    expect(generated.stopReason).toBe("error");
    expect(generated.errorMessage).toBeTruthy();
    expect(classified.stopReason).toBe("error");
    expect(classified.errorMessage).toBeTruthy();
    expect(f.calls).toHaveLength(0);
  });

  test("keeps virtual direct routing and reports the dispatched physical identity", async () => {
    const f = await fixture();
    await f.storeKey();
    f.registry.registerVirtualModel({
      provider: "durable-router",
      id: "auto",
      name: "Durable router",
      route: () => ({ model: requireChat(f.models), thinkingLevel: "off" }),
    });
    // Direct virtual routing checks the parent's availability snapshot, not just credential storage.
    await f.models.refresh({ allowNetwork: false });
    const result = await f.models.completeSimple(requireChat(f.models, "durable-router", "auto"), context);
    expect(result.errorMessage).toBeUndefined();
    expect(result).toMatchObject({ provider: providerId, model: chat.id, api: chat.api });
    expect(f.calls[0]?.model.provider).toBe(providerId);
    expect(f.calls[0]?.options?.apiKey).toBe("stored-key-secret");
  });

  test("rejects deferred creation, polling, and cancellation without unauthenticated fallback", async () => {
    const f = await fixture();
    await f.storeKey();
    for (const deferred of [true, { window: "1h" as const }]) {
      expect(() => f.models.stream(chat, context, { deferred })).toThrow(/deferred requests/);
      expect(() => f.models.streamSimple(chat, context, { deferred })).toThrow(/deferred requests/);
      await expect(f.models.complete(chat, context, { deferred })).rejects.toThrow(/deferred requests/);
      await expect(f.models.completeSimple(chat, context, { deferred })).rejects.toThrow(/deferred requests/);
    }
    const handle = { id: "opaque-job", provider: providerId, modelId: chat.id, api: chat.api };
    expect(() => f.models.streamDeferred(chat, handle)).toThrow(/streamDeferred/);
    await expect(f.models.fetchDeferred(chat, handle)).rejects.toThrow(/fetchDeferred/);
    await expect(f.models.cancelDeferred(chat, handle)).rejects.toThrow(/cancelDeferred/);
    expect(f.calls).toHaveLength(0);
    // An unexpected provider-owned deferred result is retained, never replayed as a new request.
    f.setBehavior("deferred");
    expect(await f.models.completeSimple(chat, context, { deferred: false })).toMatchObject({ stopReason: "deferred" });
    await expect(f.models.fetchDeferred(chat, handle)).rejects.toThrow(/fetchDeferred/);
    expect(f.calls).toHaveLength(1);
  });

  test("explicitly rejects credential inspection and management", async () => {
    const f = await fixture();
    await expect(f.models.getAuth(providerId)).rejects.toThrow(/getAuth/);
    await expect(f.models.getAuth(chat)).rejects.toThrow(/getAuth/);
    await expect(f.models.checkAuth(providerId)).rejects.toThrow(/checkAuth/);
    await expect(f.models.logout(providerId)).rejects.toThrow(/logout/);
    await expect(
      f.models.login(providerId, "api_key", { prompt: async () => "unused", notify: () => {} }),
    ).rejects.toThrow(/login/);
    expect(f.calls).toHaveLength(0);
  });
});
