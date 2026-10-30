import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { queryUsage } from "./fixtures/usage-client.js";

initTheme("dark", false);
const model = { id: "claude-sonnet-4-6", name: "Claude", provider: "anthropic", baseUrl: "https://api.anthropic.com" };
const extra = { is_enabled: true, currency: "USD", decimal_places: 2, used_credits: 8000, monthly_limit: 10000 };
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(enabled: boolean | null = true, mode: "rpc" | "tui" = "rpc", configured = false) {
  const root = await mkdtemp(join(tmpdir(), "anthropic-usage-lifecycle-"));
  roots.push(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
  vi.resetModules();
  const [{ default: extension }, { createUsageSettingsRuntime }] = await Promise.all([
    import("../src/usage.js"),
    import("../src/settings.js"),
  ]);
  const path = join(root, "pi-usage.json");
  if (enabled !== null) await writeFile(path, JSON.stringify({ anthropicExtraUsage: enabled }));
  const settings = createUsageSettingsRuntime(path);
  await settings.reload();
  const mock = createMockPi();
  let credential: { type: "oauth"; access: string; refresh: string; expires: number } | undefined = {
    type: "oauth",
    access: "sk-ant-oat-synthetic-current",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000,
  };
  const reader = vi.fn(() => credential);
  const registry = {
    getAll: () => [model],
    getAvailable: () => [model],
    getProviderDisplayName: (provider: string) => (provider === "anthropic" ? "Anthropic" : provider),
    getProviderAuthStatus: (provider: string) => ({ configured: provider === "anthropic" }),
    getProviderAuth: vi.fn(async (_provider: string) =>
      credential ? { source: "OAuth", auth: { apiKey: credential.access } } : undefined,
    ),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: credential?.access })),
  };
  const titles: string[] = [];
  let choices = ["Close"];
  const mockedContext = createMockContext({
    mode,
    cwd: root,
    model: configured ? { ...model, provider: "unknown" } : model,
    modelRegistry: registry,
    select:
      mode === "rpc"
        ? async (title: string, options: string[]) => {
            titles.push(title);
            const choice = choices.shift() ?? "Close";
            return options.includes(choice) ? choice : undefined;
          }
        : undefined,
    custom: async (factory: unknown) => {
      const harness = createTuiHarness({ width: 120, rows: 40, keybindings: getKeybindings() });
      let screen = false;
      const running = harness.custom(async (...args) => {
        const component = await (factory as Parameters<typeof harness.custom>[0])(...args);
        screen = "__piTuiKitScreen" in component && component.__piTuiKitScreen === true;
        return component;
      });
      try {
        await harness.waitForOpen();
        if (screen) {
          titles.push(harness.render().join("\n"));
          harness.send("\u0003");
        }
        return await running;
      } finally {
        harness.dispose();
      }
    },
  });
  const context = { ...mockedContext, ctx: mockedContext.ctx as ExtensionCommandContext };
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ extra_usage: extra })));
  vi.stubGlobal("fetch", fetch);
  extension(mock.pi, { settingsRuntime: settings, credentialReader: reader });
  const emit = async (event: string, ctx = context.ctx) => {
    for (const handler of mock.events.get(event) ?? []) await handler({ model: ctx.model }, ctx);
  };
  const command = mock.commands.get("usage");
  assert.ok(command);
  return {
    root,
    mock,
    settings,
    context,
    registry,
    titles,
    reader,
    fetch,
    emit,
    run: () => command.handler("", context.ctx),
    query: (signal?: AbortSignal) =>
      queryUsage(mock.pi, context.ctx, { providerId: "anthropic", refresh: true, signal }),
    choices: (values: string[]) => {
      choices = values;
    },
    rotate: (remove = false) => {
      if (remove) credential = undefined;
      else {
        assert.ok(credential);
        credential = { ...credential, access: "sk-ant-oat-synthetic-rotated" };
      }
    },
    close: () => emit("session_shutdown"),
  };
}

for (const mode of ["tui", "rpc"] as const) {
  test(`Claude extra usage appears in ${mode} with one cached snapshot and no model messages`, async () => {
    const state = await setup(true, mode);
    try {
      await state.emit("session_start");
      await state.run();
      await state.run();
      assert.equal(state.fetch.mock.calls.length, 1);
      assert.equal(state.context.statuses.get("usage"), "anthropic $20.00 left");
      assert.match(
        state.titles.join("\n"),
        /Used this month:\s+\$80\.00[\s\S]*Monthly limit:\s+\$100\.00[\s\S]*Remaining:\s+\$20\.00/,
      );
      assert.deepEqual(state.mock.sentMessages, []);
      assert.deepEqual(state.mock.entries, []);
    } finally {
      await state.close();
    }
    assert.equal(state.context.statuses.get("usage"), undefined);
  });
}

