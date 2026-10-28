import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { showSubagentsMenu } from "../src/menu.js";
import type { RegisteredSubagentTools } from "../src/tools.js";
import type { ChildRequest, ChildResult } from "../src/types.js";

type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;
let directory: string;
const cleanup: (() => void | Promise<void>)[] = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-cleanup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
});

afterEach(async () => {
  try {
    for (const release of cleanup.splice(0).reverse()) await release();
    assert.equal(vi.getTimerCount(), 0, "session cleanup must not leave a refresh timer");
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test.each(["shutdown", "replacement", "same-manager replacement"] as const)(
  "%s joins children, menus, and storage after UI clear failure and reports all causes",
  async (operation) => {
    const f = await fixture();
    const menuEntered = deferred();
    const menuDrain = deferred();
    const storageEntered = deferred();
    const storageDrain = deferred();
    const failures = [
      new Error("UI clear failed"),
      new Error("domain shutdown failed"),
      new Error("menu failed"),
      new Error("storage flush failed"),
    ];
    let menuOwner!: Parameters<typeof showSubagentsMenu>[1];
    vi.spyOn(f.menuApi, "showSubagentsMenu").mockImplementationOnce(async (_ctx, options) => {
      menuOwner = options;
      menuEntered.resolve();
      await menuDrain.promise;
      throw failures[2];
    });
    const command = invoke(f.mock, f.context);
    await menuEntered.promise;
    const shutdown = f.tools.shutdown;
    vi.spyOn(f.tools, "shutdown").mockImplementationOnce(async () => {
      await shutdown();
      throw failures[1];
    });
    const start = vi.spyOn(f.tools, "startSession");
    const flush = f.store.flush.bind(f.store);
    vi.spyOn(f.store, "flush").mockImplementationOnce(async () => {
      storageEntered.resolve();
      await storageDrain.promise;
      await flush();
      throw failures[3];
    });
    const load = vi.spyOn(f.store, "load");
    const ctx = f.context.ctx as ExtensionContext;
    const writes = vi.spyOn(ctx.ui, "setWidget").mockImplementationOnce(() => {
      throw failures[0];
    });
    const replacement = createMockContext({
      mode: "tui",
      ...(operation === "same-manager replacement" ? { sessionManager: ctx.sessionManager } : {}),
    });
    cleanup.push(() => emit(f.mock, "session_shutdown", replacement.ctx));
    let settled = false;
    const lifecycle = emit(
      f.mock,
      operation === "shutdown" ? "session_shutdown" : "session_start",
      operation === "shutdown" ? f.context.ctx : replacement.ctx,
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      assert.equal(menuOwner.signal.aborted, true);
      assert.equal(vi.getTimerCount(), 0);
      const descriptor = Object.getOwnPropertyDescriptor(ctx, "sessionManager");
      Object.defineProperty(ctx, "sessionManager", {
        configurable: true,
        get() {
          throw new Error("stale sessionManager getter");
        },
      });
      try {
        assert.equal(menuOwner.isCurrent(), false, "generation must be checked before the old context getter");
        await Promise.all([f.childAborted.promise, storageEntered.promise]);
        assert.equal(settled, false);
        menuDrain.resolve();
        await command;
        assert.equal(settled, false, "child teardown and flush are still pending");
        f.childDrain.resolve();
        await f.childFinished.promise;
        assert.equal(settled, false, "storage must drain even after other cleanup failures");
        storageDrain.resolve();
        const error = await lifecycle;
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, failures);
      } finally {
        Object.defineProperty(ctx, "sessionManager", descriptor as PropertyDescriptor);
      }
      assert.equal(start.mock.calls.length, 0, "a failed UI handoff must not start another runtime");
      assert.equal(load.mock.calls.length, 0, "a failed UI handoff must not load a new widget");
      assert.equal(writes.mock.calls.length, 1);
      assert.equal(replacement.widgets.size, 0);
      assert.equal(f.context.notifications.length, 0, "stale menu errors must not use the old UI");
      assert.deepEqual(f.mock.sentMessages, [], "old jobs must not deliver stale completion");
      assert.equal(vi.getTimerCount(), 0);
      // Failed cleanup releases ownership. A later explicit start can acquire it.
      await emit(f.mock, "session_start", f.context.ctx);
      assert.equal(vi.getTimerCount(), 1);
    } finally {
      menuDrain.resolve();
      storageDrain.resolve();
      f.childDrain.resolve();
      await Promise.allSettled([command, lifecycle]);
    }
  },
);

test("a synchronous flush failure does not skip pending domain cleanup", async () => {
  const f = await fixture();
  const failure = new Error("synchronous flush failure");
  vi.spyOn(f.store, "flush").mockImplementationOnce(() => {
    throw failure;
  });
  let settled = false;
  const result = emit(f.mock, "session_shutdown", f.context.ctx).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await f.childAborted.promise;
    assert.equal(settled, false);
    assert.equal(vi.getTimerCount(), 0);
    f.childDrain.resolve();
    assert.equal(await result, failure);
  } finally {
    f.childDrain.resolve();
    await result;
  }
});

test("a failed tree display reset invalidates old menu ownership without cancelling jobs", async () => {
  const f = await fixture();
  const entered = deferred();
  let menuOwner!: Parameters<typeof showSubagentsMenu>[1];
  vi.spyOn(f.menuApi, "showSubagentsMenu").mockImplementationOnce(async (_ctx, options) => {
    menuOwner = options;
    entered.resolve();
    await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const command = invoke(f.mock, f.context);
  await entered.promise;
  const ctx = f.context.ctx as ExtensionContext;
  const failure = new Error("tree clear failed");
  vi.spyOn(ctx.ui, "setWidget").mockImplementationOnce(() => {
    throw failure;
  });
  const shutdown = vi.spyOn(f.tools, "shutdown");
  const start = vi.spyOn(f.tools, "startSession");
  await assert.rejects(
    () => emit(f.mock, "session_tree", ctx),
    (error) => error === failure,
  );
  await command;
  assert.equal(menuOwner.signal.aborted, true);
  assert.equal(menuOwner.isCurrent(), false);
  assert.equal(f.requests[0]?.signal.aborted, false, "display reset must not cancel domain jobs");
  assert.equal(shutdown.mock.calls.length, 0);
  assert.equal(start.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
  await invoke(f.mock, f.context);
  assert.match(f.context.notifications.at(-1)?.message ?? "", /unavailable/u);
});

async function fixture() {
  const toolsApi = await import("../src/tools.js");
  const menuApi = await import("../src/menu.js");
  const { SubagentSettingsStore } = await import("../src/settings.js");
  let tools!: RegisteredSubagentTools;
  const register = toolsApi.registerSubagentTools;
  vi.spyOn(toolsApi, "registerSubagentTools").mockImplementation((...args) => {
    tools = register(...args);
    return tools;
  });
  const extension = (await import("../src/subagents.js")).default;
  const mock = createMockPi();
  const context = createMockContext({ mode: "tui", model: { provider: "test", id: "model" } });
  const store = new SubagentSettingsStore(join(directory, "pi-subagents.json"));
  const childAborted = deferred();
  const childDrain = deferred();
  const childFinished = deferred();
  const requests: ChildRequest[] = [];
  extension(mock.pi, {
    settingsStore: store,
    runChild: async (request): Promise<ChildResult> => {
      requests.push(request);
      request.signal.addEventListener("abort", childAborted.resolve, { once: true });
      await childDrain.promise;
      childFinished.resolve();
      return { state: "cancelled", limitations: [], truncated: false };
    },
  });
  cleanup.push(async () => {
    const shutdown = emit(mock, "session_shutdown", context.ctx);
    childDrain.resolve();
    await shutdown;
  });
  await emit(mock, "session_start", context.ctx);
  const ctx = context.ctx as ExtensionContext;
  ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "environment" });
  ctx.modelRegistry.getRegisteredProviderIds = () => [];
  const spawn = mock.tools.find((candidate) => candidate.name === "subagent_spawn");
  assert.ok(spawn);
  assert.ok(typeof spawn.execute === "function");
  await spawn.execute("spawn", { task: "Wait for cleanup", tools: ["read"] }, undefined, undefined, context.ctx);
  return { mock, context, store, tools, menuApi, requests, childAborted, childDrain, childFinished };
}

async function emit(mock: Mock, name: string, ctx: unknown) {
  for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
}

async function invoke(mock: Mock, context: Context) {
  await mock.commands.get("subagents")?.handler("", context.ctx);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
