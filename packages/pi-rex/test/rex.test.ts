import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import type { RexSnapshot } from "../src/rex-snapshot.js";
import { pane } from "./fixtures.js";

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
  const tui = { terminal: { rows: 36 }, requestRender } as unknown as TUI;
  const ui = {
    theme,
    notify,
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
  const exec = vi.fn();
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
    assert.equal(current.notify.mock.calls.at(-1)?.[0], "Usage: /rex (no arguments)");
  }
  assert.equal(app.command.getArgumentCompletions?.(""), null);
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
