import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const directory = mkdtempSync(join(tmpdir(), "statusline-metadata-lifecycle-"));
vi.stubEnv("PI_CODING_AGENT_DIR", directory);
vi.resetModules();
const { default: statusline } = await import("../src/statusline.js");
writeFileSync(join(directory, "pi-statusline.json"), JSON.stringify({ segments: ["model"] }));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const UPDATE = "extension-status:v1:update";
const REQUEST = "extension-status:v1:request";
const key = "vendor/stream";
const value = "participant readable fallback";
type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type Request = { version: number; sessionManager: object; requestId: object };

async function emit(mock: Mock, event: string, context: Context) {
  for (const handler of mock.events.get(event) ?? []) await handler({}, context.ctx);
}

function fixture() {
  const mock = createMockPi();
  const context = createMockContext({ mode: "tui", cwd: directory });
  const ctx = context.ctx as ExtensionContext;
  const statuses = new Map([[key, value]]);
  const requests: Request[] = [];
  let activeListeners = 0;
  const on = mock.eventBus.on.bind(mock.eventBus);
  mock.eventBus.on = (channel, handler) => {
    if (channel === UPDATE) activeListeners += 1;
    const unsubscribe = on(channel, handler);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (channel === UPDATE) activeListeners -= 1;
      unsubscribe();
    };
  };
  mock.eventBus.on(REQUEST, (request) => requests.push(request as Request));
  statusline(mock.pi);
  const update = (fields: Record<string, unknown> = {}) =>
    mock.eventBus.emit(UPDATE, {
      version: 1,
      sessionManager: ctx.sessionManager,
      key,
      value,
      activity: "checking",
      ...fields,
    });
  const mount = (factory = context.footer as FooterFactory, raw = statuses) => {
    const requestRender = vi.fn();
    const branchUnsubscribe = vi.fn();
    const footer = factory(
      { requestRender } as never,
      { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => raw,
        getAvailableProviderCount: () => 0,
        onBranchChange: () => branchUnsubscribe,
      },
    );
    return {
      footer,
      requestRender,
      branchUnsubscribe,
      render: (width = 200) => footer.render(width).slice(1).join("\n"),
    };
  };
  return {
    mock,
    context,
    ctx,
    statuses,
    requests,
    update,
    mount,
    get activeListeners() {
      return activeListeners;
    },
  };
}

test.each(["publisher-first", "consumer-first"])(
  "metadata works in %s load order without changing raw state",
  async (order) => {
    const f = fixture();
    let publisherUnsubscribe: (() => void) | undefined;
    const publishSnapshot = () => {
      publisherUnsubscribe = f.mock.eventBus.on(REQUEST, (payload) => {
        const request = payload as Request;
        if (request.sessionManager === f.ctx.sessionManager)
          f.update({ requestId: request.requestId, activity: "review" });
      });
    };
    if (order === "publisher-first") publishSnapshot();
    await emit(f.mock, "session_start", f.context);
    assert.equal(f.activeListeners, 0);
    const mounted = f.mount();
    try {
      if (order === "consumer-first") {
        assert.match(mounted.render(), /participant readable fallback/);
        publishSnapshot();
        f.update({ activity: "review" });
      }
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]?.sessionManager, f.ctx.sessionManager);
      assert.equal(f.activeListeners, 1);
      assert.match(mounted.render(), /🔌 ⇕/);
      assert.equal(f.statuses.get(key), value);
      assert.equal(f.mock.sentMessages.length, 0);
      assert.equal(f.mock.entries.length, 0);
      const renders = mounted.requestRender.mock.calls.length;
      mounted.render();
      mounted.render(0);
      assert.equal(mounted.requestRender.mock.calls.length, renders);
    } finally {
      publisherUnsubscribe?.();
      mounted.footer.dispose?.();
      await emit(f.mock, "session_shutdown", f.context);
      assert.equal(f.activeListeners, 0);
    }
  },
);

