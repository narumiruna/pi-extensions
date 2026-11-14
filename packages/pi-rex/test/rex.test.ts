import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import type { RexSnapshot } from "../src/rex-snapshot.js";
import { pane } from "./fixtures.js";
import { navigationFixture } from "./navigation-fixture.js";

vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "pi-rex-lifecycle-tests"));
const { default: rex, POLL_INTERVAL_MS, WIDGET_KEY } = await import("../src/rex.js");
const snapshot: RexSnapshot = { entries: [pane], warnings: [] };
const theme = { fg: (_role: string, value: string) => value } as Theme;
type Handler = (event: never, ctx: ExtensionContext) => Promise<void>;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Mount = Component & { dispose?(): void };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function context(mode: ExtensionContext["mode"] = "tui") {
  let mounted: Mount | undefined;
  const mounts: Mount[] = [];
  const writes: [string, unknown][] = [];
  const requestRender = vi.fn();
  const notify = vi.fn();
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValue(undefined);
  const tui = { terminal: { rows: 36 }, requestRender } as unknown as TUI;
  const ui = {
    theme,
    notify,
    select,
    setWidget(key: string, content: Parameters<ExtensionContext["ui"]["setWidget"]>[1]) {
      writes.push([key, content]);
      mounted?.dispose?.();
      mounted = typeof content === "function" ? content(tui, ui.theme) : undefined;
      if (mounted) mounts.push(mounted);
    },
  };
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: tmpdir(),
    sessionManager: {},
    ui,
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    ui,
    tui,
    notify,
    writes,
    mounts,
    requestRender,
    get mounted() {
      return mounted;
    },
    render: (width = 120) => mounted?.render(width).join("\n") ?? "",
  };
}

function harness(read = vi.fn<(signal: AbortSignal) => Promise<RexSnapshot>>().mockResolvedValue(snapshot)) {
  const handlers = new Map<string, Handler>();
  let command: Command | undefined;
  const exec = vi.fn<ExtensionAPI["exec"]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, value: Command) {
      assert.equal(name, "rex");
      command = value;
    },
    exec,
  } as unknown as ExtensionAPI;
  rex(pi, read);
  assert.ok(command);
  const registered = command;
  const invoke = (ctx: ExtensionCommandContext, args = "") => registered.handler(args, ctx);
  const emit = async (name: string, ctx: ExtensionContext) => {
    await handlers.get(name)?.({} as never, ctx);
  };
  return { read, exec, invoke, emit, command };
}

async function started(read?: ReturnType<typeof harness>["read"]) {
  const app = harness(read);
  const current = context();
  await app.emit("session_start", current.ctx);
  cleanups.push(() => app.emit("session_shutdown", current.ctx));
  await app.invoke(current.ctx);
  return { ...app, current };
}

test("factory starts no work; TUI startup retains one Kit mount across refreshes", async () => {
  vi.useFakeTimers();
  const app = harness();
  const current = context();
  assert.equal(app.read.mock.calls.length, 0);
  await app.emit("session_start", current.ctx);
  cleanups.push(() => app.emit("session_shutdown", current.ctx));
  await app.invoke(current.ctx);
  assert.equal(current.mounts.length, 1);
  assert.equal(current.writes[0]?.[0], WIDGET_KEY);
  assert.match(current.render(), /Rex · 1 Pi session/u);
  assert.match(current.render(), /Working/u);
  const component = current.mounted;
  const renders = current.requestRender.mock.calls.length;
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.equal(app.read.mock.calls.length, 2);
  assert.equal(current.mounted, component);
  assert.equal(current.requestRender.mock.calls.length, renders, "identical snapshots do not repaint");
  app.read.mockResolvedValue({ entries: [{ ...pane, state: "blocked" }], warnings: [] });
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.equal(current.mounts.length, 1);
  assert.match(current.render(), /Blocked/u);
  assert.ok(current.requestRender.mock.calls.length > renders);
});

