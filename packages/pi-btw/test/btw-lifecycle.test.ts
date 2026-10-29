import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { BtwExtensionDependencies } from "../src/btw.js";
import type { BtwFullscreenOptions } from "../src/fullscreen-ui.js";

const markdown = vi.hoisted(() => ({ prepareBtwTranscriptMarkdown: vi.fn() }));
vi.mock("../src/transcript-markdown.js", () => markdown);

let extension: typeof import("../src/btw.js");
let settings: typeof import("../src/settings.js");

beforeEach(async () => {
  // vitest.setup.ts establishes isolated PI_CODING_AGENT_DIR before these fresh imports.
  vi.resetModules();
  markdown.prepareBtwTranscriptMarkdown.mockReset().mockResolvedValue(() => []);
  extension = await import("../src/btw.js");
  settings = await import("../src/settings.js");
});

test("confirmed imports before a first question remain resumable and replacement discards them", async () => {
  const { buildMainContextSnapshot } = await import("../src/main-context-snapshot.js");
  const { appendMainContextUpdate } = await import("../src/side-thread.js");
  const manager = SessionManager.inMemory();
  const menus: Array<readonly { id: string; title: string; questionCount: number }[]> = [];
  let runs = 0;
  const app = harness({
    showCommandMenu: async (_pi, _ctx, threads) => {
      menus.push(threads);
      if (menus.length === 1) return "start";
      return threads[0] ? { kind: "resume", threadId: threads[0].id } : "closed";
    },
    runThread: async ({ state }) => {
      assert.ok(state);
      if (++runs === 1) {
        manager.appendMessage({ role: "user", content: "new main context", timestamp: 1 });
        const snapshot = buildMainContextSnapshot(manager, state.thread.source);
        assert.equal(snapshot.kind, "ready");
        if (snapshot.kind === "ready") assert.equal(appendMainContextUpdate(state.thread, snapshot), true);
      } else {
        assert.equal(state.thread.updates.length, 1);
        assert.equal(state.thread.turns.length, 0);
      }
      return { kind: "closed" };
    },
  });
  Object.defineProperty(app.ctx, "sessionManager", { value: manager });
  await app.emit("session_start");
  await app.command("");
  await app.command("");
  assert.equal(menus[1]?.[0]?.title, "Main context updates");
  assert.equal(menus[1]?.[0]?.questionCount, 0);
  await app.emit("session_shutdown", "reload");
  await app.emit("session_start");
  await app.command("");
  assert.deepEqual(menus[2], []);
  assert.equal(runs, 2);
});

