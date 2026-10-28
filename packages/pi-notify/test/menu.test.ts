import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import { showNotifyMenu } from "../src/menu.js";
import type { GotifyDestination, SlackDestination } from "../src/provider.js";
import { createGotifyProvider } from "../src/providers/gotify.js";
import { createSlackProvider } from "../src/providers/slack.js";
import { createTelegramProvider } from "../src/providers/telegram.js";
import { providers } from "../src/providers.js";
import { SettingsStore, saveDestination, savePolicy } from "../src/settings.js";

let directory: string;
let store: SettingsStore;
let owner: AbortController;
let coordinator: Coordinator;
const token = `123:${"s".repeat(30)}`;
const gotifyToken = "gotify-application-secret";
const webhookUrl = "https://hooks.slack.com/services/T01234567/B01234567/secretWebhookValue";
const slackDestination = (): SlackDestination => ({ provider: "slack", label: "Slack notifications", webhookUrl });
const gotifyDestination = (): GotifyDestination => ({
  provider: "gotify",
  label: "Server",
  serverUrl: "https://notify.example/gotify",
  appToken: gotifyToken,
});
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-notify-menu-"));
  store = new SettingsStore(join(directory, "pi-notify.json"), join(directory, "project", "pi-notify.json"), providers);
  initTheme("dark", false);
  owner = new AbortController();
  await store.load();
  coordinator = new Coordinator(store.snapshot.effective, providers, true);
});
afterEach(async () => {
  owner.abort();
  await coordinator.close();
  await store.flush();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
function harness(remap = false) {
  const theme = { fg: vi.fn((_role: string, value: string) => value), bold: (value: string) => value };
  const keybindings = new KeybindingsManager(
    TUI_KEYBINDINGS,
    remap
      ? {
          "tui.select.down": "ctrl+n",
          "tui.select.up": "ctrl+p",
          "tui.select.cancel": "ctrl+q",
        }
      : {},
  );
  const tui = createTuiHarness({ width: 72, rows: 24, theme, keybindings });
  const notify = vi.fn();
  const zeroFrames: string[][] = [];
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      zeroFrames.push(component.render(0));
      return component;
    }, options);
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: directory,
    sessionManager: { getSessionId: () => "session", getSessionName: () => "Test" },
    ui: { custom, notify },
  } as unknown as ExtensionCommandContext;
  const run = () =>
    showNotifyMenu(ctx, {
      store,
      coordinator,
      providers,
      signal: owner.signal,
      isCurrent: () => !owner.signal.aborted,
    });
  const transition = async (perform: () => unknown) => {
    const count = tui.openCount;
    perform();
    await vi.waitFor(
      () => {
        expect(tui.openCount).toBeGreaterThan(count);
        expect(tui.isOpen).toBe(true);
      },
      { interval: 1 },
    );
  };
  const down = () => (remap ? tui.send("\x0e") : tui.press("tui.select.down"));
  const choose = async (index: number) => {
    tui.press("home");
    for (let n = 0; n < index; n++) down();
    await transition(() => tui.press("tui.select.confirm"));
  };
  return { tui, ctx, notify, run, choose, transition, theme, zeroFrames, down };
}
it("frames main/settings/detail screens, bounds sizes, and uses callback theme", async () => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  h.tui.render();
  expect(h.theme.fg.mock.calls.some(([role]) => role === "border")).toBe(true);
  expect(h.tui.render()[0]).toMatch(/^─+$/);
  expect(h.tui.render().at(-1)).toMatch(/^─+$/);
  await h.choose(2);
  expect(h.tui.render().join("\n")).toContain("Notify Settings");
  expect(h.zeroFrames.every((frame) => frame.every((line) => visibleWidth(line) === 0))).toBe(true);
  for (const width of [1, 8, 40])
    for (const rows of [4, 7, 24]) {
      const frame = h.tui.resize({ width, rows });
      expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  h.tui.resize({ width: 72, rows: 24 });
  h.tui.invalidate();
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.choose(3);
  expect(h.tui.render().join("\n")).toContain("Notify Status");
  h.tui.press("ctrl+c");
  await running;
});
it("saves settings immediately without losing cursor; restores values after failure", async () => {
  await savePolicy(store, "user", "enabled", false, owner.signal);
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  h.down();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.effective.enabled).toBe(true);
  expect(h.tui.render().join("\n")).toMatch(/Automatic notifications.*On/);
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error(token));
  h.tui.press("tui.select.confirm");
  await h.tui.waitForPending();
  expect(store.snapshot.effective.enabled).toBe(true);
  expect(h.tui.render().join("\n")).toMatch(/Automatic notifications.*On/);
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain(token);
  h.tui.press("ctrl+c");
  await running;
});
it("changes mode and custom inactivity time through the same settings flow", async () => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  h.tui.press("tui.select.down");
  h.tui.press("tui.select.down");
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.effective.mode).toBe("after-inactivity");
  h.tui.press("tui.select.down");
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await h.choose(3);
  h.tui.send("\x15");
  h.tui.type("0");
  h.tui.press("tui.input.submit");
  await h.tui.waitForPending();
  expect(store.snapshot.effective.inactivitySeconds).toBe(30);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~90\x1b[201~");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(store.snapshot.effective.inactivitySeconds).toBe(90);
  h.tui.press("ctrl+c");
  await running;
});
it("keeps setup transactional, masked, and cancellable with remapped keys", async () => {
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0); // Add destination…
  await h.choose(0); // Telegram
  h.tui.send(`\x1b[200~${token}\x1b[201~`);
  expect(h.tui.render().join("\n")).not.toContain(token);
  expect(h.tui.isFocusable).toBe(true);
  h.tui.setFocused(true);
  expect(h.tui.focused).toBe(true);
  h.tui.press("ctrl+c");
  await running;
  expect(await fs.readdir(directory)).toEqual([]);
});
it.each(["use", "save only"])(
  "configures Telegram with paste/editing and confirms selection: %s",
  async (selection) => {
    const h = harness();
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose(0);
    await h.choose(0); // Add destination…
    await h.choose(0); // Telegram
    h.tui.send(`\x1b[200~${token}\x1b[201~`);
    await h.transition(() => h.tui.press("tui.input.submit"));
    expect(h.tui.render().join("\n")).toContain("Telegram chat ID");
    h.tui.send("\x1b[200~-10012X\x1b[201~");
    h.tui.send("\x7f");
    h.tui.type("3");
    await h.transition(() => h.tui.press("tui.input.submit"));
    expect(h.tui.render().join("\n")).toContain("Review Telegram destination");
    expect(h.tui.render().join("\n")).toContain("Telegram -100123");
    expect(h.tui.render().join("\n")).not.toContain(token);
    expect(await fs.readdir(directory)).toEqual([]);
    expect(h.tui.render().join("\n")).toContain("Use this destination for notifications?");
    await h.choose(selection === "use" ? 0 : 5);
    expect(Object.values(store.snapshot.effective.destinations)[0]).toMatchObject({
      provider: "telegram",
      label: "Telegram -100123",
      chatId: "-100123",
    });
    const destination = Object.values(store.snapshot.effective.destinations)[0];
    if (destination?.provider !== "telegram") throw new Error("Missing Telegram destination");
    expect(destination.messageThreadId).toBeUndefined();
    expect(store.snapshot.effective.targetIds).toEqual(
      selection === "use" ? Object.keys(store.snapshot.effective.destinations) : [],
    );
    expect(store.snapshot.effective.enabled).toBe(true);
    h.tui.press("ctrl+c");
    await running;
  },
);
it("edits optional fields from review without changing saved settings before confirmation", async () => {
  const original = {
    provider: "telegram" as const,
    label: "Personal",
    botToken: token,
    chatId: "123",
    messageThreadId: 42,
  };
  await saveDestination(store, "one", original, owner.signal);
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  await h.choose(0);
  expect(h.tui.render().join("\n")).toContain("Review Telegram destination");
  expect(h.tui.render().join("\n")).toContain("Topic: 42");
  await h.choose(2);
  h.tui.send("\x15");
  h.tui.type("456");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Personal");
  await h.choose(3);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~WorkX\x1b[201~");
  h.tui.send("\x7f");
  await h.transition(() => h.tui.press("tui.input.submit"));
  await h.choose(4);
  h.tui.send("\x15");
  h.tui.type("0");
  h.tui.press("tui.input.submit");
  await h.tui.waitForPending();
  expect(store.snapshot.effective.destinations.one).toEqual(original);
  h.tui.send("\x15");
  h.tui.type("99");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Topic: 99");
  expect(h.tui.render().join("\n")).not.toContain(token);
  expect(store.snapshot.effective.destinations.one).toEqual(original);
  await h.choose(0);
  expect(store.snapshot.effective.destinations.one).toEqual({
    ...original,
    label: "Work",
    chatId: "456",
    messageThreadId: 99,
  });
  h.tui.press("ctrl+c");
  await running;
});
it.each(["cancel", "save"])("clears an optional topic only on save: %s", async (completion) => {
  const original = {
    provider: "telegram" as const,
    label: "Personal",
    botToken: token,
    chatId: "123",
    messageThreadId: 42,
  };
  await saveDestination(store, "one", original, owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  await h.choose(0);
  await h.choose(4);
  h.tui.send("\x15");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Topic: none");
  expect(store.snapshot.effective.destinations.one).toEqual(original);
  if (completion === "save") await h.choose(0);
  h.tui.press("ctrl+c");
  await running;
  const destination = store.snapshot.effective.destinations.one;
  if (destination?.provider !== "telegram") throw new Error("Missing Telegram destination");
  expect(destination.messageThreadId).toBe(completion === "save" ? undefined : 42);
});
it("selects destinations immediately and restores project inheritance", async () => {
  await saveDestination(
    store,
    "one",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  await savePolicy(store, "user", "targetIds", ["one"], owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  await h.transition(() => h.tui.press("tui.select.confirm")); // User -> Project
  for (let n = 0; n < 4; n++) h.tui.press("tui.select.down");
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.project.targetIds).toEqual([]);
  await h.choose(1);
  expect(store.snapshot.project).not.toHaveProperty("targetIds");
  expect(store.snapshot.effective.targetIds).toEqual(["one"]);
  h.tui.press("ctrl+c");
  await running;
});
it("previews literal text without rich rendering and sends the same text only after confirmation", async () => {
  await saveDestination(
    store,
    "one",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true,"result":{}}'));
  const provider = providers.get("telegram");
  if (!provider) throw new Error("Missing Telegram provider");
  vi.spyOn(provider, "send").mockImplementation(createTelegramProvider(fetcher).send);
  const sending = vi.spyOn(coordinator, "send");
  const h = harness();
  vi.spyOn(h.ctx.sessionManager, "getSessionName").mockReturnValue("😀中文e\u0301 <b>_literal_</b>\x1b[31m@person");
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(1);
  await h.choose(0);
  const preview = h.tui.resize({ width: 512, rows: 50 }).join("\n");
  const sentBeforeConfirmation = fetcher.mock.calls.length;
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await vi.waitFor(() => expect(sending).toHaveBeenCalledTimes(1), { interval: 1 });
  await vi.waitFor(() => expect(h.tui.render().join("\n")).toContain("Destinations"), { interval: 1 });
  h.tui.press("ctrl+c");
  await running;
  expect(sentBeforeConfirmation).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(preview).toContain(payload.text);
  expect(preview).toContain("Session: 😀中文e\u0301 <b>_literal_</b>＠person (session)");
  expect(payload.text).toMatch(/^Pi notification test\nComputer:/);
  expect(payload.entities[0]).toEqual({ type: "bold", offset: 0, length: "Pi notification test".length });
  expect(
    payload.entities
      .slice(1)
      .map((entity: { offset: number; length: number }) =>
        payload.text.slice(entity.offset, entity.offset + entity.length),
      ),
  ).toEqual(["session", directory]);
  expect(preview).not.toContain(token);
  expect(payload.text).not.toContain(token);
  expect(payload).not.toHaveProperty("parse_mode");
  expect(payload.text).not.toContain("\x1b");
});
it("edits User selection independently from an active Project override", async () => {
  await saveDestination(
    store,
    "one",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  await savePolicy(store, "user", "targetIds", ["one"], owner.signal);
  await savePolicy(store, "project", "targetIds", [], owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  for (let n = 0; n < 4; n++) h.down();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(h.tui.render().join("\n")).toMatch(/\[x\].*Personal/);
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.user.targetIds).toEqual([]);
  expect(store.snapshot.project.targetIds).toEqual([]);
  h.tui.press("ctrl+c");
  await running;
});
it.each(["use", "save only"])("adds a masked Gotify destination transactionally: %s", async (selection) => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0); // Add destination…
  await h.choose(1); // Gotify
  expect(h.tui.render().join("\n")).toContain("Gotify application token");
  h.tui.send(`\x1b[200~${gotifyToken}X\x1b[201~`);
  h.tui.send("\x7f");
  expect(h.tui.render().join("\n")).not.toContain(gotifyToken);
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Gotify server URL");
  const invalidUrl = `https://user:${gotifyToken}@notify.example/?token=${gotifyToken}`;
  h.tui.type(invalidUrl);
  h.tui.press("tui.input.submit");
  await h.tui.waitForPending();
  expect(store.snapshot.effective.destinations).toEqual({});
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain(gotifyToken);
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain(invalidUrl);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~https://NOTIFY.example/gotify///\x1b[201~");
  await h.transition(() => h.tui.press("tui.input.submit"));
  const review = h.tui.resize({ width: 120, rows: 40 }).join("\n");
  expect(review).toContain("Review Gotify destination");
  expect(review).toContain("Server: https://notify.example/gotify");
  expect(review).toContain("Priority: server default");
  expect(review).toContain("Application token: configured (hidden)");
  expect(review).not.toContain(gotifyToken);
  expect(review).not.toContain("chat ID");
  expect(await fs.readdir(directory)).toEqual([]);
  await h.choose(selection === "use" ? 0 : 5);
  const [id, destination] = Object.entries(store.snapshot.effective.destinations)[0] ?? [];
  expect(destination).toEqual({
    ...gotifyDestination(),
    label: "Gotify https://notify.example/gotify",
    priority: undefined,
  });
  expect(store.snapshot.effective.targetIds).toEqual(selection === "use" ? [id] : []);
  h.tui.press("ctrl+c");
  await running;
});
it("edits Gotify fields without switching provider or publishing before confirmation", async () => {
  const original = { ...gotifyDestination(), priority: 0 };
  await saveDestination(store, "server", original, owner.signal, false);
  await savePolicy(store, "user", "enabled", false, owner.signal);
  await savePolicy(store, "project", "targetIds", [], owner.signal);
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  expect(h.tui.render().join("\n")).toContain("Gotify destination");
  await h.choose(0);
  expect(h.tui.render().join("\n")).toContain("Priority: 0");
  await h.choose(1);
  const replacement = "replacement-application-secret";
  h.tui.send(`\x1b[200~${replacement}\x1b[201~`);
  expect(h.tui.render().join("\n")).not.toContain(replacement);
  await h.transition(() => h.tui.press("tui.input.submit"));
  await h.choose(2);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~https://OTHER.example/proxy/\x1b[201~");
  await h.transition(() => h.tui.press("tui.input.submit"));
  await h.choose(3);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~WorkX\x1b[201~");
  h.tui.send("\x7f");
  await h.transition(() => h.tui.press("tui.input.submit"));
  await h.choose(4);
  for (const invalid of ["1.5", "9007199254740992", "NaN", "1e3"]) {
    h.tui.send("\x15");
    h.tui.type(invalid);
    h.tui.press("tui.input.submit");
    await h.tui.waitForPending();
    expect(store.snapshot.effective.destinations.server).toEqual(original);
    expect(h.tui.render().join("\n")).toContain("Gotify priority");
  }
  h.tui.send("\x15");
  h.tui.type("-2");
  await h.transition(() => h.tui.press("tui.input.submit"));
  const review = h.tui.resize({ width: 120, rows: 40 }).join("\n");
  expect(review).toContain("Priority: -2");
  expect(review).toContain("Save keeps your current notification selection.");
  expect(review).not.toContain("Telegram");
  expect(review).not.toContain(gotifyToken);
  expect(review).not.toContain(replacement);
  expect(store.snapshot.effective.destinations.server).toEqual(original);
  await h.choose(0);
  expect(store.snapshot.effective.destinations.server).toEqual({
    provider: "gotify",
    label: "Work",
    serverUrl: "https://other.example/proxy",
    appToken: replacement,
    priority: -2,
  });
  expect(store.snapshot.effective.enabled).toBe(false);
  expect(store.snapshot.user.targetIds ?? []).toEqual([]);
  expect(store.snapshot.project.targetIds).toEqual([]);
  h.tui.press("ctrl+c");
  await running;
});
it.each(["cancel", "save"])("clears an optional Gotify priority only on save: %s", async (completion) => {
  const original = { ...gotifyDestination(), priority: 0 };
  await saveDestination(store, "server", original, owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  await h.choose(0);
  await h.choose(4);
  h.tui.send("\x15");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Priority: server default");
  expect(store.snapshot.effective.destinations.server).toEqual(original);
  if (completion === "save") await h.choose(0);
  h.tui.press("ctrl+c");
  await running;
  const destination = store.snapshot.effective.destinations.server;
  if (destination?.provider !== "gotify") throw new Error("Missing Gotify destination");
  expect(destination.priority).toBe(completion === "save" ? undefined : 0);
  const saved = JSON.parse(await fs.readFile(store.userPath, "utf8"));
  if (completion === "save") expect(saved.destinations.server).not.toHaveProperty("priority");
  else expect(saved.destinations.server.priority).toBe(0);
});
it.each(["token", "serverUrl", "review"])("cancels Gotify setup at %s without saving", async (stage) => {
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0); // Add destination…
  await h.choose(1); // Gotify
  h.tui.send(`\x1b[200~${gotifyToken}\x1b[201~`);
  expect(h.tui.render().join("\n")).not.toContain(gotifyToken);
  if (stage !== "token") {
    await h.transition(() => h.tui.press("tui.input.submit"));
    h.tui.type("https://notify.example/gotify");
    if (stage === "review") await h.transition(() => h.tui.press("tui.input.submit"));
  }
  h.tui.press("ctrl+c");
  await running;
  expect(h.tui.isOpen).toBe(false);
  expect(store.snapshot.effective.destinations).toEqual({});
  expect(await fs.readdir(directory)).toEqual([]);
});
it("shows mixed destinations and sends a confirmed preview only through Gotify", async () => {
  await saveDestination(
    store,
    "telegram",
    { provider: "telegram", label: "Personal", botToken: token, chatId: "123" },
    owner.signal,
  );
  await saveDestination(store, "server", gotifyDestination(), owner.signal);
  const telegram = providers.get("telegram");
  const gotify = providers.get("gotify");
  if (!telegram || !gotify) throw new Error("Missing notification provider");
  const telegramSend = vi.spyOn(telegram, "send");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: 1, appid: 2, message: "test", date: "2026-01-01T00:00:00Z" })),
    );
  vi.spyOn(gotify, "send").mockImplementation(createGotifyProvider(fetcher).send);
  const sending = vi.spyOn(coordinator, "send");
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  h.tui.resize({ width: 160, rows: 40 });
  await h.choose(0);
  const destinations = h.tui.render().join("\n");
  expect(destinations).toContain("Telegram · 123 · token configured");
  expect(destinations).toContain("Gotify · https://notify.example/gotify · token configured");
  expect(destinations.match(/Add destination…/g)).toHaveLength(1);
  expect(destinations).not.toContain("Add Telegram destination");
  expect(destinations).not.toContain("Add Gotify destination");
  await h.choose(2); // Shared add action follows the two saved destinations.
  const addDestinations = h.tui.render().join("\n");
  expect(addDestinations).toContain("Add destination · User");
  expect(addDestinations).toContain("Add Telegram destination");
  expect(addDestinations).toContain("Add Gotify destination");
  await h.transition(() => h.tui.press("tui.select.cancel"));
  expect(destinations).not.toContain(gotifyToken);
  expect(destinations).not.toContain(token);
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.choose(2);
  for (let n = 0; n < 4; n++) h.down();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(h.tui.render().join("\n")).toMatch(/\[x\].*Personal/);
  expect(h.tui.render().join("\n")).toMatch(/\[x\].*Server/);
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.choose(3);
  expect(h.tui.render().join("\n")).toContain("Gotify · https://notify.example/gotify");
  expect(h.tui.render().join("\n")).not.toContain(gotifyToken);
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.choose(1);
  await h.choose(1);
  const preview = h.tui.resize({ width: 512, rows: 50 }).join("\n");
  expect(preview).toContain("Send test to Gotify");
  expect(preview).not.toContain(gotifyToken);
  expect(fetcher).not.toHaveBeenCalled();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith("Gotify accepted the test notification.", "info"), {
    interval: 1,
  });
  h.tui.press("ctrl+c");
  await running;
  expect(telegramSend).not.toHaveBeenCalled();
  expect(sending).toHaveBeenCalledWith(
    "server",
    expect.objectContaining({ provider: "gotify" }),
    expect.anything(),
    expect.anything(),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://notify.example/gotify/message");
  const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(preview).toContain(`${payload.title}\n${payload.message}`);
  expect(payload).not.toHaveProperty("priority");
  expect(JSON.stringify(payload)).not.toContain(gotifyToken);
});
it("redacts raw delivery errors from Gotify test notices", async () => {
  await saveDestination(store, "server", gotifyDestination(), owner.signal);
  vi.spyOn(coordinator, "send").mockRejectedValue(new Error(`https://user:${gotifyToken}@notify.example`));
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(1);
  await h.choose(0);
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await vi.waitFor(() => expect(h.notify).toHaveBeenCalled(), { interval: 1 });
  await vi.waitFor(() => expect(h.tui.render().join("\n")).toContain("Destinations"), { interval: 1 });
  h.tui.press("ctrl+c");
  await running;
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain(gotifyToken);
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain("https://user:");
});
it("keeps destinations named add and addGotify distinct from the shared add action", async () => {
  await saveDestination(
    store,
    "add",
    { provider: "telegram", label: "Saved Telegram", botToken: token, chatId: "123" },
    owner.signal,
  );
  await saveDestination(store, "addGotify", { ...gotifyDestination(), label: "Saved Gotify" }, owner.signal);
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  expect(h.tui.render().join("\n")).toContain("Label: Saved Telegram");
  await h.transition(() => h.tui.send("\x11"));
  await h.choose(1);
  expect(h.tui.render().join("\n")).toContain("Label: Saved Gotify");
  await h.transition(() => h.tui.send("\x11"));
  await h.choose(2); // add:destination cannot be shadowed by either saved ID.
  expect(h.tui.render().join("\n")).toContain("Add destination · User");
  await h.choose(0); // Telegram
  expect(h.tui.render().join("\n")).toContain("Telegram bot token");
  h.tui.type(token);
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Telegram chat ID");
  await h.transition(() => h.tui.send("\x11"));
  expect(h.tui.render().join("\n")).toContain("Add destination · User");
  await h.choose(1); // Gotify on the shared provider selector.
  expect(h.tui.render().join("\n")).toContain("Gotify application token");
  h.tui.type(gotifyToken);
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(h.tui.render().join("\n")).toContain("Gotify server URL");
  h.tui.press("ctrl+c");
  await running;
  expect(Object.keys(store.snapshot.effective.destinations)).toEqual(["add", "addGotify"]);
});
it("keeps the Project inheritance action distinct from a destination named inherit", async () => {
  await saveDestination(store, "inherit", gotifyDestination(), owner.signal);
  await savePolicy(store, "project", "targetIds", [], owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(2);
  await h.transition(() => h.tui.press("tui.select.confirm"));
  for (let n = 0; n < 4; n++) h.down();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await h.choose(1);
  expect(store.snapshot.project).not.toHaveProperty("targetIds");
  expect(store.snapshot.effective.targetIds).toEqual(["inherit"]);
  expect(h.tui.render().join("\n")).toMatch(/\[x\].*Server/);
  h.tui.press("tui.select.up");
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.project.targetIds).toEqual([]);
  expect(store.snapshot.effective.targetIds).toEqual([]);
  h.tui.press("ctrl+c");
  await running;
});
it.each(["gotify", "slack"])(
  "renders %s review through RPC without exposing secrets or using custom UI",
  async (provider) => {
    const destination = provider === "gotify" ? gotifyDestination() : slackDestination();
    await saveDestination(store, "server", destination, owner.signal);
    const routes = ["Destinations", destination.label, "Edit destination", "Back", "Back", "Back", "Done"];
    const titles: string[] = [];
    const select = vi.fn(async (title: string, choices: string[]) => {
      titles.push(title);
      const route = routes.shift();
      return choices.find((choice) => choice.startsWith(route ?? "missing route"));
    });
    const custom = vi.fn();
    const ctx = {
      mode: "rpc",
      hasUI: true,
      ui: { select, custom, notify: vi.fn() },
    } as unknown as ExtensionCommandContext;
    await showNotifyMenu(ctx, {
      store,
      coordinator,
      providers,
      signal: owner.signal,
      isCurrent: () => !owner.signal.aborted,
    });
    expect(custom).not.toHaveBeenCalled();
    expect(routes).toEqual([]);
    expect(titles.join("\n")).toContain(`Review ${provider === "gotify" ? "Gotify" : "Slack"} destination · User`);
    expect(titles.join("\n")).toContain(
      provider === "gotify" ? "Application token: configured (hidden)" : "Webhook URL: configured (hidden)",
    );
    if (provider === "gotify") expect(titles.join("\n")).toContain("Server: https://notify.example/gotify");
    expect(titles.join("\n")).not.toContain(gotifyToken);
    expect(titles.join("\n")).not.toContain(webhookUrl);
  },
);
it.each(
  ["telegram", "gotify", "slack"].flatMap((provider) =>
    ["ctrl+c", "dispose", "replace"].map((cause) => [provider, cause]),
  ),
)("cancels an active %s test request on %s and drains the loader", async (provider, cause) => {
  await saveDestination(
    store,
    "one",
    provider === "telegram"
      ? { provider: "telegram", label: "Personal", botToken: token, chatId: "123" }
      : provider === "gotify"
        ? gotifyDestination()
        : slackDestination(),
    owner.signal,
  );
  let requestSignal: AbortSignal | undefined;
  vi.spyOn(coordinator, "send").mockImplementation(
    async (_id, _destination, _notification, signal) =>
      new Promise((resolve) => {
        requestSignal = signal;
        signal?.addEventListener("abort", () => resolve({ state: "cancelled", code: "cancelled" }), { once: true });
      }),
  );
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(1);
  await h.choose(0);
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await vi.waitFor(() => expect(requestSignal).toBeDefined(), { interval: 1 });
  if (cause === "dispose") {
    await h.transition(() => h.tui.dispose());
    expect(requestSignal?.aborted).toBe(true);
    expect(h.notify).not.toHaveBeenCalled();
    h.tui.press("ctrl+c");
  } else if (cause === "replace") owner.abort();
  else h.tui.press("ctrl+c");
  await running;
  expect(requestSignal?.aborted).toBe(true);
  expect(h.tui.isOpen).toBe(false);
});
it.each([`${webhookUrl} `, `${webhookUrl}?secret=invalid`])(
  "rejects invalid Slack setup without exposing input: %s",
  async (value) => {
    const h = harness(true);
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose(0);
    await h.choose(0); // Add destination…
    await h.choose(2); // Slack
    h.tui.send(`\x1b[200~${value}\x1b[201~`);
    await h.transition(() => h.tui.press("tui.input.submit"));
    expect(h.tui.render().join("\n")).toContain("Add destination · User");
    expect(h.tui.render().join("\n")).not.toContain(webhookUrl);
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain(webhookUrl);
    expect(store.snapshot.effective.destinations).toEqual({});
    h.tui.press("ctrl+c");
    await running;
    expect(await fs.readdir(directory)).toEqual([]);
  },
);
it.each(["use", "save only"])("adds a masked Slack destination with explicit selection: %s", async (selection) => {
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0); // Add destination…
  await h.choose(2); // Slack
  expect(h.tui.render().join("\n")).toContain("Slack webhook URL");
  h.tui.send(`\x1b[200~${webhookUrl}X\x1b[201~`);
  h.tui.send("\x7f");
  expect(h.tui.render().join("\n")).not.toContain(webhookUrl);
  await h.transition(() => h.tui.press("tui.input.submit"));
  const review = h.tui.resize({ width: 120, rows: 40 }).join("\n");
  expect(review).toContain("Review Slack destination");
  expect(review).toContain("Label: Slack notifications");
  expect(review).toContain("Webhook URL: configured (hidden)");
  expect(review).not.toMatch(/hooks\.slack|secretWebhook|priority|chat ID|application token/);
  expect(await fs.readdir(directory)).toEqual([]);
  await h.choose(selection === "use" ? 0 : 3);
  const [id, destination] = Object.entries(store.snapshot.effective.destinations)[0] ?? [];
  expect(destination).toEqual(slackDestination());
  expect(store.snapshot.effective.targetIds).toEqual(selection === "use" ? [id] : []);
  h.tui.press("ctrl+c");
  await running;
});
it.each(["cancel", "save"])("edits Slack transactionally and preserves selection: %s", async (completion) => {
  await saveDestination(store, "slack", slackDestination(), owner.signal, false);
  await savePolicy(store, "user", "enabled", false, owner.signal);
  await savePolicy(store, "project", "targetIds", [], owner.signal);
  const original = await fs.readFile(store.userPath, "utf8");
  const replacement = webhookUrl.replace("secretWebhookValue", "replacementSecret");
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  await h.choose(0);
  await h.choose(1);
  h.tui.send(`\x1b[200~${webhookUrl}?secret=invalid\x1b[201~`);
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(store.snapshot.effective.destinations.slack).toEqual(slackDestination());
  await h.choose(1);
  h.tui.send(`\x1b[200~${replacement}\x1b[201~`);
  expect(h.tui.render().join("\n")).not.toContain(replacement);
  await h.transition(() => h.tui.press("tui.input.submit"));
  await h.choose(2);
  h.tui.send("\x15");
  h.tui.send("\x1b[200~WorkX\x1b[201~");
  h.tui.send("\x7f");
  await h.transition(() => h.tui.press("tui.input.submit"));
  expect(await fs.readFile(store.userPath, "utf8")).toBe(original);
  const review = h.tui.resize({ width: 120, rows: 40 }).join("\n");
  expect(review).toContain("Label: Work");
  expect(review).toContain("Save keeps your current notification selection.");
  expect(review).not.toMatch(/hooks\.slack|replacementSecret|secretWebhook/);
  if (completion === "save") {
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error(replacement));
    h.tui.press("home");
    await h.transition(() => h.tui.press("tui.select.confirm"));
    expect(await fs.readFile(store.userPath, "utf8")).toBe(original);
    expect(store.snapshot.effective.destinations.slack).toEqual(slackDestination());
    await h.choose(0);
  }
  h.tui.press("ctrl+c");
  await running;
  expect(store.snapshot.effective.destinations.slack).toEqual(
    completion === "save" ? { provider: "slack", label: "Work", webhookUrl: replacement } : slackDestination(),
  );
  expect(store.snapshot.effective.enabled).toBe(false);
  expect(store.snapshot.user.targetIds ?? []).toEqual([]);
  expect(store.snapshot.project.targetIds).toEqual([]);
  expect(JSON.stringify(h.notify.mock.calls)).not.toMatch(/hooks\.slack|replacementSecret|secretWebhook/);
});
it.each(["secret", "review", "dispose", "replace"])("cancels Slack setup at %s without saving", async (stage) => {
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0); // Add destination…
  await h.choose(2); // Slack
  h.tui.send(`\x1b[200~${webhookUrl}\x1b[201~`);
  if (stage === "review") await h.transition(() => h.tui.press("tui.input.submit"));
  if (stage === "dispose") {
    await h.transition(() => h.tui.dispose());
    expect(h.tui.render().join("\n")).toContain("Add destination · User");
    h.tui.press("ctrl+c");
  } else if (stage === "replace") owner.abort();
  else h.tui.press("ctrl+c");
  await running;
  expect(h.tui.isOpen).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
});
it("redacts Slack routing, previews metadata, and sends only after confirmation", async () => {
  await saveDestination(store, "addSlack", slackDestination(), owner.signal);
  const provider = providers.get("slack");
  if (!provider) throw new Error("Missing Slack provider");
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok"));
  vi.spyOn(provider, "send").mockImplementation(createSlackProvider(fetcher).send);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  expect(h.tui.render().join("\n")).toContain("Slack · webhook configured");
  await h.choose(0); // Saved ID addSlack does not invoke the add action.
  expect(h.tui.render().join("\n")).toContain("Slack destination · User");
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.choose(3);
  expect(h.tui.render().join("\n")).toContain("Slack · webhook configured");
  expect(h.tui.render().join("\n")).not.toContain(webhookUrl);
  await h.transition(() => h.tui.press("tui.select.cancel"));
  await h.choose(1);
  await h.choose(0);
  const preview = h.tui.resize({ width: 512, rows: 50 }).join("\n");
  expect(preview).toContain("Send test to Slack");
  expect(preview).not.toContain(webhookUrl);
  expect(fetcher).not.toHaveBeenCalled();
  await h.transition(() => h.tui.press("tui.select.confirm"));
  await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith("Slack accepted the test notification.", "info"), {
    interval: 1,
  });
  h.tui.press("ctrl+c");
  await running;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(webhookUrl);
  const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(
    payload.blocks.every(
      (block: { text: { type: string; text: string } }) =>
        block.text.type === "plain_text" && preview.includes(block.text.text),
    ),
  ).toBe(true);
  expect(JSON.stringify(payload)).not.toContain(webhookUrl);
});
it("removes Slack only after confirmation and blocks current Project selections", async () => {
  await saveDestination(store, "slack", slackDestination(), owner.signal);
  await savePolicy(store, "project", "targetIds", ["slack"], owner.signal);
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose(0);
  await h.choose(0);
  await h.choose(1);
  expect(store.snapshot.effective.destinations.slack).toEqual(slackDestination());
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(store.snapshot.effective.destinations.slack).toEqual(slackDestination());
  await savePolicy(store, "project", "targetIds", [], owner.signal);
  await h.choose(0);
  expect(store.snapshot.effective.destinations).toEqual({});
  expect(store.snapshot.user.targetIds).toEqual([]);
  h.tui.press("ctrl+c");
  await running;
});
it.each(["abort", "dispose"])("releases the menu on %s", async (cause) => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  if (cause === "abort") owner.abort();
  else h.tui.dispose();
  await running;
  expect(h.tui.isOpen).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
});