test("disposal and reinstallation clear cache, remove listeners, and use a new snapshot token", async () => {
  const f = fixture();
  await emit(f.mock, "session_start", f.context);
  const factory = f.context.footer as FooterFactory;
  const first = f.mount(factory);
  let second: ReturnType<typeof f.mount> | undefined;
  try {
    f.update({ activity: "idle" });
    assert.equal(first.render(), "");
    const oldRequestId = f.requests[0]?.requestId;
    first.footer.dispose?.();
    first.footer.dispose?.();
    assert.equal(f.activeListeners, 0);
    assert.equal(first.branchUnsubscribe.mock.calls.length, 1);
    const firstRenders = first.requestRender.mock.calls.length;
    f.update({ activity: "working" });
    assert.equal(first.requestRender.mock.calls.length, firstRenders);
    assert.deepEqual(first.footer.render(200), []);

    second = f.mount(factory);
    assert.equal(f.activeListeners, 1);
    assert.equal(f.requests.length, 2);
    assert.notEqual(f.requests[1]?.requestId, oldRequestId);
    assert.match(second.render(), /participant readable fallback/);
    f.update({ activity: "idle", requestId: oldRequestId });
    assert.match(second.render(), /participant readable fallback/);
    f.update({ activity: "review", requestId: f.requests[1]?.requestId });
    assert.match(second.render(), /⇕/);
    assert.equal(first.requestRender.mock.calls.length, firstRenders);
  } finally {
    first.footer.dispose?.();
    second?.footer.dispose?.();
    await emit(f.mock, "session_shutdown", f.context);
    assert.equal(f.activeListeners, 0);
  }
});

test.each(["session_start", "session_tree"])(
  "%s replacement cannot use old metadata, contexts, or UI callbacks",
  async (event) => {
    const f = fixture();
    await emit(f.mock, "session_start", f.context);
    const oldFactory = f.context.footer as FooterFactory;
    const first = f.mount(oldFactory);
    const replacement = createMockContext({ mode: "tui", cwd: directory, ui: f.ctx.ui });
    const replacementContext = replacement.ctx as ExtensionContext;
    assert.notEqual(replacementContext.sessionManager, f.ctx.sessionManager);
    assert.equal(replacementContext.ui, f.ctx.ui);
    let second: ReturnType<typeof f.mount> | undefined;
    try {
      f.update({ activity: "idle" });
      await emit(f.mock, event, replacement);
      assert.equal(f.activeListeners, 0);
      second = f.mount(f.context.footer as FooterFactory);
      assert.equal(f.activeListeners, 1);
      assert.equal(f.requests.at(-1)?.sessionManager, replacementContext.sessionManager);
      assert.match(second.render(), /participant readable fallback/);
      const oldRenderCount = first.requestRender.mock.calls.length;
      f.update({ activity: "review" });
      f.update({ activity: "idle", requestId: f.requests[0]?.requestId });
      assert.match(second.render(), /participant readable fallback/);
      f.update({ sessionManager: replacementContext.sessionManager, activity: "review" });
      assert.match(second.render(), /⇕/);
      assert.equal(first.requestRender.mock.calls.length, oldRenderCount);
      assert.deepEqual(first.footer.render(200), []);
      const stale = f.mount(oldFactory);
      assert.deepEqual(stale.footer.render(200), []);
      assert.equal(f.activeListeners, 1);
      first.footer.dispose?.();
      await emit(f.mock, "session_shutdown", f.context);
      assert.equal(f.activeListeners, 1);
      assert.match(second.render(), /⇕/);
    } finally {
      first.footer.dispose?.();
      second?.footer.dispose?.();
      await emit(f.mock, "session_shutdown", replacement);
      assert.equal(f.activeListeners, 0);
    }
  },
);