for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
  test(`shutdown(${reason}) cancels a pending import without cursor publication`, async () => {
    const { importMainUpdates } = await import("../src/import-main-updates.js");
    const manager = SessionManager.inMemory();
    const entered = deferred();
    let retainedThread: import("../src/side-thread.js").SideThread | undefined;
    const app = harness({
      runThread: async ({ state, ctx }) => {
        assert.ok(state);
        retainedThread = state.thread;
        manager.appendMessage({ role: "user", content: "pending update", timestamp: 1 });
        await importMainUpdates(state.thread, ctx, async () => {
          entered.resolve();
          const signal = ctx.signal;
          assert.ok(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return "confirm";
        });
        return { kind: "closed" };
      },
    });
    Object.defineProperty(app.ctx, "sessionManager", { value: manager });
    await app.emit("session_start");
    const running = app.command("");
    await entered.promise;
    await app.emit("session_shutdown", reason);
    await running;
    assert.equal(retainedThread?.updates.length, 0);
    assert.equal(retainedThread?.source?.entryId, null);
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const selected = { model: { provider: "test", id: "side", reasoning: true } as Model<Api> };

function harness(dependencies: BtwExtensionDependencies = {}) {
  const mock = createMockPi();
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    signal: undefined,
    modelRegistry: {
      streamSimple: vi.fn(),
      getAvailable: () => [selected.model],
      getAll: () => [selected.model],
    },
  });
  const ctx = context.ctx as ExtensionCommandContext;
  extension.default(mock.pi, {
    showCommandMenu: async () => "start",
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected }),
    runFullscreen: async (ctx, run) => run(ctx),
    ...dependencies,
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  return {
    ...context,
    ctx,
    command: (question = "question", commandCtx = ctx) => Promise.resolve(command.handler(question, commandCtx)),
    async emit(name: "session_start" | "session_shutdown", reason = "new", eventCtx = ctx) {
      for (const handler of mock.events.get(name) ?? []) {
        await handler({ type: name, reason }, eventCtx);
      }
    },
  };
}

for (const layout of ["left-pane", "right-pane"] as const) {
  for (const question of ["", "question"]) {
    test(`${layout} ${question ? "direct" : "manager"} releases its command only after split readiness`, async () => {
      const entered = deferred();
      const finish = deferred();
      let options: BtwFullscreenOptions | undefined;
      let settled = false;
      const app = harness({
        loadSettings: async () => ({ layout }),
        runFullscreen: async (ctx, run, value) => {
          options = value;
          entered.resolve();
          return run(ctx);
        },
        runThread: async () => {
          await finish.promise;
          return { kind: "closed" };
        },
      });
      await app.emit("session_start");
      const command = app.command(question).then(() => {
        settled = true;
      });
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const beforeReady = settled;
      options?.onSplitReady?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const afterReady = settled;
      finish.resolve();
      await command;
      await app.emit("session_shutdown", "quit");
      assert.equal(beforeReady, false);
      assert.equal(afterReady, true, "the mounted split still blocks Pi's idle input consumer");
    });
  }
}

for (const stage of ["manager", "settings", "model", "workspace", "cleanup"] as const) {
  test(`overlapping commands cannot enter another flow during ${stage}`, async () => {
    const entered = deferred();
    const release = deferred();
    const calls: string[] = [];
    let paused = false;
    const visit = async (name: typeof stage) => {
      calls.push(name);
      if (name !== stage || paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    };
    const app = harness({
      showCommandMenu: async () => {
        await visit("manager");
        return "start";
      },
      loadSettings: async () => {
        await visit("settings");
        return { layout: "right-pane" };
      },
      resolveModel: async () => {
        await visit("model");
        return { kind: "selected", selected };
      },
      runFullscreen: async (ctx, run, options) => {
        options?.onSplitReady?.();
        await visit("workspace");
        try {
          return await run(ctx);
        } finally {
          await visit("cleanup");
        }
      },
      runThread: async () => ({ kind: "closed" }),
    });
    await app.emit("session_start");
    const first = app.command("");
    await entered.promise;
    const beforeOverlap = [...calls];
    await app.command("overlap");
    const afterOverlap = [...calls];
    release.resolve();
    await first;
    await app.emit("session_shutdown", "quit");
    assert.deepEqual(afterOverlap, beforeOverlap);
    assert.equal(app.notifications.length, 1);
    assert.match(app.notifications[0]?.message ?? "", /already open/u);
  });
}

for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
  test(`released split remains owned until session_shutdown(${reason}) drains cleanup`, async () => {
    const entered = deferred();
    const finish = deferred();
    let options: BtwFullscreenOptions | undefined;
    let settled = false;
    let restored = false;
    const app = harness({
      loadSettings: async () => ({ layout: "left-pane" }),
      runFullscreen: async (ctx, run, value) => {
        options = value;
        value?.onSplitReady?.();
        entered.resolve();
        try {
          return await run(ctx);
        } finally {
          restored = value?.canRestoreParent?.() ?? false;
        }
      },
      runThread: async () => {
        await finish.promise;
        return { kind: "closed" };
      },
    });
    await app.emit("session_start");
    const command = app.command().then(() => {
      settled = true;
    });
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const released = settled;
    let drained = false;
    const shutdown = app.emit("session_shutdown", reason).then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const drainedBeforeCleanup = drained;
    finish.resolve();
    await Promise.all([command, shutdown]);
    assert.equal(released, true);
    assert.equal(drainedBeforeCleanup, false);
    assert.equal(restored, reason !== "quit");
    assert.equal(options?.canRestoreParent?.(), false);
  });
}

test("fullscreen-only commands stay modal and do not expose split readiness", async () => {
  const entered = deferred();
  const finish = deferred();
  let options: BtwFullscreenOptions | undefined;
  let settled = false;
  const app = harness({
    runFullscreen: async (ctx, run, value) => {
      options = value;
      entered.resolve();
      return run(ctx);
    },
    runThread: async () => {
      await finish.promise;
      return { kind: "closed" };
    },
  });
  const command = app.command().then(() => {
    settled = true;
  });
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const modal = !settled;
  finish.resolve();
  await command;
  await app.emit("session_shutdown", "quit");
  assert.equal(modal, true);
  assert.equal(options?.onSplitReady, undefined);
});

test("post-release errors are observed and sanitized, and release the command guard", async () => {
  const entered = deferred();
  const fail = deferred();
  let calls = 0;
  let settled = false;
  const app = harness({
    loadSettings: async () => ({ layout: "right-pane" }),
    runThread: async () => ({ kind: "closed" }),
    runFullscreen: async (ctx, run, options) => {
      if (++calls > 1) return run(ctx);
      options?.onSplitReady?.();
      entered.resolve();
      await fail.promise;
      throw new Error("late\u001b[31m failure\nunsafe");
    },
  });
  const command = app.command().then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => error,
  );
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const released = settled;
  fail.resolve();
  const error = await command;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await app.command("retry");
  await app.emit("session_shutdown", "quit");
  assert.equal(released, true);
  assert.equal(error, undefined);
  assert.equal(calls, 2);
  assert.equal(app.notifications.length, 1);
  assert.equal(app.notifications[0]?.level, "error");
  // Removing control bytes leaves printable escape-sequence text inert.
  assert.equal(app.notifications[0]?.message, "Pi BTW: late[31m failure unsafe");
});

