import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import jevExtension from "../src/jev.js";
import { loadSettings } from "../src/settings.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function settingsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-typesafe-settings-"));
  temporaryDirectories.push(directory);
  const agentDirectory = join(directory, "agent");
  return {
    agentDirectory,
    path: join(agentDirectory, "pi-typesafe.json"),
  };
}

test("uses disabled defaults without creating a missing settings path", async () => {
  const fixture = await settingsFixture();
  assert.deepEqual(await loadSettings(fixture.path), {
    settings: { openRouterFallback: false },
  });
  await assert.rejects(stat(fixture.agentDirectory), { code: "ENOENT" });
});

test("loads only an own OpenRouter fallback setting and ignores unknown fields", async () => {
  const fixture = await settingsFixture();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(fixture.path, '{"openRouterFallback":true,"futureOption":"preserved"}\n');

  assert.deepEqual(await loadSettings(fixture.path), {
    settings: { openRouterFallback: true },
  });

  await writeFile(fixture.path, '{"futureOption":"preserved"}\n');
  Object.defineProperty(Object.prototype, "openRouterFallback", {
    configurable: true,
    value: true,
  });
  try {
    assert.deepEqual(await loadSettings(fixture.path), {
      settings: { openRouterFallback: false },
    });
  } finally {
    delete (Object.prototype as Record<string, unknown>).openRouterFallback;
  }
});

test("reports the path and underlying settings read error", async () => {
  const fixture = await settingsFixture();
  await mkdir(fixture.path, { recursive: true });

  const loaded = await loadSettings(fixture.path);
  assert.deepEqual(loaded.settings, { openRouterFallback: false });
  assert.ok(loaded.warning?.includes(fixture.path));
  assert.match(loaded.warning ?? "", /EISDIR|directory/iu);
});

test("rejects malformed and invalid settings without changing the file", async () => {
  const fixture = await settingsFixture();
  await mkdir(fixture.agentDirectory, { recursive: true });

  for (const document of ["{ invalid\n", "[]\n", '{"openRouterFallback":"yes"}\n']) {
    await writeFile(fixture.path, document);
    const loaded = await loadSettings(fixture.path);
    assert.deepEqual(loaded.settings, { openRouterFallback: false });
    assert.match(loaded.warning ?? "", /using defaults without changing pi-typesafe\.json/);
    assert.equal(await readFile(fixture.path, "utf8"), document);
  }
});

test("reloads the settings on session start and warns about invalid settings", async () => {
  const fixture = await settingsFixture();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(fixture.path, '{"openRouterFallback":true}\n');

  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: "typesafe/jev-1.13",
      answers: { answer: { type: "noul", noul: 0.75 } },
    }),
  );
  const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "sk-or-secret" } }));
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    modelRegistry: {
      getProviderAuth,
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  });
  const mock = createMockPi();
  jevExtension(mock.pi, { env: {}, fetch: fetchImpl, settingsPath: fixture.path });
  const tool = mock.tools.find((candidate) => candidate.name === "typesafe_question") as {
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: typeof context.ctx,
    ): Promise<unknown>;
  };
  const input = {
    state: "x",
    questions: { answer: { type: "noul", instructions: "Is this true?" } },
  };

  await assert.rejects(
    () => tool.execute("before-start", input, new AbortController().signal, undefined, context.ctx),
    /openRouterFallback/,
  );
  assert.equal(getProviderAuth.mock.calls.length, 0);

  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await tool.execute("enabled", input, new AbortController().signal, undefined, context.ctx);
  assert.equal(fetchImpl.mock.calls.length, 1);

  await writeFile(fixture.path, '{"openRouterFallback":false}\n');
  await mock.events.get("session_start")?.[0]?.({ reason: "reload" }, context.ctx);
  await assert.rejects(
    () => tool.execute("disabled", input, new AbortController().signal, undefined, context.ctx),
    /openRouterFallback/,
  );
  assert.equal(getProviderAuth.mock.calls.length, 1);
  assert.equal(fetchImpl.mock.calls.length, 1);

  await writeFile(fixture.path, "{ invalid\n");
  await mock.events.get("session_start")?.[0]?.({ reason: "reload" }, context.ctx);
  assert.match(context.notifications.at(-1)?.message ?? "", /using defaults/);
  assert.equal(context.notifications.at(-1)?.level, "warning");

  const unsafeDirectory = join(fixture.agentDirectory, "\u001b]0;owned\u0007agent");
  const unsafePath = join(unsafeDirectory, "pi-typesafe.json");
  await mkdir(unsafeDirectory, { recursive: true });
  await writeFile(unsafePath, "{ invalid\n");
  const unsafeContext = createMockContext({ hasUI: true, mode: "tui" });
  const unsafeMock = createMockPi();
  jevExtension(unsafeMock.pi, { settingsPath: unsafePath });
  await unsafeMock.events.get("session_start")?.[0]?.({ reason: "startup" }, unsafeContext.ctx);
  const warning = unsafeContext.notifications.at(-1)?.message ?? "";
  assert.equal(warning.includes("\u001b"), false);
  assert.equal(warning.includes("\u0007"), false);
  assert.equal(warning.includes("owned"), false);
});