test.each(["rpc", "print", "json"] as const)("does not acquire UI or Rex resources in %s mode", async (mode) => {
  const app = harness();
  const current = context(mode);
  await app.emit("session_start", current.ctx);
  await app.emit("session_shutdown", current.ctx);
  assert.equal(app.read.mock.calls.length, 0);
  assert.deepEqual(current.writes, []);
  if (mode === "rpc") {
    await app.invoke(current.ctx);
    assert.match(current.notify.mock.calls.at(-1)?.[0] ?? "", /requires Pi TUI/u);
  } else await assert.rejects(app.invoke(current.ctx), /requires Pi TUI/u);
  assert.equal(current.mounts.length, 0);
});

test("rejects unknown and trailing command input without discovery", async () => {
  const app = harness();
  const current = context();
  for (const args of ["status", "refresh", "refresh extra", "help"]) {
    await app.invoke(current.ctx, args);
    assert.equal(current.notify.mock.calls.at(-1)?.[0], "Usage: /rex [switch|cancel]");
  }
  assert.deepEqual(
    (await app.command.getArgumentCompletions?.("sw"))?.map((item) => item.value),
    ["switch"],
  );
  assert.equal(app.command.getArgumentCompletions?.("switch extra"), null);
  assert.equal(app.read.mock.calls.length, 0);
  await assert.rejects(app.invoke(context("print").ctx, "bad"), /Usage/u);
});

test("command and timer reads never overlap, and shutdown aborts and joins an active scan", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<RexSnapshot>();
  const reader = vi.fn<(signal: AbortSignal) => Promise<RexSnapshot>>().mockReturnValue(pending.promise);
  const app = harness(reader);
  const current = context();
  await app.emit("session_start", current.ctx);
  const refresh = app.invoke(current.ctx);
  await vi.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
  assert.equal(reader.mock.calls.length, 1);
  const abort = reader.mock.calls[0]?.[0];
  const closing = app.emit("session_shutdown", current.ctx);
  assert.equal(abort?.aborted, true);
  assert.deepEqual(current.writes.at(-1), [WIDGET_KEY, undefined]);
  let joined = false;
  void closing.then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  pending.resolve(snapshot);
  await Promise.all([closing, refresh]);
  assert.equal(joined, true);
  assert.equal(current.mounted, undefined);
  await app.emit("session_shutdown", current.ctx);
  await vi.advanceTimersByTimeAsync(10 * POLL_INTERVAL_MS);
  assert.equal(reader.mock.calls.length, 1);
});

test("replaced sessions cannot publish a delayed result or clear the new owner", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<RexSnapshot>();
  const reader = vi
    .fn<(signal: AbortSignal) => Promise<RexSnapshot>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(snapshot);
  const app = harness(reader);
  const old = context();
  const next = context();
  await app.emit("session_start", old.ctx);
  const oldComponent = old.mounted;
  const replacement = app.emit("session_start", next.ctx);
  assert.equal(reader.mock.calls[0]?.[0].aborted, true);
  pending.resolve({ entries: [{ ...pane, session: "stale" }], warnings: [] });
  await replacement;
  cleanups.push(() => app.emit("session_shutdown", next.ctx));
  await app.invoke(next.ctx);
  assert.deepEqual(oldComponent?.render(80), []);
  assert.doesNotMatch(next.render(), /stale/u);
  const writes = next.writes.length;
  await app.emit("session_shutdown", old.ctx);
  assert.equal(next.writes.length, writes);
  assert.match(next.render(), /Project/u);
});

test("the latest concurrent session start owns the widget after prior cleanup", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<RexSnapshot>();
  const reader = vi
    .fn<(signal: AbortSignal) => Promise<RexSnapshot>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(snapshot);
  const app = harness(reader);
  const old = context();
  const skipped = context();
  const latest = context();
  await app.emit("session_start", old.ctx);
  const starts = [app.emit("session_start", skipped.ctx), app.emit("session_start", latest.ctx)];
  pending.resolve(snapshot);
  await Promise.all(starts);
  cleanups.push(() => app.emit("session_shutdown", latest.ctx));
  await app.invoke(latest.ctx);
  assert.deepEqual(skipped.writes, []);
  assert.match(latest.render(), /Project/u);
});