test("notification failures cannot reject released work or retain its command guard", async () => {
  const entered = deferred();
  const fail = deferred();
  let calls = 0;
  let notifications = 0;
  const app = harness({
    loadSettings: async () => ({ layout: "right-pane" }),
    runThread: async () => ({ kind: "closed" }),
    runFullscreen: async (ctx, run, options) => {
      if (++calls > 1) return run(ctx);
      options?.onSplitReady?.();
      entered.resolve();
      await fail.promise;
      throw new Error("late failure");
    },
  });
  app.ctx.ui.notify = () => {
    notifications += 1;
    throw new Error("UI is unavailable");
  };
  const command = app.command();
  await entered.promise;
  await app.command("overlap");
  fail.resolve();
  await command;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await app.command("retry");
  await app.emit("session_shutdown", "quit");
  assert.equal(notifications, 2);
  assert.equal(calls, 2);
});

test("released commands and their guards remain separate across a reused session manager", async () => {
  const entered = [deferred(), deferred()];
  const finish = [deferred(), deferred()];
  const options: BtwFullscreenOptions[] = [];
  let calls = 0;
  const app = harness({
    loadSettings: async () => ({ layout: "left-pane" }),
    runThread: async () => ({ kind: "closed" }),
    runFullscreen: async (ctx, run, value) => {
      const index = calls++;
      assert.ok(value);
      options.push(value);
      value.onSplitReady?.();
      entered[index]?.resolve();
      await finish[index]?.promise;
      return run(ctx);
    },
  });
  await app.emit("session_start");
  const oldCommand = app.command("old");
  await entered[0]?.promise;
  await oldCommand;
  const replacement = app.emit("session_start");
  assert.equal(options[0]?.signal?.aborted, true);
  const newCommand = app.command("new");
  await entered[1]?.promise;
  await newCommand;
  options[0]?.onSplitReady?.();
  finish[0]?.resolve();
  await replacement;
  await app.command("overlap");
  const liveGuard = calls === 2;
  finish[1]?.resolve();
  await app.emit("session_shutdown", "quit");
  assert.equal(liveGuard, true);
  assert.equal(options[1]?.signal?.aborted, true);
  assert.equal(app.notifications.length, 1);
  assert.match(app.notifications[0]?.message ?? "", /already open/u);
});