test("same-session reload removes old listeners and rejects previous-generation snapshots", async () => {
  const f = fixture();
  await emit(f.mock, "session_start", f.context);
  const first = f.mount();
  let second: ReturnType<typeof f.mount> | undefined;
  try {
    f.update({ activity: "idle" });
    const oldRequest = f.requests[0];
    await emit(f.mock, "session_start", f.context);
    assert.equal(f.activeListeners, 0);
    second = f.mount();
    assert.equal(f.activeListeners, 1);
    f.update({ activity: "idle", requestId: oldRequest?.requestId });
    assert.match(second.render(), /participant readable fallback/);
    f.update({ activity: "review", requestId: f.requests.at(-1)?.requestId });
    assert.match(second.render(), /⇕/);
    await emit(f.mock, "session_shutdown", f.context);
    assert.equal(f.activeListeners, 0);
    const renders = second.requestRender.mock.calls.length;
    f.update({ activity: "working" });
    assert.equal(second.requestRender.mock.calls.length, renders);
  } finally {
    first.footer.dispose?.();
    second?.footer.dispose?.();
    await emit(f.mock, "session_shutdown", f.context);
  }
});

test.each(["print", "json", "rpc"])(
  "%s mode does not install a footer or metadata listener even with shared UI",
  async (mode) => {
    const f = fixture();
    const setFooter = vi.spyOn(f.ctx.ui, "setFooter");
    const context = createMockContext({ mode, hasUI: mode === "rpc", ui: f.ctx.ui });
    await emit(f.mock, "session_start", context);
    f.update({ sessionManager: (context.ctx as ExtensionContext).sessionManager, activity: "idle" });
    await emit(f.mock, "session_shutdown", context);
    assert.equal(setFooter.mock.calls.length, 0);
    assert.equal(f.activeListeners, 0);
    assert.equal(f.requests.length, 0);
  },
);

test("observed raw clear at width zero invalidates metadata before the same value returns", async () => {
  const f = fixture();
  await emit(f.mock, "session_start", f.context);
  const mounted = f.mount();
  try {
    f.update({ activity: "idle", requestId: f.requests[0]?.requestId });
    assert.equal(mounted.render(), "");
    f.statuses.delete(key);
    mounted.render(0);
    f.statuses.set(key, value);
    f.update({ activity: "idle", requestId: f.requests[0]?.requestId });
    assert.match(mounted.render(), /participant readable fallback/);
    f.update({ activity: "checking" });
    assert.match(mounted.render(), /…/);
  } finally {
    mounted.footer.dispose?.();
    await emit(f.mock, "session_shutdown", f.context);
  }
});

test("failed footer installation releases its listener and render ownership", async () => {
  const f = fixture();
  let mounted: ReturnType<typeof f.mount> | undefined;
  vi.spyOn(f.ctx.ui, "setFooter").mockImplementation((factory) => {
    if (!factory) return;
    mounted = f.mount(factory);
    throw new Error("mount failed");
  });
  await assert.rejects(emit(f.mock, "session_start", f.context), /mount failed/);
  assert.equal(f.activeListeners, 0);
  assert.ok(mounted);
  const renders = mounted.requestRender.mock.calls.length;
  f.update({ activity: "working" });
  assert.equal(mounted.requestRender.mock.calls.length, renders);
  assert.deepEqual(mounted.footer.render(200), []);
  mounted.footer.dispose?.();
  await emit(f.mock, "session_shutdown", f.context);
});

test("failure before a replacement footer starts also releases the previous subscription", async () => {
  const f = fixture();
  await emit(f.mock, "session_start", f.context);
  const mounted = f.mount();
  try {
    f.mock.rawPi.getThinkingLevel = () => {
      throw new Error("initialization failed");
    };
    await assert.rejects(emit(f.mock, "session_start", f.context), /initialization failed/);
    assert.equal(f.activeListeners, 0);
    assert.deepEqual(mounted.footer.render(200), []);
  } finally {
    mounted.footer.dispose?.();
    await emit(f.mock, "session_shutdown", f.context);
  }
});
