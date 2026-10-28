import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Destination } from "../src/provider.js";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
let directory: string;
let originalAgentDir: string | undefined;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const token = `123:${"s".repeat(30)}`;
const webhookUrl = "https://hooks.slack.com/services/T01234567/B01234567/secretWebhookValue";
const teamsWebhookUrl =
  "https://tenant.example.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/workflow-123/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=synthetic-signature_123";
const lifecycleDestinations: Record<string, Destination> = {
  gotify: { provider: "gotify", label: "Gotify", serverUrl: "https://push.example.com", appToken: "A-token" },
  slack: { provider: "slack", label: "Slack", webhookUrl },
  ntfy: {
    provider: "ntfy",
    label: "ntfy",
    serverUrl: "https://ntfy.example/base",
    topic: "builds",
    accessToken: "ntfy-secret",
  },
  pushover: { provider: "pushover", label: "Pushover", appToken: "A".repeat(30), userKey: "U".repeat(30) },
  discord: {
    provider: "discord",
    label: "Discord",
    webhookUrl: "https://discord.com/api/webhooks/123456789012345678/DiscordSecret",
  },
  bark: { provider: "bark", label: "Bark", serverUrl: "https://bark.example/base", deviceKey: "bark-secret" },
  webhook: {
    provider: "webhook",
    label: "Generic webhook",
    webhookUrl: "https://webhook.example/SecretEndpoint",
    bearerToken: "webhook-secret",
  },
  teams: { provider: "teams", label: "Microsoft Teams notifications", webhookUrl: teamsWebhookUrl },
  line: {
    provider: "line",
    label: "LINE",
    channelAccessToken: "line-secret-token",
    recipientId: `U${"a".repeat(32)}`,
  },
};
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
it("delivers one settled work period to Telegram, Gotify, and Slack from the built-in registry", async () => {
  await enable();
  const path = join(directory, "pi-notify.json");
  const settings = JSON.parse(await fs.readFile(path, "utf8"));
  settings.destinations.gotify = {
    provider: "gotify",
    label: "Gotify",
    serverUrl: "https://push.example.com/base",
    appToken: "A-token",
  };
  settings.destinations.slack = { provider: "slack", label: "Slack", webhookUrl };
  settings.targetIds.push("gotify", "slack");
  await fs.writeFile(path, JSON.stringify(settings));
  fetcher.mockImplementation(
    async (url) =>
      new Response(
        url === webhookUrl
          ? "ok"
          : String(url).includes("push.example.com")
            ? JSON.stringify({ id: 1, appid: 1, message: "accepted", date: "2026-07-06T00:00:00Z" })
            : '{"ok":true,"result":{}}',
      ),
  );
  const h = await setup();
  const ctx = h.context("rpc");
  await h.emit("session_start", ctx);
  await h.emit("before_agent_start", ctx);
  await h.emit("agent_settled", ctx, { aborted: false });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3), { interval: 1 });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `https://api.telegram.org/bot${token}/sendMessage`,
    "https://push.example.com/base/message",
    webhookUrl,
  ]);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).message).toContain("Example");
  expect(
    JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)).blocks.some((block: { text: { text: string } }) =>
      block.text.text.includes("Example"),
    ),
  ).toBe(true);
  await h.emit("session_shutdown", ctx);
});
it.each(Object.keys(lifecycleDestinations))(
  "aborts %s delivery on session replacement and shutdown without stale warnings",
  async (provider) => {
    await fs.writeFile(
      join(directory, "pi-notify.json"),
      JSON.stringify({
        targetIds: ["one"],
        destinations: { one: lifecycleDestinations[provider] },
      }),
    );
    fetcher.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(JSON.stringify(lifecycleDestinations[provider]))),
            { once: true },
          );
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
  },
);
it("delivers one settled work period through mixed existing, LINE, and Teams providers", async () => {
  const ids = ["ntfy", "pushover", "discord", "bark", "webhook", "line", "teams"];
  await fs.writeFile(
    join(directory, "pi-notify.json"),
    JSON.stringify({
      targetIds: ids,
      destinations: Object.fromEntries(ids.map((id) => [id, lifecycleDestinations[id]])),
    }),
  );
  fetcher.mockImplementation(async (url) => {
    if (String(url).startsWith("https://ntfy.example"))
      return Response.json({ id: "event", time: 1, event: "message", topic: "builds", message: "accepted" });
    if (String(url).startsWith("https://api.pushover.net")) return Response.json({ status: 1 });
    if (String(url).startsWith("https://discord.com")) return Response.json({ id: "123", channel_id: "456", type: 0 });
    if (String(url).startsWith("https://bark.example")) return Response.json({ code: 200 });
    if (url === "https://api.line.me/v2/bot/message/push")
      return Response.json({ sentMessages: [{ id: "461230966842064897" }] });
    return new Response(null, { status: 202 });
  });
  const h = await setup();
  const ctx = h.context("rpc");
  await h.emit("session_start", ctx);
  await h.emit("before_agent_start", ctx);
  await h.emit("message_end", ctx, {
    message: { role: "assistant", stopReason: "stop", content: "private transcript" },
  });
  await h.emit("agent_settled", ctx, { aborted: false });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(ids.length), { interval: 1 });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://ntfy.example/base",
    "https://api.pushover.net/1/messages.json",
    "https://discord.com/api/webhooks/123456789012345678/DiscordSecret?wait=true",
    "https://bark.example/base/push",
    "https://webhook.example/SecretEndpoint",
    "https://api.line.me/v2/bot/message/push",
    teamsWebhookUrl,
  ]);
  const payloads = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  for (const payload of payloads) {
    expect(JSON.stringify(payload)).toContain("Example");
    expect(JSON.stringify(payload)).not.toContain("private transcript");
  }
  expect(payloads[2].allowed_mentions).toEqual({ parse: [] });
  expect(Object.keys(payloads[4])).toEqual(["id", "title", "body", "settledAt"]);
  expect(payloads[4].settledAt).toBeTypeOf("number");
  expect(payloads[5].to).toBe(`U${"a".repeat(32)}`);
  expect(payloads[5].messages).toMatchObject([{ type: "text" }]);
  expect(new Headers(fetcher.mock.calls[5]?.[1]?.headers).get("authorization")).toBe("Bearer line-secret-token");
  expect(payloads[6]).toMatchObject({
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard" } }],
  });
  expect(new Headers(fetcher.mock.calls[6]?.[1]?.headers).has("authorization")).toBe(false);
  expect(fetcher.mock.calls[6]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
  await h.emit("agent_settled", ctx, { aborted: false });
  expect(fetcher).toHaveBeenCalledTimes(ids.length);
  await h.emit("session_shutdown", ctx);
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
  const path = join(directory, "pi-notify.json");
  const settings = JSON.parse(await fs.readFile(path, "utf8"));
  settings.destinations.line = lifecycleDestinations.line;
  settings.destinations.teams = lifecycleDestinations.teams;
  settings.targetIds.push("line", "teams");
  await fs.writeFile(path, JSON.stringify(settings));
  fetcher.mockImplementation(async (url) =>
    url === teamsWebhookUrl
      ? new Response("Accepted", { status: 202 })
      : String(url).startsWith("https://api.telegram.org")
        ? Response.json({ ok: true, result: {} })
        : Response.json({ sentMessages: [{ id: "461230966842064897" }] }),
  );
  const h = await setup();
  const ctx = h.context(mode);
  await h.emit("session_start", ctx);
  await h.emit("before_agent_start", ctx);
  await h.emit("agent_settled", ctx, { aborted: false });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3), { interval: 1 });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `https://api.telegram.org/bot${token}/sendMessage`,
    "https://api.line.me/v2/bot/message/push",
    teamsWebhookUrl,
  ]);
  expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).has("authorization")).toBe(false);
  expect(h.tui.openCount).toBe(0);
  const command = h.commands.get("notify");
  assert.ok(command);
  if (mode === "rpc") {
    await command.handler("", ctx as ExtensionCommandContext);
    expect(h.notifyUI).toHaveBeenCalled();
  } else await expect(command.handler("", ctx as ExtensionCommandContext)).rejects.toThrow("requires TUI");
  await expect(command.handler("settings trailing", ctx as ExtensionCommandContext)).rejects.toThrow("Usage");
  expect(h.tui.openCount).toBe(0);
  expect(JSON.stringify(h.notifyUI.mock.calls)).not.toMatch(
    /line-secret|U[a-f0-9]{32}|tenant\.example|powerplatform|workflow-123|synthetic-signature|api-version|sig=/,
  );
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