for (const route of ["current", "another", "all"] as const) {
  test(`default Off prevents auth, credential discovery, and HTTP in the ${route} route`, async () => {
    const state = await setup(null, "rpc", route !== "current");
    if (route !== "current")
      state.choices(
        route === "another"
          ? ["View another configured provider…", "Anthropic", "Close"]
          : ["View all configured providers…", "Close"],
      );
    try {
      await state.emit("session_start");
      await state.run();
      await state.emit("turn_start");
      await state.emit("session_tree");
      const result = await state.query();
      assert.equal(result.status, "unavailable");
      assert.match(state.titles.join("\n"), /Claude extra usage is off/);
      assert.equal(state.registry.getProviderAuth.mock.calls.length, 0);
      assert.equal(state.reader.mock.calls.length, 0);
      assert.equal(state.fetch.mock.calls.length, 0);
      assert.equal(state.context.statuses.get("usage"), undefined);
    } finally {
      await state.close();
    }
  });
}

test("enabled API refresh returns spending data without publishing a status for a configured provider", async () => {
  const state = await setup(true, "rpc", true);
  try {
    await state.emit("session_start");
    const result = await state.query();
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.equal(result.report.metrics.find((metric) => metric.id === "extra-usage-remaining")?.value, "20.00");
      assert.deepEqual(result.report.buckets, []);
    }
    assert.equal(state.context.statuses.get("usage"), undefined);
  } finally {
    await state.close();
  }
});

test("Claude status refreshes after five minutes, has no reset timer, and releases timers on shutdown", async () => {
  const state = await setup();
  try {
    await state.emit("session_start");
    vi.useFakeTimers();
    await state.run();
    assert.equal(vi.getTimerCount(), 1);
    await vi.advanceTimersByTimeAsync(300_000);
    assert.equal(state.fetch.mock.calls.length, 2);
    assert.equal(state.context.statuses.get("usage"), "anthropic $20.00 left");
    await state.close();
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    await state.close();
  }
});

for (const boundary of ["cancel", "session_shutdown", "session_start", "model_select"] as const) {
  test(`pending Claude API HTTP is cancelled on ${boundary} and cannot publish a late result`, async () => {
    const state = await setup(true, "rpc", true);
    const entered = deferred<AbortSignal>();
    const response = deferred<Response>();
    state.fetch.mockImplementation(async (_url, init) => {
      assert.ok(init.signal);
      entered.resolve(init.signal);
      return response.promise;
    });
    await state.emit("session_start");
    const controller = new AbortController();
    const pending = state.query(controller.signal);
    try {
      const signal = await entered.promise;
      if (boundary === "cancel") controller.abort();
      else if (boundary === "model_select") {
        Object.assign(state.context.ctx, { model: { ...model, provider: "another" } });
        await state.emit("model_select");
      } else await state.emit(boundary);
      const result = await pending;
      assert.equal(result.status, "unavailable");
      assert.equal(signal.aborted, true);
      response.resolve(new Response(JSON.stringify({ extra_usage: extra })));
      await Promise.resolve();
      assert.equal(state.context.statuses.get("usage"), undefined);
    } finally {
      response.resolve(new Response("{}"));
      await pending;
      await state.close();
    }
  });
}

for (const change of ["rotation", "removal", "SDK override", "disabled"] as const) {
  test(`Claude rejects a response after an unobserved ${change}`, async () => {
    const state = await setup(true, "rpc", true);
    const entered = deferred<void>();
    const response = deferred<Response>();
    state.fetch.mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    await state.emit("session_start");
    const pending = state.query();
    try {
      await entered.promise;
      if (change === "rotation" || change === "removal") state.rotate(change === "removal");
      else if (change === "SDK override") vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "Authorization: Bearer other");
      else await state.settings.update({ anthropicExtraUsage: false });
      response.resolve(new Response(JSON.stringify({ extra_usage: extra })));
      const result = await pending;
      assert.equal(result.status, "unavailable");
      assert.equal(state.context.statuses.get("usage"), undefined);
    } finally {
      response.resolve(new Response("{}"));
      await pending;
      await state.close();
    }
  });
}

for (const boundary of ["cancel", "session_shutdown", "model_select"] as const) {
  test(`pending Claude auth stops on ${boundary} before reading credentials or sending HTTP`, async () => {
    const state = await setup(true, "rpc", true);
    const entered = deferred<void>();
    const auth = deferred<void>();
    state.registry.getProviderAuth.mockImplementation(async () => {
      entered.resolve();
      await auth.promise;
      return { source: "OAuth", auth: { apiKey: "sk-ant-oat-synthetic-current" } };
    });
    await state.emit("session_start");
    const controller = new AbortController();
    const pending = state.query(controller.signal);
    try {
      await entered.promise;
      if (boundary === "cancel") controller.abort();
      else if (boundary === "model_select") {
        Object.assign(state.context.ctx, { model: { ...model, provider: "another" } });
        await state.emit(boundary);
      } else await state.emit(boundary);
      assert.equal((await pending).status, "unavailable");
      auth.resolve();
      await Promise.resolve();
      assert.equal(state.reader.mock.calls.length, 0);
      assert.equal(state.fetch.mock.calls.length, 0);
    } finally {
      auth.resolve();
      await pending;
      await state.close();
    }
  });
}

