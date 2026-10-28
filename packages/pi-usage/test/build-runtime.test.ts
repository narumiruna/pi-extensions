import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createEventBus,
  DefaultResourceLoader,
  type ExtensionContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";
import { queryUsage } from "./fixtures/usage-client.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-usage",
  forbiddenEagerInputs: [],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-usage-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("usage"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const credential = {
      type: "oauth",
      access: "synthetic-generated-access",
      refresh: "synthetic-generated-refresh",
      expires: Date.now() + 3_600_000,
      clientId: "synthetic-generated-client",
      scopes: ["chatgpt.tokens.use.direct"],
    };
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: credential }), { mode: 0o600 });
    const model = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai", baseUrl: "https://api.openai.com/v1" };
    let title = "";
    const context = createMockContext({
      mode: "rpc",
      cwd: root,
      model,
      select: async (value: string) => {
        title = value;
        return "Close";
      },
      modelRegistry: {
        getAvailable: () => [model],
        getAll: () => [model],
        getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: credential.access } }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: credential.access }),
      },
    });
    try {
      // Trigger the generated native-auth path and lazy Kit boundary through Jiti, not Vitest's importer.
      const command = extension.commands.get("usage");
      assert.ok(command);
      await command.handler("", context.ctx);
      assert.match(title, /Connected \(native OAuth\)/);
      assert.match(title, /Codex companion usage is disabled/);
      assert.match(title, /https:\/\/chatgpt\.com\/settings\/usage/);
      assert.equal(context.statuses.get("usage"), "chatgpt usage: web only");

      const companion = {
        type: "oauth",
        access: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.sig`,
        refresh: "synthetic-companion-refresh",
        expires: credential.expires,
        accountId: "synthetic-account",
      };
      await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: credential, "openai-codex": companion }), {
        mode: 0o600,
      });
      await writeFile(
        join(agentDir, "pi-usage.json"),
        JSON.stringify({
          openaiCompanionUsage: false,
          statuslineDisplay: {
            template: "[{windows}] {provider}",
            countdown: "{window}:{value} ↻ {reset}",
            separator: " / ",
          },
        }),
      );
      const registry = (context.ctx as ExtensionContext).modelRegistry;
      Object.assign(registry, {
        getAll: () => [model, { ...model, provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" }],
        getProviderAuth: async (id: string) => ({
          source: "OAuth",
          auth: { apiKey: id === "openai" ? credential.access : companion.access },
        }),
      });
      const requests: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        requests.push(url);
        assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${companion.access}`);
        assert.equal((init.headers as Record<string, string>)["ChatGPT-Account-Id"], companion.accountId);
        assert.ok(!JSON.stringify(init).includes(credential.access));
        const window = { used_percent: 20, limit_window_seconds: 18000 };
        return new Response(
          JSON.stringify(
            url.endsWith("/apps")
              ? { items: [{ id: credential.clientId, windows: [window] }] }
              : { rate_limit: { primary_window: window } },
          ),
        );
      });
      // An existing companion login and historical preference must not opt in.
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, context.ctx);
      await command.handler("", context.ctx);
      assert.match(title, /Codex companion usage is disabled/);
      assert.equal(requests.length, 0);
      await writeFile(
        join(agentDir, "pi-usage.json"),
        JSON.stringify({
          openaiUseCodexUsage: true,
          statuslineDisplay: {
            template: "[{windows}] {provider}",
            countdown: "{window}:{value} ↻ {reset}",
            separator: " / ",
          },
        }),
      );
      // Both generated lazy modules are loaded through the real Jiti boundary after opt-in.
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, context.ctx);
      await command.handler("", context.ctx);
      assert.match(title, /Plan limits/);
      assert.match(title, /App limits/);
      assert.equal(context.statuses.get("usage"), "chatgpt plan 80% 5h");
      assert.match(title, /Reset time unavailable/);
      assert.doesNotMatch(title.split("App limits:")[1]?.split("App allowance:")[0] ?? "", /%|█|░/);
      assert.ok(requests.some((url) => url.endsWith("/apps")));
      assert.ok(requests.some((url) => url.endsWith("/wham/usage")));

      // Exercise changed multi-window formatting through the generated command path.
      Object.assign(model, { provider: "command-code", baseUrl: "https://api.commandcode.ai/provider" });
      Object.assign(registry, {
        getAll: () => [model],
        getProviderAuth: async () => ({ source: "ApiKey", auth: { apiKey: "synthetic-command-key" } }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-command-key" }),
      });
      const commandReset = Date.now() + 150_000;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer synthetic-command-key");
        assert.equal(new URL(url).origin, "https://api.commandcode.ai");
        const payload = url.endsWith("/alpha/whoami")
          ? { user: { userName: "synthetic-account" } }
          : url.includes("/credits")
            ? {
                windowLimits: {
                  fiveHour: { used: 11, cap: 100, resetAt: commandReset },
                  weekly: { used: 3, cap: 100 },
                },
              }
            : {};
        return new Response(JSON.stringify(payload));
      });
      await command.handler("", context.ctx);
      assert.equal(context.statuses.get("usage"), "[5h:89% ↻ 3m / wk:97%] cmd");
    } finally {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, context.ctx);
    }
    assert.equal(context.statuses.get("usage"), undefined);
  } finally {
    vi.unstubAllGlobals();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

test("generated API refresh crosses native lazy boundaries and disposes its bus listeners", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-usage-build-test-api-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let dispose: () => void = () => undefined;
  try {
    await builder.buildRuntime({ outputDirectory: join(root, "dist") });
    await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const native = {
      type: "oauth",
      access: "synthetic-native-api-access",
      refresh: "synthetic-native-api-refresh",
      expires: Date.now() + 3_600_000,
      clientId: "api-client",
      scopes: ["chatgpt.tokens.use.direct"],
    };
    const companion = {
      type: "oauth",
      access: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "api-account" } })).toString("base64url")}.sig`,
      refresh: "synthetic-companion-api-refresh",
      expires: native.expires,
      accountId: "api-account",
    };
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: native, "openai-codex": companion }), {
      mode: 0o600,
    });
    await writeFile(join(agentDir, "pi-usage.json"), JSON.stringify({ openaiUseCodexUsage: true }));
    const eventBus = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      eventBus,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(root, "dist/index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    dispose = () => loaded.runtime.invalidate("usage API generated test cleanup");
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    const current = { id: "unrelated", name: "Unrelated", provider: "unrelated", baseUrl: "https://other.invalid" };
    const models = [
      current,
      { id: "native", name: "Native", provider: "openai", baseUrl: "https://api.openai.com/v1" },
      { id: "codex", name: "Codex", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
    ];
    const context = createMockContext({
      mode: "json",
      cwd: root,
      model: current,
      modelRegistry: {
        getAll: () => models,
        getAvailable: () => models,
        getProviderAuth: async (id: string) => ({
          source: "OAuth",
          auth: { apiKey: id === "openai" ? native.access : companion.access },
        }),
      },
    });
    const ctx = context.ctx as ExtensionContext;
    const requests: string[] = [];
    const reset = Math.floor(Date.now() / 1_000) + 3_600;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push(url);
      assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${companion.access}`);
      assert.ok(!JSON.stringify(init).includes(native.access));
      const window = { used_percent: 20, limit_window_seconds: 18_000, reset_at: reset };
      return new Response(
        JSON.stringify(
          url.endsWith("/apps")
            ? { items: [{ id: native.clientId, windows: [window] }] }
            : { rate_limit: { primary_window: window } },
        ),
      );
    });
    const changes: unknown[] = [];
    eventBus.on("usage:changed:v1", (event) => changes.push(event));
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
    let capability: Promise<unknown> | undefined;
    eventBus.emit("usage:capabilities:v1", {
      session: ctx.sessionManager,
      sessionId: ctx.sessionManager.getSessionId(),
      providerId: "openai",
      signal: new AbortController().signal,
      respond(value: unknown) {
        capability = Promise.resolve(value);
        return true;
      },
    });
    assert.ok(capability);
    assert.deepEqual(await capability, {
      status: "ready",
      providerId: "openai",
      supported: true,
      measurements: ["quota", "reset-time"],
      supportsRefresh: true,
    });
    assert.equal(requests.length, 0);
    const result = await queryUsage({ events: eventBus }, ctx, { providerId: "openai", refresh: true });
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.equal(result.report.buckets[0]?.resetsAt, reset * 1_000);
      assert.equal(result.report.source, "openai-chatgpt-companion");
    }
    assert.equal(requests.length, 2);
    assert.equal(changes.length, 1);
    assert.deepEqual(await queryUsage({ events: eventBus }, ctx, { providerId: "openai" }), {
      status: "unavailable",
      providerId: "openai",
      reason: "cache-miss",
    });
    assert.equal(requests.length, 2);
    for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    assert.deepEqual(await queryUsage({ events: eventBus }, ctx, { providerId: "openai" }), {
      status: "unavailable",
      providerId: "openai",
      reason: "no-service",
    });
  } finally {
    dispose();
    vi.unstubAllGlobals();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
