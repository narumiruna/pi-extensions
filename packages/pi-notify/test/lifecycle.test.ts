import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
let directory: string;
let originalAgentDir: string | undefined;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const token = `123:${"s".repeat(30)}`;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-notify-life-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"ok":true,"result":{}}'));
  vi.stubGlobal("fetch", fetcher);
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await fs.rm(directory, { recursive: true, force: true });
});
async function setup() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const { default: notify } = await import("../src/notify.js");
  notify({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: (name: string, command: never) => commands.set(name, command),
  } as unknown as ExtensionAPI);
  const emit = async (name: string, ctx: ExtensionContext, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event as never, ctx);
  };
  let input: ((data: string) => unknown) | undefined;
  const unsubscribe = vi.fn(() => {
    input = undefined;
  });
  const notifyUI = vi.fn();
  const tui = createTuiHarness();
  const ui = {
    custom: tui.custom,
    notify: notifyUI,
    onTerminalInput: (handler: (data: string) => unknown) => {
      input = handler;
      return unsubscribe;
    },
  };
  const context = (mode = "tui", trusted = true) =>
    ({
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      cwd: directory,
      isProjectTrusted: () => trusted,
      sessionManager: { getSessionId: () => "session", getSessionName: () => "Example" },
      ui,
    }) as unknown as ExtensionContext;
  return { handlers, commands, emit, context, unsubscribe, notifyUI, tui, input: (data: string) => input?.(data) };
}
async function enable(mode = "immediate") {
  await fs.writeFile(
    join(directory, "pi-notify.json"),
    JSON.stringify({
      enabled: true,
      mode,
      targetIds: ["one"],
      destinations: { one: { provider: "telegram", label: "Personal", botToken: token, chatId: "123" } },
    }),
  );
}
it("factory is passive and does not register tools or model-visible hooks", async () => {
  const h = await setup();
  expect(fetcher).not.toHaveBeenCalled();
  expect(await fs.readdir(directory)).toEqual([]);
  expect([...h.commands.keys()]).toEqual(["notify"]);
  expect([...h.handlers.keys()]).toEqual([
    "session_start",
    "before_agent_start",
    "agent_start",
    "message_end",
    "agent_settled",
    "session_shutdown",
  ]);
});
it("does not notify intermediate events and uses final error outcome", async () => {
  await enable();
  const h = await setup();
  const ctx = h.context();
  await h.emit("session_start", ctx);
  await h.emit("agent_settled", ctx, { aborted: false }); // Historical/no work.
  await h.emit("before_agent_start", ctx); // Also covers failure before agent_start if settlement is emitted.
  await h.emit("agent_end", ctx);
  await h.emit("session_compact", ctx);
  await h.emit("auto_retry_start", ctx);
  expect(fetcher).not.toHaveBeenCalled();
  await h.emit("message_end", ctx, {
    message: { role: "assistant", stopReason: "error", errorMessage: "secret transcript" },
  });
  await h.emit("agent_settled", ctx, { aborted: false });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { interval: 1 });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.text).toContain("Pi stopped with an error");
  expect(body.text).not.toMatch(/secret transcript/);
  await h.emit("agent_settled", ctx, { aborted: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await h.emit("session_shutdown", ctx);
  expect(h.unsubscribe).toHaveBeenCalledTimes(1);
});
it("delivers one settled work period to both Telegram and Gotify from the built-in registry", async () => {
  await enable();
  const path = join(directory, "pi-notify.json");
  const settings = JSON.parse(await fs.readFile(path, "utf8"));
  settings.destinations.gotify = {
    provider: "gotify",
    label: "Gotify",
    serverUrl: "https://push.example.com/base",
    appToken: "A-token",
  };
  settings.targetIds.push("gotify");
  await fs.writeFile(path, JSON.stringify(settings));
  fetcher.mockImplementation(
    async (url) =>
      new Response(
        String(url).includes("push.example.com")
          ? JSON.stringify({ id: 1, appid: 1, message: "accepted", date: "2026-07-06T00:00:00Z" })
          : '{"ok":true,"result":{}}',
      ),
  );
  const h = await setup();
  const ctx = h.context("rpc");
  await h.emit("session_start", ctx);
  await h.emit("before_agent_start", ctx);
  await h.emit("agent_settled", ctx, { aborted: false });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { interval: 1 });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `https://api.telegram.org/bot${token}/sendMessage`,
    "https://push.example.com/base/message",
  ]);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).message).toContain("Example");
  await h.emit("session_shutdown", ctx);
});
it("aborts Gotify delivery on session replacement and shutdown without stale warnings", async () => {
  await fs.writeFile(
    join(directory, "pi-notify.json"),
    JSON.stringify({
      targetIds: ["gotify"],
      destinations: {
        gotify: { provider: "gotify", label: "Gotify", serverUrl: "https://push.example.com", appToken: "A-token" },
      },
    }),
  );
  fetcher.mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("A-token")), { once: true });
      }),
  );
  const h = await setup();
  const ctx = h.context("rpc");
  await h.emit("session_start", ctx);
  for (const boundary of ["session_start", "session_shutdown"]) {
    await h.emit("before_agent_start", ctx);
    await h.emit("agent_settled", ctx, { aborted: false });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(boundary === "session_start" ? 1 : 2), {
      interval: 1,
    });
    const requestSignal = fetcher.mock.calls.at(-1)?.[1]?.signal;
    expect(requestSignal?.aborted).toBe(false);
    await h.emit(boundary, ctx);
    expect(requestSignal?.aborted).toBe(true);
  }
  expect(h.notifyUI).not.toHaveBeenCalled();
});
it("suppresses aborts even when final assistant error remains after retry cancellation", async () => {
  await enable();
  const h = await setup();
  const ctx = h.context();
  await h.emit("session_start", ctx);
  await h.emit("before_agent_start", ctx);
  await h.emit("agent_start", ctx);
  await h.emit("message_end", ctx, { message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_settled", ctx, { aborted: true });
  await h.emit("session_shutdown", ctx);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["rpc", "print", "json"])("uses settlement fallback in %s, rejects or explains non-TUI setup", async (mode) => {
  await enable("after-inactivity");
  const h = await setup();
  const ctx = h.context(mode);
  await h.emit("session_start", ctx);
  await h.emit("before_agent_start", ctx);
  await h.emit("agent_settled", ctx, { aborted: false });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { interval: 1 });
  const command = h.commands.get("notify");
  assert.ok(command);
  if (mode === "rpc") {
    await command.handler("", ctx as ExtensionCommandContext);
    expect(h.notifyUI).toHaveBeenCalled();
  } else await expect(command.handler("", ctx as ExtensionCommandContext)).rejects.toThrow("requires TUI");
  await expect(command.handler("settings trailing", ctx as ExtensionCommandContext)).rejects.toThrow("Usage");
  await h.emit("session_shutdown", ctx);
});
it("isolates headless sessions sharing one UI and ignores untrusted project routing", async () => {
  await enable();
  await fs.mkdir(join(directory, ".pi"));
  await fs.writeFile(join(directory, ".pi", "pi-notify.json"), '{"enabled":false}');
  const h = await setup();
  const first = h.context("rpc", false);
  const second = h.context("rpc", true);
  expect(first.ui).toBe(second.ui);
  await h.emit("session_start", first);
  await h.emit("session_start", second);
  await h.emit("before_agent_start", first);
  await h.emit("before_agent_start", second);
  await h.emit("agent_settled", first, { aborted: false });
  await h.emit("agent_settled", second, { aborted: false });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { interval: 1 });
  await h.emit("session_shutdown", first);
  await h.emit("session_shutdown", second);
});
it("reload cancels pending reminder and old subscriptions without replay", async () => {
  await enable("after-inactivity");
  const h = await setup();
  const ctx = h.context();
  await h.emit("session_start", ctx);
  await h.emit("before_agent_start", ctx);
  await h.emit("agent_settled", ctx, { aborted: false });
  await h.emit("session_start", ctx);
  expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  await h.emit("agent_settled", ctx, { aborted: false });
  await h.emit("session_shutdown", ctx);
  expect(fetcher).not.toHaveBeenCalled();
  expect(h.unsubscribe).toHaveBeenCalledTimes(2);
});
it("releases an open menu on shutdown", async () => {
  const h = await setup();
  const ctx = h.context();
  await h.emit("session_start", ctx);
  const notifyCommand = h.commands.get("notify");
  assert.ok(notifyCommand);
  const command = notifyCommand.handler("", ctx as ExtensionCommandContext);
  await h.tui.waitForOpen();
  await h.emit("session_shutdown", ctx);
  await command;
  expect(h.tui.isOpen).toBe(false);
});
it("serializes concurrent menu openings across lazy import", async () => {
  const h = await setup();
  const ctx = h.context();
  await h.emit("session_start", ctx);
  const command = h.commands.get("notify");
  assert.ok(command);
  const first = command.handler("", ctx as ExtensionCommandContext);
  const second = command.handler("", ctx as ExtensionCommandContext);
  await h.tui.waitForOpen();
  await vi.waitFor(() => expect(h.notifyUI).toHaveBeenCalledWith("Notify menu is already open.", "info"), {
    interval: 1,
  });
  h.tui.press("ctrl+c");
  await Promise.all([first, second]);
  expect(h.tui.openCount).toBe(1);
  await h.emit("session_shutdown", ctx);
});
it("loads through Pi Jiti and exercises the lazy menu command and repeated cleanup", async () => {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [resolve("packages/pi-notify")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const extension = loader.getExtensions().extensions[0];
  assert.ok(extension);
  expect(extension.commands.has("notify")).toBe(true);
  const h = await setup();
  const ctx = h.context();
  const emit = async (name: string) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx);
  };
  await emit("session_start");
  const notifyCommand = extension.commands.get("notify");
  assert.ok(notifyCommand);
  const command = notifyCommand.handler("", ctx as ExtensionCommandContext);
  await h.tui.waitForOpen();
  expect(h.tui.render().join("\n")).toContain("Destinations");
  h.tui.press("ctrl+c");
  await command;
  await emit("session_shutdown");
  await emit("session_shutdown");
});
