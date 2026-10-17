import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ServerOptions, ViewerServer } from "../src/server.js";

const temp = await mkdtemp(join(tmpdir(), "inspector-tests-"));
process.env.PI_CODING_AGENT_DIR = temp;
const { registerInspector } = await import("../src/extension.js");
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});
function harness() {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const commands = new Map<string, NonNullable<typeof command>>();
  const notifications: string[] = [];
  const confirm = vi.fn(async () => true);
  const sharedUI = { confirm, notify: (s: string) => notifications.push(s) };
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerCommand: (name: string, c: NonNullable<typeof command>) => {
      commands.set(name, c);
      if (name === "inspect") command = c;
    },
    getAllTools: () => [],
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  const start = vi.fn(
    async (_options: ServerOptions): Promise<ViewerServer> => ({
      token: "t",
      origin: "http://127.0.0.1:1",
      url: "http://127.0.0.1:1/#token=t",
      invalidate: vi.fn(),
      close: vi.fn(async () => {}),
    }),
  );
  const launch = vi.fn(async () => true);
  registerInspector(pi, { start, launch });
  const context = (mode: ExtensionContext["mode"] = "tui") =>
    ({
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      ui: sharedUI,
      sessionManager: SessionManager.inMemory(temp),
      getSystemPrompt: () => "prompt",
      getSystemPromptOptions: () => ({ cwd: temp, skills: [] }),
    }) as unknown as ExtensionCommandContext;
  const emit = async (type: string, ctx: ExtensionContext, event: unknown = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
  };
  const run = async (ctx: ExtensionCommandContext, args = "", name = "inspect") =>
    commands.get(name)?.handler(args, ctx);
  return { start, launch, context, emit, run, confirm, notifications, command: () => command };
}
describe("owned lifecycle and mode contract", () => {
  it("refreshes settled cache usage without changing normalized model input and revokes old data", async () => {
    const { cacheAssistant, cacheUsage } = await import("./cache-fixtures.js");
    const h = harness();
    const ctx = h.context();
    const manager = ctx.sessionManager as SessionManager;
    manager.appendMessage(cacheAssistant());
    await h.run(ctx);
    const options = h.start.mock.calls[0]?.[0];
    expect(options?.snapshot()).toMatchObject({ cache: { totals: { count: 1 } } });
    const first = {
      system: "stable prompt",
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      messages: [
        { role: "system", content: "stable prompt" },
        { role: "user", content: "request" },
      ],
    };
    const baseline = structuredClone(first);
    await h.emit("context_with_system", ctx, { messages: first.messages });
    await h.emit("before_provider_request", ctx, { payload: first });
    manager.appendUsage("cache_warm", "provider", "model", cacheUsage());
    await h.emit("agent_settled", ctx);
    expect(options?.snapshot()).toMatchObject({ cache: { totals: { count: 2 } } });
    expect(first).toEqual(baseline);
    const next = {
      ...structuredClone(first),
      messages: [...first.messages, { role: "assistant", content: "reply" }, { role: "user", content: "next" }],
    };
    const expected = structuredClone(next);
    await h.emit("context_with_system", ctx, { messages: next.messages });
    await h.emit("before_provider_request", ctx, { payload: next });
    expect(next).toEqual(expected);
    expect(next.messages.slice(0, first.messages.length)).toEqual(baseline.messages);
    expect(next.system).toBe(baseline.system);
    expect(next.tools).toEqual(baseline.tools);
    await h.emit("session_start", ctx);
    expect(() => options?.snapshot()).toThrow("stopped");
    await h.run(ctx);
    expect(h.start.mock.calls[1]?.[0].snapshot()).toMatchObject({ cache: { totals: { count: 2 } } });
    await h.run(ctx, "stop");
    expect(() => h.start.mock.calls[1]?.[0].snapshot()).toThrow("stopped");
  });
  it("preserves the legacy alias with the same consent, owner and stop behavior", async () => {
    const h = harness();
    const ctx = h.context();
    await h.run(ctx);
    await h.run(ctx, "", "session-inspector");
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    await h.run(ctx, "stop", "session-inspector");
    const server = await h.start.mock.results[0]?.value;
    expect(server?.close).toHaveBeenCalled();
    await expect(h.run(h.context("json"), "", "session-inspector")).rejects.toThrow("TUI");
    await expect(h.run(h.context("print"), "bad", "session-inspector")).rejects.toThrow("Usage: /inspect");
  });
  it("captures context only after consent, returns no transformations, and releases it on replacement", async () => {
    const h = harness();
    const ctx = h.context();
    const event = { messages: [{ role: "user", content: "observed" }] };
    await h.emit("context_with_system", ctx, event);
    expect(h.start).not.toHaveBeenCalled();
    await h.run(ctx);
    await h.emit("context_with_system", ctx, event);
    const options = h.start.mock.calls[0]?.[0];
    expect(options?.snapshot()).toMatchObject({ context: { source: "observed-pi-context" } });
    const message = event.messages[0];
    if (!message) throw new Error("Missing fixture message");
    message.content = "mutated later";
    expect(JSON.stringify(options?.snapshot())).not.toContain("mutated later");
    await h.emit("before_provider_request", ctx, {
      payload: { headers: { authorization: "private" }, messages: ["provider stage"] },
    });
    expect(JSON.stringify(options?.snapshot())).toContain("provider stage");
    expect(JSON.stringify(options?.snapshot())).not.toContain("private");
    await h.emit("session_start", ctx);
    await h.run(ctx);
    expect(h.start.mock.calls[1]?.[0].snapshot()).toMatchObject({ context: { source: "session-derived" } });
    await h.run(ctx, "stop");
  });
  it("does no factory work, cancels consent and retries startup failure", async () => {
    const h = harness();
    const ctx = h.context();
    expect(h.start).not.toHaveBeenCalled();
    h.confirm.mockResolvedValueOnce(false);
    await h.run(ctx);
    expect(h.start).not.toHaveBeenCalled();
    h.start.mockRejectedValueOnce(new Error("missing assets"));
    await h.run(ctx);
    expect(h.notifications.join(" ")).toContain("Build");
    await h.run(ctx);
    expect(h.start).toHaveBeenCalledTimes(2);
    await h.run(ctx, "stop");
  });
  it("prints the private fallback URL on a separate line without overwriting the editor", async () => {
    const h = harness();
    const ctx = h.context();
    h.launch.mockResolvedValueOnce(false);
    await h.run(ctx);
    const server = await h.start.mock.results[0]?.value;
    expect(h.notifications[0]?.split("\n")).toEqual([
      "Browser unavailable; open privately:",
      server?.url,
      "/inspect stop revokes this URL.",
    ]);
    await h.run(ctx, "stop");
  });
  it("revokes opening consent on shutdown and never launches a replaced context", async () => {
    const h = harness();
    const ctx = h.context();
    let ready: () => void = () => {};
    const handshake = new Promise<void>((resolve) => {
      ready = resolve;
    });
    h.confirm.mockImplementation((_title?: unknown, _message?: unknown, options?: unknown) => {
      const signal = (options as { signal: AbortSignal }).signal;
      ready();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
    });
    const opening = h.run(ctx);
    await handshake;
    await h.emit("session_shutdown", ctx);
    await opening;
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
  it("closes partial startup after replacement and bounds repeated activation", async () => {
    const h = harness();
    const ctx = h.context();
    let ready: () => void = () => {};
    let finish: (s: ViewerServer) => void = () => {};
    const handshake = new Promise<void>((resolve) => {
      ready = resolve;
    });
    h.start.mockImplementation(async () => {
      ready();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const opening = h.run(ctx);
    await handshake;
    await h.run(ctx);
    expect(h.start).toHaveBeenCalledTimes(1);
    const closing = h.emit("session_shutdown", ctx);
    const close = vi.fn(async () => {});
    finish({ origin: "", token: "", url: "", invalidate: () => {}, close });
    await closing;
    await opening;
    expect(close).toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });
  it("cancels the owned browser-launch task and revalidates after await", async () => {
    const h = harness();
    const ctx = h.context();
    let ready: () => void = () => {};
    const handshake = new Promise<void>((resolve) => {
      ready = resolve;
    });
    h.launch.mockImplementation(async (_pi?: unknown, _url?: unknown, signal?: unknown) => {
      ready();
      return new Promise((resolve) =>
        (signal as AbortSignal).addEventListener("abort", () => resolve(false), { once: true }),
      );
    });
    const opening = h.run(ctx);
    await handshake;
    await h.emit("session_shutdown", ctx);
    await opening;
    expect(h.notifications).toHaveLength(0);
  });
  it("keys two sessions by manager rather than shared UI and rotates on reload", async () => {
    const h = harness();
    const a = h.context();
    const b = h.context();
    expect(a.ui).toBe(b.ui);
    await h.run(a);
    await h.run(b);
    const first = await h.start.mock.results[0]?.value;
    const second = await h.start.mock.results[1]?.value;
    await h.emit("session_shutdown", a);
    expect(first?.close).toHaveBeenCalled();
    expect(second?.close).not.toHaveBeenCalled();
    await h.emit("session_start", a);
    await h.run(a);
    expect(h.start).toHaveBeenCalledTimes(3);
    await h.run(a, "stop");
    await h.run(b, "stop");
  });
  it("rejects unsupported routes/modes observably and permits stop without UI", async () => {
    const h = harness();
    for (const mode of ["json", "print"] as const) {
      await expect(h.run(h.context(mode))).rejects.toThrow("TUI");
      await expect(h.run(h.context(mode), "bad")).rejects.toThrow("Usage");
      await h.run(h.context(mode), "stop");
    }
    await h.run(h.context("rpc"));
    expect(h.notifications.join(" ")).toContain("TUI");
    await h.run(h.context(), "stop trailing");
    expect(h.notifications.join(" ")).toContain("Usage");
    expect(h.command()?.getArgumentCompletions?.("st")).toEqual([{ value: "stop", label: "stop" }]);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });
});
