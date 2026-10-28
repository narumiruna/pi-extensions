import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  initTheme,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test, vi } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import { createUsageSettingsRuntime } from "../src/settings.js";

initTheme("dark", false);
const nativeModel = { provider: "openai", id: "gpt-6.1-sol", name: "GPT", baseUrl: "https://api.openai.com/v1" };
const codexModel = { ...nativeModel, provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" };
const access = (account = "account-test") =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.sig`;
const native = {
  type: "oauth",
  access: "native-access",
  refresh: "native-refresh",
  clientId: "oaiapp_test",
  scopes: ["chatgpt.tokens.use.direct"],
  expires: Date.now() + 3_600_000,
};
const codex = {
  type: "oauth",
  access: access(),
  refresh: "codex-refresh",
  accountId: "account-test",
  expires: native.expires,
};
const apps = {
  items: [
    {
      id: native.clientId,
      allowed_usage_percent: 100,
      windows: [{ used_percent: 10, limit_window_seconds: 604800, reset_at: 2_000_000_000 }],
    },
  ],
};
const plan = {
  rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1_999_999_000 } },
};
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(mode: "tui" | "rpc" = "rpc", selected = nativeModel, obsolete?: unknown, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-openai-companion-"));
  roots.push(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const { default: extension } = await import("../src/usage.js");
  const runtime = createUsageSettingsRuntime(join(root, "pi-usage.json"));
  await writeFile(
    join(root, "pi-usage.json"),
    JSON.stringify({
      openaiUseCodexUsage: enabled,
      ...(obsolete === undefined ? {} : { openaiCompanionUsage: obsolete }),
    }),
  );
  await runtime.reload();
  const mock = createMockPi();
  let companion: typeof codex | undefined = codex;
  const registry = {
    getAvailable: () => [selected, nativeModel, codexModel],
    getAll: () => [selected, nativeModel, codexModel],
    getProviderAuthStatus: (id: string) => ({ configured: id === "openai" || id === "openai-codex" }),
    getProviderDisplayName: (id: string) => (id === "openai" ? "OpenAI" : id === "openai-codex" ? "OpenAI Codex" : id),
    getProviderAuth: async (id: string) =>
      id === "openai"
        ? { source: "OAuth", auth: { apiKey: native.access } }
        : id === "openai-codex" && companion
          ? { source: "OAuth", auth: { apiKey: companion.access } }
          : undefined,
    getApiKeyAndHeaders: async (model: { provider: string }) => ({
      ok: true,
      apiKey: model.provider === "openai" ? native.access : companion?.access,
    }),
  };
  extension(mock.pi, {
    settingsRuntime: runtime,
    credentialReader: (id) => (id === "openai" ? native : id === "openai-codex" ? companion : undefined),
  });
  const titles: string[] = [];
  const actions: string[] = [];
  let queue: string[] = ["Close"];
  const mockedContext = createMockContext({
    mode,
    model: selected,
    modelRegistry: registry,
    cwd: root,
    ...(mode === "rpc"
      ? {
          select: async (title: string, options: string[]) => {
            titles.push(title);
            actions.push(...options);
            const choice = queue.shift() ?? "Close";
            return options.includes(choice) ? choice : undefined;
          },
        }
      : {
          custom: async (factory: unknown) => {
            const harness = createCustomSelectorHarness(factory, 100, undefined, 40);
            try {
              if (harness.isPiTuiKitScreen) {
                titles.push(harness.render().join("\n"));
                harness.handleInput("\u0003");
              }
              return await harness.resultPromise;
            } finally {
              harness.dispose();
            }
          },
        }),
  });
  const context = { ...mockedContext, ctx: mockedContext.ctx as ExtensionCommandContext };
  const emit = async (event: string, ctx = context.ctx) => {
    for (const handler of mock.events.get(event) ?? []) await handler({}, ctx);
  };
  const command = mock.commands.get("usage");
  assert.ok(command);
  const run = () => command.handler("", context.ctx);
  return {
    mock,
    context,
    runtime,
    titles,
    actions,
    registry,
    emit,
    run,
    queue: (values: string[]) => {
      queue = values;
    },
    companion: (value: typeof codex | undefined) => {
      companion = value;
    },
  };
}
for (const obsolete of [undefined, true, false, "obsolete"] as const) {
  test(`native opt-in queries companion independently of obsolete preference ${obsolete}`, async () => {
    const state = await setup("rpc", nativeModel, obsolete);
    const calls = mockFetch();
    try {
      await state.emit("session_start");
      await vi.waitFor(() => assert.match(state.context.statuses.get("usage") ?? "", /^chatgpt plan 80% ↻ [\ddhms]+$/));
      await state.run();
      assert.equal(calls.length, 2);
      assert.equal(state.runtime.get().settings.codexFastMode, false);
    } finally {
      await state.emit("session_shutdown");
    }
  });
}

function mockFetch() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(url.endsWith("/apps") ? apps : plan));
  });
  return calls;
}

for (const mode of ["tui", "rpc"] as const) {
  test(`opt-in companion report is visible in ${mode} and never offers native mutations`, async () => {
    const state = await setup(mode);
    const calls = mockFetch();
    try {
      await state.run();
      assert.match(state.titles.join("\n"), /Plan limits[\s\S]*80%[\s\S]*App limits[\s\S]*resets/);
      assert.match(state.context.statuses.get("usage") ?? "", /^chatgpt plan 80% ↻ [\ddhms]+$/);
      assert.doesNotMatch(state.titles.join("\n"), /native-access|account-test|oaiapp_test|90%/);
      assert.doesNotMatch(state.context.statuses.get("usage") ?? "", /app[^%]*%/);
      assert.ok(!state.actions.some((action) => /Turn Fast|Redeem usage/.test(action)));
      assert.equal(calls.length, 2);
      assert.deepEqual(state.mock.entries, []);
      assert.deepEqual(state.mock.sentMessages, []);
    } finally {
      await state.emit("session_shutdown");
    }
    assert.equal(state.context.statuses.get("usage"), undefined);
  });
}

for (const action of ["another", "all"] as const) {
  test(`companion usage works in ${action} configured-provider view without publishing its status`, async () => {
    const other = { ...nativeModel, provider: "unsupported" };
    const state = await setup("rpc", other);
    mockFetch();
    state.queue(
      action === "another"
        ? ["View another configured provider…", "OpenAI", "Close"]
        : ["View all configured providers…", "Close"],
    );
    try {
      await state.run();
      assert.match(state.titles.join("\n"), /OpenAI Usage · Configured[\s\S]*Plan limits[\s\S]*App limits/);
      assert.equal(state.context.statuses.get("usage"), undefined);
    } finally {
      await state.emit("session_shutdown");
    }
  });
}

for (const action of ["another", "all"] as const) {
  test(`configured native ${action} view revalidates after awaiting the selected provider`, async () => {
    const selected = { ...nativeModel, provider: "deepseek", baseUrl: "https://api.deepseek.com" };
    const state = await setup("rpc", selected);
    let planRead = false;
    const originalAuth = state.registry.getProviderAuth;
    Object.assign(state.registry, {
      getProviderAuth: async (id: string) => {
        if (id !== "deepseek") return originalAuth(id);
        if (planRead) state.companion(undefined);
        return { source: "API key", auth: { apiKey: "deepseek-key" } };
      },
      getApiKeyAndHeaders: async (model: { provider: string }) => ({
        ok: true,
        apiKey: model.provider === "deepseek" ? "deepseek-key" : native.access,
      }),
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("deepseek.com"))
        return new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: "USD", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }],
          }),
        );
      if (url.endsWith("/apps")) return new Response(JSON.stringify(apps));
      planRead = true;
      return new Response(JSON.stringify(plan));
    });
    state.queue(
      action === "another"
        ? ["View another configured provider…", "OpenAI", "Close"]
        : ["View all configured providers…", "Close"],
    );
    try {
      await state.run();
      assert.equal(planRead, true);
      const rendered = state.titles.at(-1) ?? "";
      assert.match(rendered, /login openai-codex/);
      assert.doesNotMatch(rendered.split("OpenAI Codex Usage")[0] ?? "", /Plan limits|App limits|80%|90%/);
    } finally {
      await state.emit("session_shutdown");
    }
  });
}

test("removing the companion drops numerical cache and restores web-only guidance", async () => {
  const state = await setup();
  const calls = mockFetch();
  try {
    await state.run();
    assert.equal(calls.length, 2);
    state.companion(undefined);
    await state.run();
    assert.equal(calls.length, 2);
    assert.equal(state.context.statuses.get("usage"), "chatgpt usage: web only");
    assert.match(state.titles.at(-1) ?? "", /login openai-codex/);
    state.companion(codex);
    await state.run();
    assert.equal(calls.length, 4);
  } finally {
    await state.emit("session_shutdown");
  }
});

for (const failure of ["missing", "invalid"] as const) {
  test(`configured native ${failure} companion invalidates old numerical cache before recovery`, async () => {
    const state = await setup("rpc", { ...nativeModel, provider: "unsupported" });
    const calls = mockFetch();
    const query = async () => {
      state.queue(["View another configured provider…", "OpenAI", "Close"]);
      await state.run();
    };
    try {
      await query();
      assert.equal(calls.length, 2);
      state.companion(failure === "missing" ? undefined : { ...codex, refresh: "" });
      await query();
      assert.doesNotMatch(state.titles.at(-1) ?? "", /Plan limits|App limits/);
      assert.equal(calls.length, 2);
      state.companion(codex);
      await query();
      assert.equal(calls.length, 4);
      assert.match(state.titles.at(-1) ?? "", /Plan limits/);
    } finally {
      await state.emit("session_shutdown");
    }
  });
}

test("a failed refresh invalidates companion cache instead of restoring old quota on the next command", async () => {
  const state = await setup();
  mockFetch();
  try {
    await state.run();
    const fetch = vi.fn(async () => new Response("failure", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    state.queue(["Refresh current usage", "Close"]);
    await state.run();
    assert.match(state.titles.at(-1) ?? "", /Query failed/);
    await state.run();
    assert.match(state.titles.at(-1) ?? "", /Query failed/);
    assert.equal(fetch.mock.calls.length, 1);
    assert.doesNotMatch(state.context.statuses.get("usage") ?? "", /80%|90%/);
  } finally {
    await state.emit("session_shutdown");
  }
});

for (const boundary of ["session_shutdown", "session_start", "model_select", "hard cancel", "dispose"] as const) {
  test(`pending companion HTTP is aborted on ${boundary} without late publication`, async () => {
    const state = await setup(boundary === "hard cancel" || boundary === "dispose" ? "tui" : "rpc");
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          assert.ok(init.signal);
          observedSignal = init.signal;
          observedSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
          ready();
        }),
    );
    let dispose: (() => void) | undefined;
    let cleanup: (() => void) | undefined;
    if (boundary === "hard cancel" || boundary === "dispose") {
      Object.assign(state.context.ctx.ui, {
        custom: async (factory: unknown) => {
          const harness = createCustomSelectorHarness(factory, 100);
          cleanup = () => harness.dispose();
          let close!: () => void;
          const closed = new Promise<undefined>((resolve) => {
            close = () => resolve(undefined);
          });
          dispose = () => {
            if (boundary === "hard cancel") harness.handleInput("\u0003");
            else {
              harness.dispose();
              close();
            }
          };
          return Promise.race([harness.resultPromise, closed]);
        },
      });
    }
    const pending = state.run();
    try {
      await entered;
      if (boundary === "hard cancel" || boundary === "dispose") dispose?.();
      else if (boundary === "model_select") {
        Object.assign(state.context.ctx, { model: { ...nativeModel, provider: "unsupported" } });
        for (const handler of state.mock.events.get("model_select") ?? [])
          await handler({ model: state.context.ctx.model }, state.context.ctx);
      } else if (boundary === "session_start") {
        await state.emit(
          "session_start",
          createMockContext({ model: { ...nativeModel, provider: "unsupported" } }).ctx,
        );
      } else await state.emit(boundary);
      await pending;
      assert.equal(observedSignal?.aborted, true);
      assert.equal(state.titles.length, 0);
      assert.doesNotMatch(state.context.statuses.get("usage") ?? "", /80%|90%/);
    } finally {
      cleanup?.();
      await state.emit("session_shutdown");
    }
  });
}

for (const change of ["rotation", "removal"] as const) {
  test(`${change} change while the app response is pending prevents a second request and stale publication`, async () => {
    const state = await setup();
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      ready();
      await wait;
      return new Response(JSON.stringify(apps));
    });
    vi.stubGlobal("fetch", fetch);
    const pending = state.run();
    try {
      await entered;
      state.companion(change === "rotation" ? { ...codex, access: access("other"), accountId: "other" } : undefined);
      release();
      await pending;
      assert.equal(fetch.mock.calls.length, 1);
      assert.equal(state.titles.length, 0);
    } finally {
      release();
      await pending;
      await state.emit("session_shutdown");
    }
  });
}

for (const reset of ["missing", "expired", "future"] as const) {
  test(`companion countdown follows ${reset} plan reset, not future app resets`, async () => {
    const state = await setup();
    const now = new Date("2026-10-06T00:00:00Z").getTime();
    vi.useFakeTimers({ now });
    const setStatus = vi.spyOn(state.context.ctx.ui, "setStatus");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const window = {
        used_percent: 20,
        limit_window_seconds: 18000,
        ...(reset === "missing" ? {} : { reset_at: now / 1000 + (reset === "future" ? 90 : -60) }),
      };
      return new Response(JSON.stringify(url.endsWith("/apps") ? apps : { rate_limit: { primary_window: window } }));
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await state.emit("session_start");
      await state.run();
      assert.equal(vi.getTimerCount(), reset === "future" ? 2 : 1);
      const publications = setStatus.mock.calls.length;
      const requests = fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal(setStatus.mock.calls.length, publications + (reset === "future" ? 1 : 0));
      if (reset === "future") assert.equal(state.context.statuses.get("usage"), "chatgpt plan 80% ↻ 1m");
      await vi.advanceTimersByTimeAsync(60_000);
      const completedPublications = setStatus.mock.calls.length;
      assert.equal(completedPublications, publications + (reset === "future" ? 2 : 0));
      assert.equal(vi.getTimerCount(), 1); // Only the five-minute endpoint refresh remains.
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal(setStatus.mock.calls.length, completedPublications);
      assert.equal(fetch.mock.calls.length, requests);
      await state.emit("session_shutdown");
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await state.emit("session_shutdown");
    }
  });
}

test("automatic refresh publishes only plan limits and releases its HTTP/timers on shutdown", async () => {
  const state = await setup();
  const calls = mockFetch();
  try {
    await state.emit("session_start");
    await vi.waitFor(() => assert.match(state.context.statuses.get("usage") ?? "", /^chatgpt plan 80% ↻ [\ddhms]+$/));
    assert.equal(calls.length, 2);
    vi.useFakeTimers();
    await state.run();
    await vi.advanceTimersByTimeAsync(300_000);
    assert.equal(calls.length, 4);
    await state.emit("session_shutdown");
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await state.emit("session_shutdown");
  }
});

test("real Pi resolves companion OAuth but never reuses it after a runtime API-key override", async () => {
  const state = await setup();
  mockFetch();
  const store: CredentialStore = {
    read: async (id) =>
      id === "openai" ? (native as Credential) : id === "openai-codex" ? (codex as Credential) : undefined,
    list: async () => [
      { providerId: "openai", type: "oauth" },
      { providerId: "openai-codex", type: "oauth" },
    ],
    modify: async () => {
      throw new Error("Fresh synthetic credentials must not refresh");
    },
    delete: async () => undefined,
  };
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const model = registry.find("openai", "gpt-6.1-sol");
  assert.ok(model);
  Object.assign(state.context.ctx, { model, modelRegistry: registry });
  try {
    await state.run();
    assert.match(state.context.statuses.get("usage") ?? "", /plan.*80%/);
    await runtime.setRuntimeApiKey("openai-codex", "synthetic-api-key");
    await state.run();
    // Codex is OAuth-only in installed Pi: its API-key override resolves no auth,
    // so it behaves like a missing companion rather than fabricating quota.
    assert.equal(state.context.statuses.get("usage"), "chatgpt usage: web only");
    assert.match(state.titles.at(-1) ?? "", /login openai-codex/);
  } finally {
    await state.emit("session_shutdown");
  }
});

type SettingsHarness = {
  handleInput(data: string): unknown;
  render(): readonly string[];
  dispose(): void;
};

async function settingsCommand(
  state: Awaited<ReturnType<typeof setup>>,
  change: (harness: SettingsHarness) => Promise<void>,
) {
  let opened = false;
  Object.assign(state.context.ctx.ui, {
    custom: async (factory: unknown) => {
      const tui = createTuiHarness({ width: 120, rows: 35, keybindings: getKeybindings() });
      let kitScreen = false;
      const running = tui.custom(async (...args) => {
        const component = await (factory as Parameters<typeof tui.custom>[0])(...args);
        kitScreen = "__piTuiKitScreen" in component && component.__piTuiKitScreen === true;
        return component;
      });
      const harness: SettingsHarness = { handleInput: tui.send, render: tui.render, dispose: tui.dispose };
      try {
        await tui.waitForOpen();
        const text = harness.render().join("\n");
        if (kitScreen) {
          state.titles.push(text);
          if (!opened) {
            opened = true;
            harness.handleInput("\u001b[B");
            harness.handleInput("\r");
          } else harness.handleInput("\u0003");
        } else if (text.includes("pi-usage Settings")) {
          for (let row = 0; row < 3; row++) harness.handleInput("\u001b[B");
          await change(harness);
          harness.handleInput("\u0003");
        }
        return await running;
      } finally {
        harness.dispose();
      }
    },
  });
  await state.run();
}

for (const action of ["current", "another", "all"] as const) {
  test(`default Off isolates native queries in the ${action} view with an existing Codex login`, async () => {
    const state = await setup(
      "rpc",
      action === "current" ? nativeModel : { ...nativeModel, provider: "unsupported" },
      true,
      false,
    );
    const requests = mockFetch();
    if (action !== "current")
      state.queue(
        action === "another"
          ? ["View another configured provider…", "OpenAI", "Close"]
          : ["View all configured providers…", "Close"],
      );
    try {
      await state.run();
      assert.match(state.titles.join("\n"), /Codex companion usage is disabled/);
      assert.ok(!requests.some((url) => url.endsWith("/apps")));
      if (action !== "all") assert.deepEqual(requests, []);
      else assert.ok(requests.length > 0);
    } finally {
      await state.emit("session_shutdown");
    }
  });
}

test("Off remains isolated on session, turn, tree, and scheduled refreshes", async () => {
  const state = await setup("rpc", nativeModel, true, false);
  const requests = mockFetch();
  const auth = vi.spyOn(state.registry, "getProviderAuth");
  try {
    await state.emit("session_start");
    await state.run();
    await state.emit("turn_start");
    await state.run();
    await state.emit("session_tree");
    await state.run();
    vi.useFakeTimers();
    await state.run();
    await vi.advanceTimersByTimeAsync(300_000);
    assert.equal(state.context.statuses.get("usage"), "chatgpt usage: web only");
    assert.ok(auth.mock.calls.every(([provider]) => provider === "openai"));
    assert.deepEqual(requests, []);
    await state.emit("session_shutdown");
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await state.emit("session_shutdown");
  }
});

test("Settings Off → On → Off applies without reload and clears companion quota", async () => {
  const state = await setup("tui", nativeModel, true, false);
  const requests = mockFetch();
  const status = vi.spyOn(state.context.ctx.ui, "setStatus");
  let clearedDuringSave = false;
  try {
    await settingsCommand(state, async (harness) => {
      harness.handleInput("\r");
      await vi.waitFor(() => assert.equal(state.runtime.get().settings.openaiUseCodexUsage, true));
    });
    assert.match(state.context.statuses.get("usage") ?? "", /chatgpt plan 80%/);
    const firstRequests = requests.length;
    let publications = 0;
    await settingsCommand(state, async (harness) => {
      publications = status.mock.calls.length;
      harness.handleInput("\r");
      await vi.waitFor(() => assert.equal(state.runtime.get().settings.openaiUseCodexUsage, false));
      clearedDuringSave = state.context.statuses.get("usage") === undefined;
    });
    assert.equal(clearedDuringSave, true);
    assert.equal(state.context.statuses.get("usage"), "chatgpt usage: web only");
    assert.equal(requests.length, firstRequests);
    assert.ok(!status.mock.calls.slice(publications).some(([, text]) => text?.includes("80%")));
    assert.match(state.titles.at(-1) ?? "", /Codex companion usage is disabled/);
  } finally {
    await state.emit("session_shutdown");
  }
});

for (const boundary of ["normal", "cancel-after-publication", "dispose-after-publication", "off-on-cycle"] as const) {
  test(`durable disable cancels pending companion HTTP with ${boundary} and rejects a late response`, async () => {
    const state = await setup("tui");
    mockFetch();
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const originalUpdate = state.runtime.update;
    let activeHarness: SettingsHarness | undefined;
    let delayed = false;
    let disabled = false;
    let cleared = false;
    const publications = vi.spyOn(state.context.ctx.ui, "setStatus");
    const lateFetch = vi.fn(async (_url: string, init: RequestInit) => {
      observedSignal = init.signal ?? undefined;
      ready();
      await response;
      return new Response(JSON.stringify(apps));
    });
    vi.spyOn(state.runtime, "update").mockImplementation(async (patch, signal) => {
      if (patch.openaiUseCodexUsage === false && !delayed) {
        delayed = true;
        state.companion({ ...codex, access: access("rotated"), accountId: "rotated" });
        vi.stubGlobal("fetch", lateFetch);
        await state.emit("turn_start");
        await entered;
      }
      const saved = await originalUpdate(patch, signal);
      if (patch.openaiUseCodexUsage === false) {
        disabled = true;
        if (boundary === "cancel-after-publication") activeHarness?.handleInput("\u0003");
        if (boundary === "dispose-after-publication") activeHarness?.dispose();
      }
      return saved;
    });
    try {
      await settingsCommand(state, async (harness) => {
        activeHarness = harness;
        harness.handleInput("\r");
        await vi.waitFor(() => assert.equal(observedSignal?.aborted, true));
        cleared = state.context.statuses.get("usage") === undefined;
        if (boundary === "off-on-cycle") {
          await originalUpdate({ openaiUseCodexUsage: true });
        }
        release();
      });
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(disabled, true);
      assert.equal(cleared, true);
      assert.equal(observedSignal?.aborted, true);
      assert.equal(lateFetch.mock.calls.length, 1);
      assert.doesNotMatch(state.context.statuses.get("usage") ?? "", /80%|90%/);
      const clearedAt = publications.mock.calls.map(([, text]) => text === undefined).lastIndexOf(true);
      assert.ok(!publications.mock.calls.slice(clearedAt + 1).some(([, text]) => /80%|90%/.test(text ?? "")));
    } finally {
      release?.();
      await state.emit("session_shutdown");
    }
  });
}

test("failed companion disable keeps its previous setting, report, and displayed value", async () => {
  const state = await setup("tui");
  const requests = mockFetch();
  vi.spyOn(state.runtime, "update").mockRejectedValue(new Error("save rejected"));
  let screen = "";
  try {
    await settingsCommand(state, async (harness) => {
      harness.handleInput("\r");
      await vi.waitFor(() =>
        assert.ok(state.context.notifications.some((note) => note.message.includes("save rejected"))),
      );
      screen = harness.render().join("\n");
    });
    assert.equal(state.runtime.get().settings.openaiUseCodexUsage, true);
    assert.match(screen, /Use Codex login for OpenAI usage[^\n]*On/);
    assert.match(state.context.statuses.get("usage") ?? "", /chatgpt plan 80%/);
    assert.equal(requests.length, 2);
  } finally {
    await state.emit("session_shutdown");
  }
});

test("disable while companion readiness is pending stops late Codex credential reads", async () => {
  const state = await setup("tui");
  mockFetch();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const originalUpdate = state.runtime.update;
  const auth = vi.spyOn(state.registry, "getProviderAuth");
  let readsBeforeDisable = 0;
  let readsAfterDisable = 0;
  // Install the wait only for the background query that races the save.
  let waiting = false;
  const eventBus = (state.mock.pi as ExtensionAPI).events;
  eventBus.on("oauth:credential-readiness:v1", (value) => {
    const request = value as { provider: string; waitUntil(value: Promise<void>): void };
    if (waiting && request.provider === "openai-codex") {
      request.waitUntil(wait);
      ready();
    }
  });
  vi.spyOn(state.runtime, "update").mockImplementation(async (patch, signal) => {
    if (patch.openaiUseCodexUsage === false) {
      waiting = true;
      await state.emit("turn_start");
      await entered;
      readsBeforeDisable = auth.mock.calls.filter(([provider]) => provider === "openai-codex").length;
    }
    return originalUpdate(patch, signal);
  });
  try {
    await settingsCommand(state, async (harness) => {
      harness.handleInput("\r");
      await vi.waitFor(() => assert.equal(state.runtime.get().settings.openaiUseCodexUsage, false));
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      readsAfterDisable = auth.mock.calls.filter(([provider]) => provider === "openai-codex").length;
    });
    assert.ok(readsBeforeDisable > 0);
    assert.equal(readsAfterDisable, readsBeforeDisable);
  } finally {
    release();
    await state.emit("session_shutdown");
  }
});

for (const handoff of ["event", "cancel-after-publication", "dispose-after-publication"] as const) {
  test(`Settings ${handoff} handoff restores native status and its scheduled refresh`, async () => {
    const state = await setup("tui");
    const requests = mockFetch();
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const originalUpdate = state.runtime.update;
    const lateFetch = vi.fn(async () => {
      ready();
      await response;
      return new Response(JSON.stringify(apps));
    });
    let activeHarness: SettingsHarness | undefined;
    vi.spyOn(state.runtime, "update").mockImplementation(async (patch, signal) => {
      if (patch.openaiUseCodexUsage === false && handoff === "event") {
        state.companion({ ...codex, access: access("rotated"), accountId: "rotated" });
        vi.stubGlobal("fetch", lateFetch);
        await state.emit("turn_start");
        await entered;
      }
      const saved = await originalUpdate(patch, signal);
      if (handoff === "cancel-after-publication") activeHarness?.handleInput("\u0003");
      if (handoff === "dispose-after-publication") activeHarness?.dispose();
      return saved;
    });
    try {
      vi.useFakeTimers();
      await state.emit("session_start");
      await settingsCommand(state, async (harness) => {
        activeHarness = harness;
        harness.handleInput("\r");
        await vi.waitFor(() => assert.equal(state.runtime.get().settings.openaiUseCodexUsage, false));
        release();
      });
      await vi.waitFor(() => assert.equal(state.context.statuses.get("usage"), "chatgpt usage: web only"));
      assert.equal(vi.getTimerCount(), 1);
      const auth = vi.spyOn(state.registry, "getProviderAuth");
      await vi.advanceTimersByTimeAsync(300_000);
      assert.equal(state.context.statuses.get("usage"), "chatgpt usage: web only");
      assert.ok(auth.mock.calls.length > 0);
      assert.ok(auth.mock.calls.every(([provider]) => provider === "openai"));
      assert.equal(lateFetch.mock.calls.length, handoff === "event" ? 1 : 0);
      assert.ok(requests.length > 0);
    } finally {
      release();
      await state.emit("session_shutdown");
    }
  });
}