for (const stage of ["settings", "model", "workspace"] as const) {
  test(`a pre-release ${stage} error propagates and releases the command guard`, async () => {
    const failure = new Error(`${stage} failed`);
    let first = true;
    const failOnce = (name: typeof stage) => {
      if (name !== stage || !first) return;
      first = false;
      throw failure;
    };
    const app = harness({
      loadSettings: async () => {
        failOnce("settings");
        return { layout: "right-pane" };
      },
      resolveModel: async () => {
        failOnce("model");
        return { kind: "selected", selected };
      },
      runFullscreen: async (ctx, run) => {
        failOnce("workspace");
        return run(ctx);
      },
      runThread: async () => ({ kind: "closed" }),
    });
    await assert.rejects(app.command(), (error) => error === failure);
    await app.command("retry");
    await app.emit("session_shutdown", "quit");
    assert.deepEqual(app.notifications, []);
  });
}

for (const reason of ["reload", "quit"]) {
  test(`a released task's late error cannot notify after ${reason}`, async () => {
    const entered = deferred();
    const fail = deferred();
    let settled = false;
    const app = harness({
      loadSettings: async () => ({ layout: "left-pane" }),
      runFullscreen: async (_ctx, _run, options) => {
        options?.onSplitReady?.();
        entered.resolve();
        await fail.promise;
        throw new Error("stale failure");
      },
    });
    const command = app.command().then(() => {
      settled = true;
    });
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const released = settled;
    const shutdown = app.emit("session_shutdown", reason);
    fail.resolve();
    await Promise.all([command, shutdown]);
    assert.equal(released, true);
    assert.deepEqual(app.notifications, []);
  });
}

test("overlap warnings use the session lifetime instead of an aborted agent-run signal", async () => {
  const entered = deferred();
  const finish = deferred();
  const run = new AbortController();
  run.abort();
  const app = harness({
    runFullscreen: async (ctx, execute) => {
      entered.resolve();
      return execute(ctx);
    },
    runThread: async () => {
      await finish.promise;
      return { kind: "closed" };
    },
  });
  const ctx = { ...app.ctx, signal: run.signal } as ExtensionCommandContext;
  const first = app.command("question", ctx);
  await entered.promise;
  await app.command("overlap", ctx);
  finish.resolve();
  await first;
  await app.emit("session_shutdown", "quit");
  assert.equal(app.notifications.length, 1);
  assert.match(app.notifications[0]?.message ?? "", /already open/u);
});

test("late split readiness cannot release a cancelled session's command", async () => {
  const entered = deferred();
  const finish = deferred();
  let options: BtwFullscreenOptions | undefined;
  let settled = false;
  const app = harness({
    loadSettings: async () => ({ layout: "left-pane" }),
    runFullscreen: async (ctx, run, value) => {
      options = value;
      entered.resolve();
      await finish.promise;
      return run(ctx);
    },
  });
  const command = app.command().then(() => {
    settled = true;
  });
  await entered.promise;
  const shutdown = app.emit("session_shutdown", "reload");
  options?.onSplitReady?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const releasedAfterCancellation = settled;
  finish.resolve();
  await Promise.all([command, shutdown]);
  assert.equal(releasedAfterCancellation, false);
  assert.deepEqual(app.notifications, []);
});