test("shutdown invalidates a replacement still waiting for old cleanup", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<RexSnapshot>();
  const reader = vi.fn<(signal: AbortSignal) => Promise<RexSnapshot>>().mockReturnValue(pending.promise);
  const app = harness(reader);
  const old = context();
  const next = context();
  await app.emit("session_start", old.ctx);
  const replacement = app.emit("session_start", next.ctx);
  await app.emit("session_shutdown", next.ctx);
  pending.resolve(snapshot);
  await replacement;
  assert.deepEqual(next.writes, []);
  assert.equal(reader.mock.calls.length, 1);
  assert.equal(old.mounted, undefined);
});

test("failed reads retain a stale list and recover on a later poll", async () => {
  vi.useFakeTimers();
  const app = await started();
  app.read.mockRejectedValueOnce(new Error("server offline"));
  await app.invoke(app.current.ctx);
  assert.match(app.current.render(), /Disconnected · 1 Pi session \(stale\)/u);
  assert.match(app.current.render(), /server offline/u);
  assert.match(app.current.render(), /Project/u);
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.doesNotMatch(app.current.render(), /Disconnected|server offline/u);
});

test("startup failures do not claim an observed empty list and retry", async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<RexSnapshot>();
  const reader = vi
    .fn<(signal: AbortSignal) => Promise<RexSnapshot>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(snapshot);
  const app = harness(reader);
  const current = context();
  await app.emit("session_start", current.ctx);
  cleanups.push(() => app.emit("session_shutdown", current.ctx));
  const refresh = app.invoke(current.ctx);
  first.reject(new Error("rex not found"));
  await refresh;
  assert.match(current.render(), /Rex · Unavailable/u);
  assert.match(current.render(), /rex not found/u);
  assert.doesNotMatch(current.render(), /0 Pi sessions|stale/u);
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.match(current.render(), /1 Pi session/u);
  assert.equal(reader.mock.calls.length, 2);
});

test("a fullscreen collapse has a command restore path and keeps the latest body", async () => {
  vi.useFakeTimers();
  const app = await started();
  const widget = app.current.mounted;
  assert.ok(widget?.handleMouse);
  widget.render(120);
  const event = {
    type: "press" as const,
    button: "left" as const,
    x: 2,
    y: 0,
    screenX: 2,
    screenY: 1,
    width: 120,
    height: 2,
    shift: false,
    ctrl: false,
    alt: false,
  };
  widget.handleMouse(event);
  widget.handleMouse({ ...event, type: "click" });
  assert.equal(widget.render(120).length, 1);
  app.read.mockResolvedValue({ entries: [{ ...pane, state: "done" }], warnings: [] });
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.equal(widget.render(120).length, 1);
  await app.invoke(app.current.ctx);
  assert.match(app.current.render(), /Done/u);
});

test("host disposal permits a fresh mount on the next changed snapshot", async () => {
  vi.useFakeTimers();
  const app = await started();
  const old = app.current.mounted;
  old?.dispose?.();
  app.read.mockResolvedValue({ entries: [], warnings: [] });
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.equal(app.current.mounts.length, 2);
  assert.deepEqual(old?.render(80), []);
  assert.match(app.current.render(), /No Pi sessions/u);
});

test("failed initial widget publication clears its exact key and starts no scan", async () => {
  const app = harness();
  const current = context();
  const original = current.ui.setWidget;
  vi.spyOn(current.ui, "setWidget")
    .mockImplementationOnce(() => {
      throw new Error("mount failed");
    })
    .mockImplementation(original);
  await assert.rejects(app.emit("session_start", current.ctx), /mount failed/u);
  assert.equal(app.read.mock.calls.length, 0);
  assert.deepEqual(current.writes.at(-1), [WIDGET_KEY, undefined]);
  await app.emit("session_shutdown", current.ctx);
});