for (const route of ["another", "all"] as const) {
  test(`configured Claude ${route} view revalidates its account after unrelated current-provider work`, async () => {
    const state = await setup(true, "rpc", true);
    const router = { ...model, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
    Object.assign(state.context.ctx, { model: router });
    let anthropicRequests = 0;
    let rotated = false;
    const originalAuth = state.registry.getProviderAuth.getMockImplementation();
    assert.ok(originalAuth);
    state.registry.getProviderAuth.mockImplementation(async (provider) => {
      if (provider !== "openrouter") return originalAuth(provider);
      if (anthropicRequests > 0 && !rotated) {
        rotated = true;
        state.rotate();
      }
      return { source: "API key", auth: { apiKey: "synthetic-router-key" } };
    });
    state.registry.getApiKeyAndHeaders.mockImplementation(async () => ({ ok: true, apiKey: "synthetic-router-key" }));
    state.fetch.mockImplementation(async (url, init) => {
      if (url.includes("openrouter.ai"))
        return new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 75, usage: 25 } }));
      anthropicRequests++;
      const other = new Headers(init.headers).get("Authorization")?.includes("rotated");
      return new Response(JSON.stringify({ extra_usage: { ...extra, used_credits: other ? 5000 : 8000 } }));
    });
    state.choices(
      route === "another"
        ? ["View another configured provider…", "Anthropic", "Close"]
        : ["View all configured providers…", "Close"],
    );
    try {
      await state.run();
      assert.equal(rotated, true);
      assert.equal(anthropicRequests, 2);
      assert.match(state.titles.at(-1) ?? "", /Remaining:\s+\$50\.00/);
      assert.doesNotMatch(state.titles.at(-1) ?? "", /\$20\.00/);
      assert.equal(state.context.statuses.get("usage"), "openrouter $75.00 left");
    } finally {
      await state.close();
    }
  });
}

type SettingsHarness = { handleInput(data: string): unknown; dispose(): void };
async function settingsCommand(
  state: Awaited<ReturnType<typeof setup>>,
  change: (harness: SettingsHarness) => Promise<void>,
) {
  let opened = false;
  Object.assign(state.context.ctx.ui, {
    custom: async (factory: unknown) => {
      const harness = createTuiHarness({ width: 120, rows: 40, keybindings: getKeybindings() });
      let kitScreen = false;
      const running = harness.custom(async (...args) => {
        const component = await (factory as Parameters<typeof harness.custom>[0])(...args);
        kitScreen = "__piTuiKitScreen" in component && component.__piTuiKitScreen === true;
        return component;
      });
      try {
        await harness.waitForOpen();
        const text = harness.render().join("\n");
        if (kitScreen) {
          state.titles.push(text);
          if (!opened) {
            opened = true;
            harness.send("\u001b[B");
            harness.send("\r");
          } else harness.send("\u0003");
        } else if (text.includes("pi-usage Settings")) {
          for (let row = 0; row < 4; row++) harness.send("\u001b[B");
          await change({ handleInput: harness.send, dispose: harness.dispose });
          harness.send("\u0003");
        }
        return await running;
      } finally {
        harness.dispose();
      }
    },
  });
  await state.run();
}