for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
  test(`idle session_shutdown(${reason}) aborts and drains commands with correct parent restoration`, async () => {
    const entered = deferred();
    const finish = deferred();
    let options: BtwFullscreenOptions | undefined;
    let commandSignal: AbortSignal | undefined;
    let restarts = 0;
    const app = harness({
      runFullscreen: async (ctx, run, value) => {
        options = value;
        try {
          return await run(ctx);
        } finally {
          if (value?.canRestoreParent?.()) restarts += 1;
        }
      },
      runThread: async ({ ctx }) => {
        commandSignal = ctx.signal;
        entered.resolve();
        await finish.promise;
        return { kind: "closed" };
      },
    });
    await app.emit("session_start");
    assert.equal(app.ctx.signal, undefined);
    const command = app.command();
    await entered.promise;
    assert.ok(commandSignal);
    assert.equal(options?.signal, commandSignal);
    let shutdownFinished = false;
    const shutdown = app.emit("session_shutdown", reason).then(() => {
      shutdownFinished = true;
    });
    assert.equal(commandSignal.aborted, true);
    assert.equal(options?.canRestoreParent?.(), reason !== "quit");
    await Promise.resolve();
    assert.equal(shutdownFinished, false);
    finish.resolve();
    await Promise.all([command, shutdown]);
    assert.equal(restarts, reason === "quit" ? 0 : 1);
    assert.equal(options?.canRestoreParent?.(), false);
    await app.emit("session_shutdown", reason);
    await app.command();
    assert.equal(restarts, reason === "quit" ? 0 : 1);
  });
}

test("an aborted agent-run signal does not own the BTW command lifetime", async () => {
  const run = new AbortController();
  run.abort();
  let signal: AbortSignal | undefined;
  const app = harness({
    runThread: async ({ ctx }) => {
      signal = ctx.signal;
      return { kind: "closed" };
    },
  });
  const ctx = { ...app.ctx, signal: run.signal } as ExtensionCommandContext;
  await app.emit("session_start", "new", ctx);
  await app.command("question", ctx);
  assert.ok(signal);
  assert.notEqual(signal, run.signal);
  assert.equal(signal.aborted, false);
  await app.emit("session_shutdown", "quit", ctx);
  assert.equal(signal.aborted, true);
});

for (const stage of ["menu", "tree", "settings", "model"] as const) {
  test(`shutdown rejects the late ${stage} continuation before further command work`, async () => {
    const entered = deferred();
    const release = deferred();
    const calls: string[] = [];
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    const app = harness({
      showCommandMenu: async () => {
        calls.push("menu");
        if (stage === "menu") await pause();
        return stage === "tree" ? "tree" : "start";
      },
      pickMainEntry: async () => {
        calls.push("tree");
        await pause();
        return { kind: "selected", entryId: "stale-entry" };
      },
      loadSettings: async () => {
        calls.push("settings");
        if (stage === "settings") await pause();
        return {};
      },
      resolveModel: async () => {
        calls.push("model");
        if (stage === "model") await pause();
        return { kind: "selected", selected };
      },
      runFullscreen: async (ctx, run) => {
        calls.push("fullscreen");
        return run(ctx);
      },
    });
    await app.emit("session_start");
    const command = app.command("");
    await entered.promise;
    const expected = [...calls];
    let drained = false;
    const shutdown = app.emit("session_shutdown", "reload").then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    release.resolve();
    await Promise.all([command, shutdown]);
    assert.deepEqual(calls, expected);
    assert.deepEqual(app.notifications, []);
  });
}

test("session_start replaces the generation even when sessionManager is reused", async () => {
  const entered = deferred();
  const release = deferred();
  const signals: AbortSignal[] = [];
  const app = harness({
    runThread: async ({ ctx }) => {
      assert.ok(ctx.signal);
      signals.push(ctx.signal);
      if (signals.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return { kind: "closed" };
    },
  });
  await app.emit("session_start");
  const old = app.command();
  await entered.promise;
  const replacement = app.emit("session_start");
  assert.equal(signals[0]?.aborted, true);
  release.resolve();
  await Promise.all([old, replacement]);
  await app.command();
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1]?.aborted, false);
  await app.emit("session_shutdown", "quit");
});