test("a cleanup failure still aborts and joins the active read", async () => {
  const pending = Promise.withResolvers<RexSnapshot>();
  const reader = vi.fn<(signal: AbortSignal) => Promise<RexSnapshot>>().mockReturnValue(pending.promise);
  const app = harness(reader);
  const current = context();
  await app.emit("session_start", current.ctx);
  vi.spyOn(current.ui, "setWidget").mockImplementation(() => {
    throw new Error("clear failed");
  });
  const closing = app.emit("session_shutdown", current.ctx);
  assert.equal(reader.mock.calls[0]?.[0].aborted, true);
  pending.resolve(snapshot);
  await assert.rejects(closing, /clear failed/u);
  assert.equal(reader.mock.calls.length, 1);
});

function attachNavigation(app: ReturnType<typeof harness>) {
  const navigation = navigationFixture();
  app.exec.mockImplementation(async (_command, allArgs, options) => {
    const args = allArgs.slice(5);
    const signal = options?.signal ?? new AbortController().signal;
    const result =
      args[0] === "focus" || args[2] === "do"
        ? await navigation.run(args, signal)
        : await navigation.query(args, signal);
    return {
      stdout: typeof result === "string" ? result : JSON.stringify(result),
      stderr: "",
      code: 0,
      killed: false,
      truncated: false,
    };
  });
  return navigation;
}

test("keyboard switching uses the native picker and preserves the no-argument refresh route", async () => {
  vi.useFakeTimers();
  const app = await started();
  const navigation = attachNavigation(app);
  assert.equal(app.current.ui.select.mock.calls.length, 0);
  app.current.ui.select.mockImplementation(async (_title, labels) => labels[0]);
  await app.invoke(app.current.ctx, "switch");
  assert.equal(app.current.ui.select.mock.calls[0]?.[0], "Switch to Rex agent");
  assert.equal(navigation.mutations.length, 2);
  assert.deepEqual(
    (await app.command.getArgumentCompletions?.(""))?.map((item) => item.value),
    ["switch", "cancel"],
  );
});

test("body clicks navigate without collapsing or opening the agent picker", async () => {
  vi.useFakeTimers();
  const app = await started();
  const navigation = attachNavigation(app);
  const widget = app.current.mounted;
  assert.ok(widget?.handleMouse);
  widget.render(80);
  const event = {
    type: "press" as const,
    button: "left" as const,
    x: 3,
    y: 1,
    screenX: 3,
    screenY: 1,
    width: 80,
    height: 2,
    shift: false,
    ctrl: false,
    alt: false,
  };
  widget.handleMouse(event);
  assert.deepEqual(widget.handleMouse({ ...event, type: "click" }), { handled: true });
  await app.invoke(app.current.ctx, "switch"); // Joins the active click, rather than queuing another switch.
  assert.equal(navigation.mutations.length, 2);
  assert.equal(app.current.ui.select.mock.calls.length, 0);
  assert.equal(widget.render(80).length, 2);
});

test("picker cancellation and stale snapshots do not send navigation commands", async () => {
  vi.useFakeTimers();
  const app = await started();
  attachNavigation(app);
  await app.invoke(app.current.ctx, "switch");
  assert.equal(app.exec.mock.calls.length, 0);
  app.read.mockRejectedValueOnce(new Error("offline"));
  await app.invoke(app.current.ctx, "switch");
  assert.equal(app.exec.mock.calls.length, 0);
  assert.match(app.current.notify.mock.calls.at(-1)?.[0] ?? "", /snapshot is unavailable/u);
});

