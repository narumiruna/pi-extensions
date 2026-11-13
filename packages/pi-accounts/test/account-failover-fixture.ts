import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { AccountActivationResult } from "../src/accounts-protocol.js";
import type { AccountProviderId } from "../src/oauth.js";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";

// AccountStore caches its default path at import time. Never observe the user's directory.
export const agentDir = await mkdtemp(join(tmpdir(), "account-failover-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
export const { default: accountsExtension, FAIL_CLOSED_API_KEY } = await import("../src/accounts.js");
export const { AccountStore, InMemoryAccountStorageBackend } = await import("../src/account-store.js");
export const { AccountFailover } = await import("../src/account-failover.js");
export const { RuntimeAuthCoordinator } = await import("../src/runtime-auth.js");
const { createBuiltinProviderAdapters } = await import("../src/oauth.js");
const { restoreAccountSelections } = await import("../src/session-selection.js");
const { OAUTH_CREDENTIAL_READINESS_CHANNEL } = await import("../src/oauth-credential-source.js");

isolateAccountEnvironment();
const fixtures = new Set<{ shutdown(): Promise<void> }>();
afterEach(async () => {
  for (const fixture of fixtures) await fixture.shutdown();
  fixtures.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

export const keyFor = (account: string) => `sk-${account}-failover-fixture`;
export type UsageRequest = {
  session: ExtensionContext["sessionManager"];
  sessionId: string;
  providerId: string;
  refresh: boolean;
  signal: AbortSignal;
  respond(result: unknown): boolean;
};
export type UsageCall = { request: UsageRequest; key: string | undefined; model: string | undefined };

/** Public protocol evidence only; no dependency on a usage extension implementation. */
export function allowance(
  ctx: ExtensionContext,
  remaining: number,
  options: { reset?: number; partial?: boolean } = {},
) {
  const now = Date.now();
  return {
    status: "ready",
    providerId: ctx.model?.provider,
    source: "refresh",
    expiresAt: now + 60_000,
    report: {
      providerId: ctx.model?.provider,
      providerName: "Synthetic quota service",
      capturedAt: now,
      source: "synthetic",
      semantics: { kind: "api-key", label: "Synthetic included allowance" },
      // Display text is deliberately identical for every account, not identity evidence.
      accountLabel: "Untrusted display label",
      buckets: [
        {
          id: "window",
          label: "Included window",
          unit: "percent",
          used: 100 - remaining,
          remaining,
          limit: 100,
          ...(options.reset === undefined ? {} : { resetsAt: options.reset }),
        },
      ],
      metrics: [],
      allowance: {
        kind: "included",
        scope: { kind: "models", modelIds: [ctx.model?.id] },
        coverage: options.partial ? "partial" : "complete",
        bucketIds: ["window"],
        authBinding: "runtime",
      },
    },
  };
}

export async function failoverFixture(
  options: { provider?: "openrouter" | "anthropic"; active?: string; fallback?: unknown; service?: boolean } = {},
) {
  const id = options.provider ?? "openrouter";
  const adapters = createBuiltinProviderAdapters().filter(
    (adapter) => adapter.id === "anthropic" || adapter.id === "openrouter",
  );
  const adapter = adapters.find((candidate) => candidate.id === id);
  assert.ok(adapter);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const model = registry.getAll().find((candidate) => candidate.provider === id);
  assert.ok(model);
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider(id, () => ({
    ...(options.active ? { active: options.active } : {}),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    accounts: Object.fromEntries(
      ["primary", "backup", "spare", "manual"].map((name) => [name, { type: "api_key" as const, key: keyFor(name) }]),
    ),
  }));
  const mock = createMockPi();
  let idle = true;
  let aborts = 0;
  let run = new AbortController();
  const choices: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model,
    modelRegistry: registry,
    sessionManager: SessionManager.inMemory(agentDir),
    isIdle: () => idle,
    abort: () => {
      aborts++;
      run.abort();
    },
    select: async (_title: string, values: string[]) => {
      const choice = choices.shift();
      if (choice !== undefined) assert.ok(values.includes(choice), `Missing option: ${choice}`);
      return choice;
    },
  });
  const ctx: ExtensionCommandContext = context.ctx;
  Object.defineProperty(ctx, "signal", { get: () => run.signal });
  accountsExtension(mock.pi, { store, providers: adapters });
  let offer: (call: UsageCall) => unknown = () => allowance(ctx, 50);
  const queries: UsageCall[] = [];
  let requests = 0;
  const stopCounting = mock.eventBus.on("usage:query:v1", () => {
    requests++;
  });
  const unsubscribe =
    options.service === false
      ? () => undefined
      : mock.eventBus.on("usage:query:v1", (value) => {
          const request = value as UsageRequest;
          // Offers are synchronous, but resolving runtime authentication and quota may be asynchronous.
          request.respond(
            (async () => {
              const call = {
                request,
                key: await registry.getApiKeyForProvider(request.providerId),
                model: ctx.model?.id,
              };
              queries.push(call);
              return offer(call);
            })(),
          );
        });
  let stopped = false;
  const emit = async (name: string, current: ExtensionContext = ctx) => {
    for (const handler of mock.events.get(name) ?? []) await handler({ model: current.model }, current);
  };
  const fixture = {
    ...context,
    ctx,
    id,
    adapters,
    adapter,
    registry,
    runtime,
    store,
    mock,
    queries,
    emit,
    requests: () => requests,
    aborts: () => aborts,
    setIdle(value: boolean) {
      idle = value;
    },
    cancel() {
      run.abort();
    },
    newRun() {
      run = new AbortController();
    },
    offer(next: (call: UsageCall) => unknown) {
      offer = next;
    },
    async key() {
      return registry.getApiKeyForProvider(id);
    },
    selection() {
      const state = restoreAccountSelections(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
      assert.equal(state.status, "loaded");
      return state.status === "loaded" ? state.selections[id] : undefined;
    },
    selectionEntries() {
      return ctx.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "pi-accounts-selection");
    },
    setModel(provider: string) {
      const selected = registry.getAll().find((candidate) => candidate.provider === provider);
      assert.ok(selected);
      Object.assign(ctx, { model: selected });
    },
    activate(account: string | null) {
      return new Promise<AccountActivationResult>((reply) => {
        mock.eventBus.emit("accounts:activation:v1", { session: ctx.sessionManager, provider: id, account, reply });
      });
    },
    async manual(account: string) {
      choices.push(`Switch ${adapter.displayName} account`, account);
      await mock.commands.get("accounts")?.handler("", ctx);
      assert.deepEqual(choices, []);
    },
    async ready(provider: AccountProviderId = id) {
      const tasks: Promise<unknown>[] = [];
      mock.eventBus.emit(OAUTH_CREDENTIAL_READINESS_CHANNEL, {
        session: ctx.sessionManager,
        provider,
        waitUntil: (task: Promise<unknown>) => tasks.push(task),
      });
      assert.equal(tasks.length, 1);
      await Promise.all(tasks);
    },
    async start() {
      await emit("session_start");
      await emit("before_agent_start");
    },
    async turn() {
      idle = false;
      await emit("turn_start");
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      stopCounting();
      await emit("session_shutdown");
    },
  };
  fixtures.add(fixture);
  return fixture;
}

export const enabled = (accounts = ["backup", "spare"]) => ({ enabled: true, accounts, minRemainingPercent: 5 });