test("shared UI identity does not couple different session managers", async () => {
  const signals: AbortSignal[] = [];
  const app = harness({
    runThread: async ({ ctx }) => {
      assert.ok(ctx.signal);
      signals.push(ctx.signal);
      return { kind: "closed" };
    },
  });
  const other = createMockContext({ mode: "tui", hasUI: true, signal: undefined, ui: app.ctx.ui }).ctx;
  await app.emit("session_start");
  await app.command();
  await app.emit("session_start", "new", other);
  await app.command("second", other);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  await app.emit("session_shutdown", "quit");
  assert.equal(signals[1]?.aborted, false);
  await app.emit("session_shutdown", "quit", other);
  assert.equal(signals[1]?.aborted, true);
});

for (const question of ["question", ""]) {
  test(`late ${question ? "answer" : "composer"} preparation cannot mount UI or start a provider`, async () => {
    const entered = deferred();
    const preparation = deferred<() => []>();
    markdown.prepareBtwTranscriptMarkdown.mockImplementation(() => {
      entered.resolve();
      return preparation.promise;
    });
    const app = harness();
    const custom = vi.spyOn(app.ctx.ui, "custom");
    const stream = vi.spyOn(app.ctx.modelRegistry, "streamSimple");
    await app.emit("session_start");
    const command = app.command(question);
    await entered.promise;
    const shutdown = app.emit("session_shutdown", "new");
    preparation.resolve(() => []);
    await Promise.all([command, shutdown]);
    assert.equal(custom.mock.calls.length, 0);
    assert.equal(stream.mock.calls.length, 0);
    assert.deepEqual(app.notifications, []);
  });
}

for (const stage of ["composer", "selection"] as const) {
  test(`late bring-to-main ${stage} cannot replace the main draft`, async () => {
    const entered = deferred();
    const release = deferred();
    let delivered = false;
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    const app = harness({
      runThread: (options) =>
        extension.runBtwThread({
          ...options,
          initialQuestion: undefined,
          dependencies: {
            interact: async () => {
              if (stage === "composer") await pause();
              return { kind: "bringToMain", questionDraft: "side draft" };
            },
            chooseBringToMain: async () => {
              await pause();
              return {
                kind: "bringToMain",
                draft: "stale draft",
                summary: { messages: 1, lines: 1, tokens: 1 },
              };
            },
            deliverBringToMain: async (...args) => {
              delivered = true;
              return extension.loadBringToMainDraft(...args);
            },
          },
        }),
    });
    app.ctx.ui.setEditorText("main draft");
    await app.emit("session_start");
    const command = app.command();
    await entered.promise;
    const shutdown = app.emit("session_shutdown", "reload");
    release.resolve();
    await Promise.all([command, shutdown]);
    assert.equal(delivered, false);
    assert.equal(app.ctx.ui.getEditorText(), "main draft");
    assert.deepEqual(app.notifications, []);
  });
}

test("shutdown drains an abandoned thread's accepted thinking write before settings reload", async () => {
  const writing = deferred();
  const publish = deferred();
  const path = join(process.env.PI_CODING_AGENT_DIR as string, "pi-btw.json");
  const app = harness({
    loadSettings: async () => ({ thinkingLevel: "low" }),
    runFullscreen: async <T>(ctx: ExtensionCommandContext, run: (ctx: ExtensionCommandContext) => Promise<T>) => {
      // Model the fullscreen abort race: the command can settle before its run continuation.
      void run(ctx).catch(() => undefined);
      await writing.promise;
      return { kind: "closed" } as T;
    },
    runThread: (options) =>
      extension.runBtwThread({
        ...options,
        initialQuestion: undefined,
        dependencies: {
          interact: async (_thread, _bottom, _ctx, _draft, thinking) => {
            thinking.onChange("high");
            return { kind: "close" };
          },
          persistThinkingLevel: (level) =>
            settings.updateBtwSettings(
              { thinkingLevel: level },
              {
                settingsPath: path,
                beforeRename: async () => {
                  writing.resolve();
                  await publish.promise;
                },
              },
            ),
        },
      }),
  });
  await app.emit("session_start");
  await app.command();
  let drained = false;
  const shutdown = app.emit("session_shutdown", "reload").then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  publish.resolve();
  await shutdown;
  assert.equal(JSON.parse(await readFile(path, "utf8")).thinkingLevel, "high");
  await app.emit("session_start");
  assert.deepEqual(await settings.readBtwSettings(path), { kind: "loaded", settings: { thinkingLevel: "high" } });
  await app.emit("session_shutdown", "quit");
});

