import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { BtwExtensionDependencies } from "../src/btw.js";

let extension: typeof import("../src/btw.js");
const selected = { model: { provider: "test", id: "side", reasoning: true } as Model<Api> };

beforeEach(async () => {
  vi.resetModules();
  extension = await import("../src/btw.js");
});

afterEach(() => {
  for (const path of [
    "../src/menu.js",
    "../src/main-tree-picker.js",
    "../src/fullscreen-ui.js",
    "../src/transcript-pager.js",
    "../src/import-main-updates.js",
  ]) {
    vi.doUnmock(path);
  }
});

function deferred() {
  return Promise.withResolvers<void>();
}

function harness(dependencies: BtwExtensionDependencies = {}) {
  const mock = createMockPi();
  const context = createMockContext({ mode: "tui", signal: undefined });
  const ctx = context.ctx as ExtensionCommandContext;
  extension.default(mock.pi, {
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected }),
    runThread: async () => ({ kind: "closed" }),
    ...dependencies,
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  return {
    ...context,
    ctx,
    command: (question = "question", commandCtx = ctx) => Promise.resolve(command.handler(question, commandCtx)),
    async emit(name: "session_start" | "session_shutdown", eventCtx = ctx) {
      for (const handler of mock.events.get(name) ?? []) {
        await handler({ type: name, reason: name === "session_start" ? "new" : "reload" }, eventCtx);
      }
    },
  };
}

test("startup and non-TUI commands do not load the default menu; TUI first use loads it", async () => {
  let loads = 0;
  let shows = 0;
  vi.doMock("../src/menu.js", async () => {
    loads++;
    return {
      showBtwCommandMenu: async () => {
        shows++;
        return "closed";
      },
    };
  });
  const app = harness();
  await app.emit("session_start");
  assert.equal(loads, 0);
  await app.command("", createMockContext({ mode: "rpc" }).ctx);
  assert.equal(loads, 0);
  await app.command("");
  await app.command("");
  assert.equal(loads, 1);
  assert.equal(shows, 2);
  await app.emit("session_shutdown");
});

for (const route of ["menu", "picker", "fullscreen"] as const) {
  for (const boundary of ["session_start", "session_shutdown"] as const) {
    test(`${boundary} drains a pending ${route} import without opening stale UI`, async () => {
      const entered = deferred();
      const release = deferred();
      let shows = 0;
      const path =
        route === "menu"
          ? "../src/menu.js"
          : route === "picker"
            ? "../src/main-tree-picker.js"
            : "../src/fullscreen-ui.js";
      vi.doMock(path, async () => {
        entered.resolve();
        await release.promise;
        return route === "menu"
          ? {
              showBtwCommandMenu: async () => {
                shows++;
                return "closed";
              },
            }
          : route === "picker"
            ? {
                pickMainEntry: async () => {
                  shows++;
                  return { kind: "closed" };
                },
              }
            : {
                runBtwFullscreen: async () => {
                  shows++;
                  return { kind: "closed" };
                },
              };
      });
      const app = harness(route === "picker" ? { showCommandMenu: async () => "tree" } : {});
      await app.emit("session_start");
      const running = app.command(route === "fullscreen" ? "question" : "");
      let stopped = false;
      let stopping: Promise<void> | undefined;
      try {
        await entered.promise;
        stopping = app.emit(boundary).then(() => {
          stopped = true;
        });
        assert.equal(stopped, false, "session teardown must drain its pending command");
        release.resolve();
        await Promise.all([running, stopping]);
        assert.equal(shows, 0);
        assert.deepEqual(app.notifications, []);
      } finally {
        release.resolve();
        await running.catch(() => {});
        await stopping;
        await app.emit("session_shutdown");
      }
    });
  }
}

test("a failed first-use import remains observable and releases the command slot", async () => {
  vi.doMock("../src/fullscreen-ui.js", async () => {
    throw new Error("fullscreen import failed");
  });
  const app = harness();
  await app.emit("session_start");
  const isImportFailure = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(`${error.message} ${String(error.cause)}`, /fullscreen import failed/u);
    return true;
  };
  await assert.rejects(app.command(), isImportFailure);
  await assert.rejects(app.command(), isImportFailure);
  assert.deepEqual(app.notifications, []);
  await app.emit("session_shutdown");
});

for (const route of ["bring-to-main", "main-updates"] as const) {
  test(`${route} first-use import rechecks cancellation`, async () => {
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    let calls = 0;
    const path = route === "bring-to-main" ? "../src/menu.js" : "../src/import-main-updates.js";
    vi.doMock(path, async () => {
      entered.resolve();
      await release.promise;
      return route === "bring-to-main"
        ? {
            showBtwCustomPreservingEditor: async () => {
              calls++;
              return { kind: "closed" };
            },
          }
        : {
            importMainUpdates: async () => {
              calls++;
              return "close";
            },
          };
    });
    const ctx = createMockContext({ mode: "tui", signal: controller.signal }).ctx;
    const { createSideThread } = await import("../src/side-thread.js");
    const running =
      route === "bring-to-main"
        ? extension.chooseBringToMain(createSideThread(""), ctx)
        : extension.runBtwThread({
            selected,
            thinkingLevel: "off",
            ctx,
            dependencies: { interact: async () => ({ kind: "importMainUpdates", questionDraft: "draft" }) },
          });
    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      assert.deepEqual(await running, { kind: "closed" });
      assert.equal(calls, 0);
    } finally {
      release.resolve();
      await running;
    }
  });
}

for (const initialQuestion of [undefined, "question"]) {
  test(`${initialQuestion ? "answer" : "composer"} import rechecks cancellation before custom UI`, async () => {
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    let shows = 0;
    vi.doMock("../src/transcript-pager.js", async () => {
      entered.resolve();
      await release.promise;
      return { BtwAnsweringView: class {}, BtwTranscriptPager: class {} };
    });
    const context = createMockContext({
      mode: "tui",
      signal: controller.signal,
      custom: async () => {
        shows++;
        return { kind: "close" };
      },
    });
    const running = extension.runBtwThread({
      initialQuestion,
      selected,
      thinkingLevel: "off",
      ctx: context.ctx,
    });
    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      assert.deepEqual(await running, { kind: "closed" });
      assert.equal(shows, 0);
    } finally {
      release.resolve();
      await running;
    }
  });
}
