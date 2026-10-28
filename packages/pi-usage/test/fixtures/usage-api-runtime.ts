import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { createMockContext, createMockPi } from "../../../../test/support.js";
import type { UsageSettingsRuntime } from "../../src/settings.js";
import { queryUsage, type UsageChangedV1, type UsageQueryOptions } from "./usage-client.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const openRouterModel = {
  id: "openai/gpt-4o",
  name: "GPT-4o",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
};

export function routerResponse() {
  return new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 75, usage: 25 } }));
}

export async function usageApiRuntime(
  options: {
    mode?: ExtensionContext["mode"];
    model?: typeof openRouterModel;
    credential?: unknown;
    source?: string;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "usage-api-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  const [{ default: extension }, { createUsageSettingsRuntime }] = await Promise.all([
    import("../../src/usage.js"),
    import("../../src/settings.js"),
  ]);
  const settings: UsageSettingsRuntime = createUsageSettingsRuntime(join(directory, "pi-usage.json"));
  const mock = createMockPi();
  const pi = mock.pi as ExtensionAPI;
  const providerModel = { ...(options.model ?? openRouterModel) };
  const currentModel = { id: "other", name: "Other", provider: "other", baseUrl: "https://other.invalid" };
  let sessionId = "api-session";
  let apiKey = "synthetic-api-key";
  let authCalls = 0;
  let authHook: (() => Promise<void>) | undefined;
  let fetchHook: ((input: string, init: RequestInit) => Promise<Response>) | undefined;
  const fetches: Array<{ input: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    fetches.push({ input: String(input), init });
    return fetchHook ? fetchHook(String(input), init) : routerResponse();
  });
  const context = createMockContext({
    mode: options.mode ?? "json",
    cwd: directory,
    model: currentModel,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] },
    modelRegistry: {
      getAll: () => [currentModel, providerModel],
      getAvailable: () => [currentModel, providerModel],
      getProviderAuth: async () => {
        authCalls++;
        await authHook?.();
        return { source: options.source ?? "API key", auth: { apiKey } };
      },
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
    },
  });
  const ctx = context.ctx as ExtensionContext;
  const changes: UsageChangedV1[] = [];
  pi.events.on("usage:changed:v1", (event) => changes.push(event as UsageChangedV1));
  extension(pi, { settingsRuntime: settings, credentialReader: () => options.credential });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
  };
  await emit("session_start");
  return {
    directory,
    mock,
    pi,
    ctx,
    context,
    providerModel,
    currentModel,
    changes,
    fetches,
    settings,
    emit,
    authCalls: () => authCalls,
    key: (value: string) => {
      apiKey = value;
    },
    sessionId: (value: string) => {
      sessionId = value;
    },
    onAuth: (hook: (() => Promise<void>) | undefined) => {
      authHook = hook;
    },
    onFetch: (hook: ((input: string, init: RequestInit) => Promise<Response>) | undefined) => {
      fetchHook = hook;
    },
    query: (queryOptions: UsageQueryOptions = {}) =>
      queryUsage(pi, ctx, {
        providerId: providerModel.provider,
        ...queryOptions,
      }),
    async close() {
      await emit("session_shutdown", { reason: "quit" });
      vi.unstubAllGlobals();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