test("session teardown suppresses only failures from an aborted command", async () => {
  const entered = deferred();
  const release = deferred();
  const failure = new Error("delayed settings failure");
  const app = harness({
    loadSettings: async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    },
  });
  await app.emit("session_start");
  const command = app.command();
  await entered.promise;
  const shutdown = app.emit("session_shutdown", "reload");
  release.resolve();
  await Promise.all([command, shutdown]);
  await app.emit("session_start");
  await assert.rejects(app.command(), (error) => error === failure);
  await app.emit("session_shutdown", "quit");
});

test("the actual command menu closes on idle session shutdown", async () => {
  const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const tui = createTuiHarness();
  const app = harness({ showCommandMenu: undefined });
  app.ctx.ui.custom = tui.custom;
  app.ctx.ui.setEditorText("main draft");
  try {
    await app.emit("session_start");
    const command = app.command("");
    await tui.waitForOpen();
    assert.match(tui.render(80).join("\n"), /Pi BTW/);
    await Promise.all([app.emit("session_shutdown", "reload"), command]);
    assert.equal(app.ctx.ui.getEditorText(), "main draft");
    assert.deepEqual(app.notifications, []);
  } finally {
    tui.dispose();
  }
});

test("the actual native main-thread tree closes on idle session shutdown", async () => {
  const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  const tui = createTuiHarness();
  const app = harness({ showCommandMenu: async () => "tree", pickMainEntry: undefined });
  app.ctx.ui.custom = tui.custom;
  app.ctx.ui.setEditorText("main draft");
  Object.assign(app.ctx.sessionManager, {
    getLeafId: () => "root",
    getTree: () => [
      {
        entry: {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "main question", timestamp: 1 },
        },
        children: [],
      },
    ],
  });
  try {
    await app.emit("session_start");
    const command = app.command("");
    await tui.waitForOpen();
    assert.match(tui.render(80).join("\n"), /main question/);
    await Promise.all([app.emit("session_shutdown", "quit"), command]);
    assert.equal(app.ctx.ui.getEditorText(), "main draft");
    assert.deepEqual(app.notifications, []);
  } finally {
    tui.dispose();
  }
});

for (const confirmReplace of [false, true]) {
  test(`shutdown cancels actual bring-to-main ${confirmReplace ? "replacement confirmation" : "draft menu"}`, async () => {
    const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme("dark", false);
    const tui = createTuiHarness();
    const app = harness({
      runThread: async ({ ctx }) => {
        await extension.loadBringToMainDraft("side draft", ctx, { messages: 1, lines: 1, tokens: 1 });
        return { kind: "closed" };
      },
    });
    app.ctx.ui.custom = tui.custom;
    app.ctx.ui.setEditorText("main draft");
    try {
      await app.emit("session_start");
      const command = app.command();
      await tui.waitForOpen();
      if (confirmReplace) {
        tui.press("tui.select.down");
        tui.press("tui.select.confirm");
        await vi.waitFor(() => assert.match(tui.render(80).join("\n"), /Replace the current/));
      }
      await Promise.all([app.emit("session_shutdown", "new"), command]);
      assert.equal(app.ctx.ui.getEditorText(), "main draft");
      assert.deepEqual(app.notifications, []);
    } finally {
      tui.dispose();
    }
  });
}