test("shutdown cancels and joins a pending picker before accepting any later result", async () => {
  vi.useFakeTimers();
  const app = await started();
  attachNavigation(app);
  const pending = Promise.withResolvers<string | undefined>();
  const opened = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let choice: string | undefined;
  app.current.ui.select.mockImplementation((_title, labels, options) => {
    signal = options?.signal;
    choice = labels[0];
    opened.resolve();
    return pending.promise;
  });
  const switching = app.invoke(app.current.ctx, "switch");
  await opened.promise;
  const closing = app.emit("session_shutdown", app.current.ctx);
  assert.equal(signal?.aborted, true);
  pending.resolve(choice);
  await Promise.all([switching, closing]);
  assert.equal(app.exec.mock.calls.length, 0);
});

test("widget disposal cancels the multi-client selector before any focus request", async () => {
  vi.useFakeTimers();
  const app = await started();
  const navigation = attachNavigation(app);
  navigation.model.clients.push(navigation.connected("client:00000000-0000-0000-0000-000000000099"));
  const pending = Promise.withResolvers<string | undefined>();
  const opened = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  app.current.ui.select.mockImplementation(async (title, labels, options) => {
    if (title === "Switch to Rex agent") return labels[0];
    signal = options?.signal;
    opened.resolve();
    return pending.promise;
  });
  const switching = app.invoke(app.current.ctx, "switch");
  await opened.promise;
  app.current.mounted?.dispose?.();
  assert.equal(signal?.aborted, true);
  pending.resolve(undefined);
  await switching;
  assert.deepEqual(navigation.mutations, []);
});

test("explicit cancellation aborts navigation I/O without stopping session polling", async () => {
  vi.useFakeTimers();
  const app = await started();
  const navigation = attachNavigation(app);
  const opened = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const original = navigation.query.getMockImplementation();
  navigation.query.mockImplementation(async (args, s) => {
    if (args[0] === "client") {
      signal = s;
      opened.resolve();
      await pending.promise;
    }
    return original?.(args, s);
  });
  app.current.ui.select.mockImplementation(async (_title, labels) => labels[0]);
  const switching = app.invoke(app.current.ctx, "switch");
  await opened.promise;
  await app.invoke(app.current.ctx, "cancel");
  assert.equal(signal?.aborted, true);
  pending.resolve();
  await switching;
  assert.deepEqual(navigation.mutations, []);
  const reads = app.read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  assert.ok(app.read.mock.calls.length > reads);
});

test("shutdown after server focus prevents app selection and stale notifications", async () => {
  vi.useFakeTimers();
  const app = await started();
  const navigation = attachNavigation(app);
  const opened = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<void>();
  const original = navigation.query.getMockImplementation();
  navigation.query.mockImplementation(async (args, signal) => {
    if (args[0] === "block" && args[1] === "inspect" && navigation.model.focused) {
      opened.resolve();
      await pending.promise;
    }
    return original?.(args, signal);
  });
  app.current.ui.select.mockImplementation(async (_title, labels) => labels[0]);
  const switching = app.invoke(app.current.ctx, "switch");
  await opened.promise;
  const closing = app.emit("session_shutdown", app.current.ctx);
  pending.resolve();
  await Promise.all([switching, closing]);
  assert.equal(navigation.mutations.length, 1);
  assert.equal(app.current.notify.mock.calls.length, 0);
});

test.each(["rpc", "print", "json"] as const)("switch and cancel routes reject %s before UI or I/O", async (mode) => {
  const app = harness();
  const current = context(mode);
  for (const route of ["switch", "cancel"]) {
    if (mode === "rpc") {
      await app.invoke(current.ctx, route);
      assert.match(current.notify.mock.calls.at(-1)?.[0] ?? "", /requires Pi TUI/u);
    } else await assert.rejects(app.invoke(current.ctx, route), /requires Pi TUI/u);
  }
  assert.equal(current.ui.select.mock.calls.length, 0);
  assert.equal(app.exec.mock.calls.length, 0);
});