test("cancelling the post-settings refresh cannot restore configured Claude money after opt-out", async () => {
  const state = await setup(true, "tui", true);
  Object.assign(state.context.ctx, {
    model: { ...model, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  });
  const release = deferred<void>();
  let blockCurrent = false;
  const originalAuth = state.registry.getProviderAuth.getMockImplementation();
  assert.ok(originalAuth);
  state.registry.getProviderAuth.mockImplementation(async (provider) => {
    if (provider !== "openrouter") return originalAuth(provider);
    if (blockCurrent) await release.promise;
    return { source: "API key", auth: { apiKey: "synthetic-router-key" } };
  });
  state.registry.getApiKeyAndHeaders.mockImplementation(async () => ({ ok: true, apiKey: "synthetic-router-key" }));
  state.fetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url.includes("openrouter.ai")
            ? { data: { limit: 100, limit_remaining: 75, usage: 25 } }
            : { extra_usage: extra },
        ),
      ),
  );
  const update = state.settings.update.bind(state.settings);
  vi.spyOn(state.settings, "update").mockImplementation(async (patch, signal) => {
    const saved = await update(patch, signal);
    if (patch.anthropicExtraUsage === false) blockCurrent = true;
    return saved;
  });
  const frames: string[] = [];
  let stage = 0;
  let cancelled = false;
  Object.assign(state.context.ctx.ui, {
    custom: async (factory: unknown) => {
      const harness = createTuiHarness({ width: 120, rows: 40, keybindings: getKeybindings() });
      let screen = false;
      const running = harness.custom(async (...args) => {
        const component = await (factory as Parameters<typeof harness.custom>[0])(...args);
        screen = "__piTuiKitScreen" in component && component.__piTuiKitScreen === true;
        return component;
      });
      try {
        await harness.waitForOpen();
        const text = harness.render().join("\n");
        if (screen) {
          frames.push(text);
          if (stage === 0) {
            stage++;
            harness.send("\u001b[B");
            harness.send("\u001b[B");
            harness.send("\r");
          } else if (stage === 1) {
            stage++;
            harness.send("\r");
          } else if (stage === 2) {
            stage++;
            harness.send("\u001b[A");
            harness.send("\r");
          } else harness.send("\u0003");
        } else if (text.includes("pi-usage Settings")) {
          for (let row = 0; row < 4; row++) harness.send("\u001b[B");
          harness.send("\r");
          await vi.waitFor(() => assert.equal(state.settings.get().settings.anthropicExtraUsage, false));
          harness.send("\u0003");
        } else if (text.includes("Applying usage settings")) {
          cancelled = true;
          harness.send("\u0003");
          release.resolve();
        }
        return await running;
      } finally {
        harness.dispose();
      }
    },
  });
  try {
    await state.run();
    assert.equal(cancelled, true, JSON.stringify({ stage, frames, notifications: state.context.notifications }));
    assert.ok(frames.some((frame) => /Claude Extra Usage[\s\S]*\$20\.00/.test(frame)));
    assert.match(frames.at(-1) ?? "", /Usage settings changed/);
    assert.doesNotMatch(frames.at(-1) ?? "", /Claude Extra Usage|\$20\.00/);
  } finally {
    release.resolve();
    await state.close();
  }
});

test("Claude Settings Off → On → Off applies immediately without reload or more HTTP after disable", async () => {
  const state = await setup(false, "tui");
  try {
    await state.emit("session_start");
    await settingsCommand(state, async (harness) => {
      harness.handleInput("\r");
      await vi.waitFor(() => assert.equal(state.settings.get().settings.anthropicExtraUsage, true));
    });
    assert.equal(state.context.statuses.get("usage"), "anthropic $20.00 left");
    const requests = state.fetch.mock.calls.length;
    let cleared = false;
    await settingsCommand(state, async (harness) => {
      harness.handleInput("\r");
      await vi.waitFor(() => assert.equal(state.settings.get().settings.anthropicExtraUsage, false));
      cleared = state.context.statuses.get("usage") === undefined;
    });
    assert.equal(cleared, true);
    assert.equal(state.context.statuses.get("usage"), undefined);
    assert.equal(state.fetch.mock.calls.length, requests);
    assert.equal((await state.query()).status, "unavailable");
  } finally {
    await state.close();
  }
});

for (const boundary of ["normal", "cancel after save", "dispose after save"] as const) {
  test(`durable Claude disable cancels pending HTTP with ${boundary} and rejects its late response`, async () => {
    const state = await setup(true, "tui");
    await state.emit("session_start");
    const entered = deferred<AbortSignal>();
    const response = deferred<Response>();
    const update = state.settings.update.bind(state.settings);
    let active: SettingsHarness | undefined;
    let signal: AbortSignal | undefined;
    let delayed = false;
    vi.spyOn(state.settings, "update").mockImplementation(async (patch, owner) => {
      if (patch.anthropicExtraUsage === false && !delayed) {
        delayed = true;
        state.rotate();
        state.fetch.mockImplementation(async (_url, init) => {
          assert.ok(init.signal);
          entered.resolve(init.signal);
          return response.promise;
        });
        await state.emit("turn_start");
        signal = await entered.promise;
      }
      const saved = await update(patch, owner);
      if (patch.anthropicExtraUsage === false && boundary !== "normal") {
        if (boundary === "cancel after save") active?.handleInput("\u0003");
        else active?.dispose();
      }
      return saved;
    });
    try {
      await settingsCommand(state, async (harness) => {
        active = harness;
        harness.handleInput("\r");
        await vi.waitFor(() => assert.equal(state.settings.get().settings.anthropicExtraUsage, false));
      });
      assert.equal(signal?.aborted, true);
      response.resolve(new Response(JSON.stringify({ extra_usage: extra })));
      await Promise.resolve();
      assert.equal(state.context.statuses.get("usage"), undefined);
      assert.equal((await state.query()).status, "unavailable");
    } finally {
      response.resolve(new Response("{}"));
      await state.close();
    }
  });
}