test("an unrelated session shutdown does not cancel the active settings load", async () => {
  let resolveFirst!: (value: { settings: { openRouterFallback: boolean } }) => void;
  let resolveSecond!: (value: { settings: { openRouterFallback: boolean } }) => void;
  const firstLoad = new Promise<{ settings: { openRouterFallback: boolean } }>((resolve) => {
    resolveFirst = resolve;
  });
  const secondLoad = new Promise<{ settings: { openRouterFallback: boolean } }>((resolve) => {
    resolveSecond = resolve;
  });
  let reads = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: "typesafe/jev-1.13",
      answers: { answer: { type: "noul", noul: 0.75 } },
    }),
  );
  const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "sk-or-secret" } }));
  const previous = createMockContext();
  const active = createMockContext({
    modelRegistry: {
      getProviderAuth,
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  });
  const mock = createMockPi();
  jevExtension(mock.pi, {
    env: {},
    fetch: fetchImpl,
    loadSettings: async () => {
      reads += 1;
      return reads === 1 ? firstLoad : secondLoad;
    },
  });
  const start = mock.events.get("session_start")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  const tool = mock.tools.find((candidate) => candidate.name === "typesafe_question") as {
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: typeof active.ctx,
    ): Promise<unknown>;
  };
  assert.ok(start);
  assert.ok(shutdown);

  const previousStart = Promise.resolve(start({ reason: "startup" }, previous.ctx));
  await Promise.resolve();
  const activeStart = Promise.resolve(start({ reason: "startup" }, active.ctx));
  await Promise.resolve();
  await shutdown({ reason: "quit" }, previous.ctx);
  resolveSecond({ settings: { openRouterFallback: true } });
  await activeStart;
  resolveFirst({ settings: { openRouterFallback: false } });
  await previousStart;

  await tool.execute(
    "active-session",
    {
      state: "x",
      questions: { answer: { type: "noul", instructions: "Is this true?" } },
    },
    new AbortController().signal,
    undefined,
    active.ctx,
  );
  assert.equal(getProviderAuth.mock.calls.length, 1);
  assert.equal(fetchImpl.mock.calls.length, 1);
});

test("routes sanitized settings warnings through each supported mode", async () => {
  const createWarningLifecycle = () => {
    const mock = createMockPi();
    jevExtension(mock.pi, {
      loadSettings: async () => ({
        settings: { openRouterFallback: false },
        warning: "unsafe\u001b]0;owned\u0007 settings warning",
      }),
    });
    const start = mock.events.get("session_start")?.[0];
    assert.ok(start);
    return start;
  };

  for (const mode of ["tui", "rpc"] as const) {
    const context = createMockContext({ hasUI: true, mode });
    await createWarningLifecycle()({ reason: "startup" }, context.ctx);
    const warning = context.notifications.at(-1)?.message ?? "";
    assert.match(warning, /unsafe settings warning/u);
    assert.equal(warning.includes("\u001b"), false);
    assert.equal(warning.includes("\u0007"), false);
    assert.equal(warning.includes("owned"), false);
  }

  for (const mode of ["print", "json"] as const) {
    const context = createMockContext({ hasUI: false, mode });
    await assert.rejects(
      () => Promise.resolve(createWarningLifecycle()({ reason: "startup" }, context.ctx)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /unsafe settings warning/u);
        assert.equal(error.message.includes("\u001b"), false);
        assert.equal(error.message.includes("\u0007"), false);
        assert.equal(error.message.includes("owned"), false);
        return true;
      },
    );
    assert.deepEqual(context.notifications, []);
  }
});

test("does not throw a settings warning when the context omits its mode", async () => {
  const mock = createMockPi();
  jevExtension(mock.pi, {
    loadSettings: async () => ({
      settings: { openRouterFallback: false },
      warning: "settings warning",
    }),
  });
  const context = createMockContext();
  const start = mock.events.get("session_start")?.[0];
  assert.ok(start);

  await start({ reason: "startup" }, context.ctx);
  assert.deepEqual(context.notifications, []);
});
