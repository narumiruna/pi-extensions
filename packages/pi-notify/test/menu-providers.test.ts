import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import { destinationDescription, destinationLines } from "../src/destination-ui.js";
import { showNotifyMenu } from "../src/menu.js";
import type { Destination } from "../src/provider.js";
import { providers } from "../src/providers.js";
import { SettingsStore, saveDestination } from "../src/settings.js";

let directory: string;
let store: SettingsStore;
let owner: AbortController;
let coordinator: Coordinator;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-notify-providers-menu-"));
  store = new SettingsStore(join(directory, "pi-notify.json"), undefined, providers);
  await store.load();
  owner = new AbortController();
  coordinator = new Coordinator(store.snapshot.effective, providers, true);
  initTheme("dark", false);
});
afterEach(async () => {
  owner.abort();
  await coordinator.close();
  await store.flush();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
function harness(remap = false) {
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
  const theme = { fg: vi.fn((_role: string, text: string) => text), bold: (text: string) => text };
  const tui = createTuiHarness({ width: 100, rows: 40, keybindings, theme });
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
  const text = () => tui.render().join("\n");
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
  const choose = async (label: string) => {
    tui.press("home");
    for (let i = 0; i < 40; i++) {
      if (
        text()
          .split("\n")
          .some((line) => line.includes(`→ ${label}`))
      ) {
        await transition(() => tui.press("tui.select.confirm"));
        return;
      }
      if (remap) tui.send("\x0e");
      else tui.press("tui.select.down");
    }
    throw new Error(`Menu item not found: ${label}\n${text()}`);
  };
  const input = async (value: string, masked = false) => {
    tui.send("\x15");
    tui.send(`\x1b[200~${value}\x1b[201~`);
    if (masked) {
      expect(text()).not.toContain(value);
      for (const secret of secrets) expect(text()).not.toContain(secret);
    }
    await transition(() => tui.press("tui.input.submit"));
  };
  const run = () =>
    showNotifyMenu(ctx, {
      store,
      coordinator,
      providers,
      signal: owner.signal,
      isCurrent: () => !owner.signal.aborted,
    });
  return { tui, text, choose, input, transition, run, notify, theme, zeroFrames };
}

const teamsWebhookUrl =
  "https://tenant.example.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/workflow-123/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=synthetic-signature_123";
const replacementTeamsWebhookUrl = teamsWebhookUrl
  .replace("workflow-123", "workflow-456")
  .replace("synthetic-signature_123", "new-synthetic-signature");
const examples: Destination[] = [
  { provider: "ntfy", label: "ntfy notifications", serverUrl: "https://ntfy.sh/", topic: "private-topic" },
  { provider: "pushover", label: "Pushover notifications", appToken: "a".repeat(30), userKey: "u".repeat(30) },
  {
    provider: "discord",
    label: "Discord notifications",
    webhookUrl: "https://discord.com/api/webhooks/123/secretDiscordToken",
  },
  { provider: "bark", label: "Bark notifications", serverUrl: "https://api.day.app", deviceKey: "bark-secret-key" },
  {
    provider: "webhook",
    label: "Generic webhook notifications",
    webhookUrl: "https://automation.example/secret-endpoint/",
  },
  { provider: "teams", label: "Microsoft Teams notifications", webhookUrl: teamsWebhookUrl },
  {
    provider: "line",
    label: "LINE notifications",
    channelAccessToken: "line-secret-token",
    recipientId: `U${"a".repeat(32)}`,
  },
];
const secrets = [
  teamsWebhookUrl,
  replacementTeamsWebhookUrl,
  "tenant.example.environment.api.powerplatform.com",
  "/powerautomate/automations/direct/workflows/",
  "workflow-123",
  "workflow-456",
  "/triggers/manual/paths/invoke",
  "api-version=1",
  "sp=%2Ftriggers%2Fmanual%2Frun",
  "sv=1.0",
  "sig=",
  "synthetic-signature_123",
  "new-synthetic-signature",
  "a".repeat(30),
  "u".repeat(30),
  "bark-secret-key",
  "secretDiscordToken",
  "secret-endpoint",
  "bearer-secret",
  "ntfy-secret",
  "line-secret-token",
  `U${"a".repeat(32)}`,
];
async function setup(h: ReturnType<typeof harness>, destination: Destination) {
  await h.choose("Destinations");
  await h.choose("Add destination");
  const label = destination.label.replace(" notifications", "");
  await h.choose(`Add ${label} destination`);
  if (destination.provider === "ntfy") await h.input(destination.topic);
  else if (destination.provider === "pushover") {
    await h.input(destination.appToken);
    expect(h.text()).not.toContain(destination.appToken);
    await h.input(destination.userKey);
  } else if (destination.provider === "bark") await h.input(destination.deviceKey);
  else if (destination.provider === "line") {
    await h.input(destination.channelAccessToken, true);
    await h.input(destination.recipientId, true);
  } else if (
    destination.provider === "discord" ||
    destination.provider === "webhook" ||
    destination.provider === "teams"
  )
    await h.input(destination.webhookUrl, true);
}

it.each([false, true])(
  "configures ntfy transactionally and clears optional credentials/priority (remapped: %s)",
  async (remap) => {
    const h = harness(remap);
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose("Destinations");
    await h.choose("Add destination");
    await h.choose("Add ntfy destination");
    await h.input("private-topic");
    expect(h.text()).toContain("A topic name is not access control");
    await h.choose("Replace access token");
    h.tui.send("\x1b[200~ntfy-secretX\x1b[201~");
    h.tui.send("\x7f");
    expect(h.text()).not.toContain("ntfy-secret");
    await h.transition(() => h.tui.press("tui.input.submit"));
    await h.choose("Change server URL");
    await h.input("https://push.example/ntfy/");
    await h.choose("Set priority");
    await h.input("5");
    expect(await fs.readdir(directory)).toEqual([]);
    await h.choose("Save and use");
    const id = Object.keys(store.snapshot.effective.destinations)[0];
    expect(store.snapshot.effective.targetIds).toEqual([id]);
    expect(store.snapshot.effective.destinations[id ?? ""]).toMatchObject({
      provider: "ntfy",
      serverUrl: "https://push.example/ntfy/",
      topic: "private-topic",
      accessToken: "ntfy-secret",
      priority: 5,
    });
    await h.choose("Destinations");
    await h.choose("ntfy notifications");
    await h.choose("Edit destination");
    await h.choose("Replace access token");
    await h.input("");
    await h.choose("Set priority");
    await h.input("");
    await h.choose("Save changes");
    const raw = JSON.parse(await fs.readFile(store.userPath, "utf8"));
    expect(raw.destinations[id ?? ""]).not.toHaveProperty("accessToken");
    expect(raw.destinations[id ?? ""]).not.toHaveProperty("priority");
    expect(raw.targetIds).toEqual([id]);
    h.tui.press("ctrl+c");
    await running;
  },
);

it("does not save an ntfy draft when the owning session is replaced", async () => {
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose("Destinations");
  await h.choose("Add destination");
  await h.choose("Add ntfy destination");
  await h.input("private-topic");
  await h.choose("Replace access token");
  h.tui.type("ntfy-secret");
  owner.abort();
  await running;
  expect(await fs.readdir(directory)).toEqual([]);
  expect(h.tui.isOpen).toBe(false);
  expect(h.notify).not.toHaveBeenCalled();
});

it("previews ntfy tests without secrets, confirms delivery, and bounds review rendering", async () => {
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose("Destinations");
  await h.choose("Add destination");
  await h.choose("Add ntfy destination");
  await h.input("private-topic");
  await h.choose("Replace access token");
  await h.input("ntfy-secret");
  await h.choose("Save only");
  expect(store.snapshot.effective.targetIds).toEqual([]);
  const send = vi.spyOn(coordinator, "send").mockResolvedValue({ state: "accepted" });
  await h.choose("Send test");
  await h.choose("ntfy notifications");
  expect(send).not.toHaveBeenCalled();
  expect(h.text()).not.toContain("ntfy-secret");
  expect(h.zeroFrames.every((frame) => frame.every((line) => visibleWidth(line) === 0))).toBe(true);
  for (const width of [1, 12, 72])
    for (const rows of [4, 8, 24]) {
      const frame = h.tui.resize({ width, rows });
      expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  h.tui.resize({ width: 100, rows: 40 });
  await h.transition(() => h.tui.press("tui.select.confirm"));
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain("ntfy-secret");
  h.tui.press("ctrl+c");
  await running;
});

it.each(examples.flatMap((destination) => [false, true].map((use) => ({ destination, use }))))(
  "creates, edits, tests, and removes $destination.provider (selected: $use)",
  async ({ destination, use }) => {
    const h = harness(true);
    const running = h.run();
    await h.tui.waitForOpen();
    await setup(h, destination);
    for (const secret of secrets) expect(h.text()).not.toContain(secret);
    if (destination.provider === "line" || destination.provider === "teams") {
      expect(h.zeroFrames.every((frame) => frame.every((line) => visibleWidth(line) === 0))).toBe(true);
      for (const width of [1, 12, 72])
        for (const rows of [4, 8, 24]) {
          const frame = h.tui.resize({ width, rows });
          expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
          expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
        }
      h.tui.resize({ width: 100, rows: 40 });
      h.tui.invalidate();
    }
    expect(await fs.readdir(directory)).toEqual([]);
    await h.choose(use ? "Save and use" : "Save only");
    const [id, saved] = Object.entries(store.snapshot.effective.destinations)[0] ?? [];
    expect(saved).toMatchObject(destination);
    expect(store.snapshot.effective.targetIds).toEqual(use ? [id] : []);
    if (destination.provider === "line" || destination.provider === "teams") {
      await h.choose("Status");
      expect(h.text()).toContain(destination.label);
      for (const secret of secrets) expect(h.text()).not.toContain(secret);
      await h.transition(() => h.tui.send("\x11"));
    }
    await h.choose("Destinations");
    await h.choose(destination.label);
    await h.choose("Edit destination");
    await h.choose("Change label");
    h.tui.send("\x15");
    h.tui.send("\x1b[200~ChangedX\x1b[201~");
    h.tui.send("\x7f");
    await h.transition(() => h.tui.press("tui.input.submit"));
    expect(store.snapshot.effective.destinations[id ?? ""]?.label).toBe(destination.label);
    await h.choose("Save changes");
    expect(store.snapshot.effective.destinations[id ?? ""]?.label).toBe("Changed");
    expect(store.snapshot.effective.targetIds).toEqual(use ? [id] : []);
    const send = vi.spyOn(coordinator, "send").mockResolvedValue({ state: "accepted" });
    await h.choose("Send test");
    await h.choose("Changed");
    expect(send).not.toHaveBeenCalled();
    for (const secret of secrets) expect(h.text()).not.toContain(secret);
    await h.transition(() => h.tui.press("tui.select.confirm"));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toMatchObject({ ...destination, label: "Changed" });
    await h.choose("Destinations");
    await h.choose("Changed");
    await h.choose("Remove destination");
    expect(store.snapshot.effective.destinations[id ?? ""]).toBeDefined();
    await h.choose("Remove destination");
    expect(store.snapshot.effective.destinations).toEqual({});
    expect(store.snapshot.effective.targetIds).toEqual([]);
    h.tui.press("ctrl+c");
    await running;
    for (const secret of secrets) expect(JSON.stringify(h.notify.mock.calls)).not.toContain(secret);
  },
);

it("replaces and clears a Generic Bearer token without displaying its endpoint", async () => {
  const destination = examples.find((example) => example.provider === "webhook");
  if (!destination) throw new Error("Missing example");
  const h = harness();
  const running = h.run();
  await h.tui.waitForOpen();
  await setup(h, destination);
  await h.choose("Set Bearer token");
  await h.input("bearer-secret");
  expect(h.text()).toContain("Bearer token: configured (hidden)");
  for (const secret of secrets) expect(h.text()).not.toContain(secret);
  await h.choose("Save and use");
  const id = Object.keys(store.snapshot.effective.destinations)[0] ?? "";
  await h.choose("Destinations");
  await h.choose(destination.label);
  await h.choose("Edit destination");
  await h.choose("Set Bearer token");
  await h.input("");
  await h.choose("Save changes");
  const saved = JSON.parse(await fs.readFile(store.userPath, "utf8"));
  expect(saved.destinations[id]).not.toHaveProperty("bearerToken");
  expect(saved.destinations[id].webhookUrl).toBe(
    destination.provider === "webhook" ? destination.webhookUrl : undefined,
  );
  h.tui.press("ctrl+c");
  await running;
});

it.each(examples.flatMap((destination) => ["cancel", "dispose", "replace"].map((cause) => ({ destination, cause }))))(
  "releases a $destination.provider test after $cause",
  async ({ destination, cause }) => {
    await saveDestination(store, "saved", destination, owner.signal);
    const h = harness(true);
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(coordinator, "send").mockImplementation(async (_id, _destination, _note, signal) => {
      requestSignal = signal;
      return new Promise((resolve) =>
        signal?.addEventListener("abort", () => resolve({ state: "cancelled", code: "cancelled" }), { once: true }),
      );
    });
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose("Send test");
    await h.choose(destination.label);
    await h.transition(() => h.tui.press("tui.select.confirm"));
    await vi.waitFor(() => expect(requestSignal).toBeDefined(), { interval: 1 });
    if (cause === "dispose") {
      await h.transition(() => h.tui.dispose());
      expect(requestSignal?.aborted).toBe(true);
      h.tui.press("ctrl+c");
    } else if (cause === "replace") owner.abort();
    else h.tui.press("ctrl+c");
    await running;
    expect(requestSignal?.aborted).toBe(true);
    expect(h.tui.isOpen).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  },
);

it.each(examples.flatMap((destination) => ["cancel", "save"].map((completion) => ({ destination, completion }))))(
  "edits $destination.provider credentials transactionally: $completion",
  async ({ destination, completion }) => {
    await saveDestination(store, "saved", destination, owner.signal, false);
    const original = await fs.readFile(store.userPath, "utf8");
    const h = harness(true);
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose("Destinations");
    await h.choose(destination.label);
    await h.choose("Edit destination");
    const credential =
      destination.provider === "ntfy"
        ? "access token"
        : destination.provider === "pushover"
          ? "application token"
          : destination.provider === "bark"
            ? "device key"
            : destination.provider === "line"
              ? "channel access token"
              : "webhook URL";
    await h.choose(`Replace ${credential}`);
    if (destination.provider === "line" || destination.provider === "teams") {
      const opened = h.tui.openCount;
      h.tui.press("tui.input.submit");
      await h.tui.waitForPending();
      expect(h.tui.openCount).toBe(opened);
      expect(h.text()).toContain(credential);
    }
    const replacement =
      destination.provider === "pushover"
        ? "p".repeat(30)
        : destination.provider === "discord"
          ? "https://discord.com/api/v10/webhooks/456/newSecretToken"
          : destination.provider === "webhook"
            ? "http://localhost:8123/new-secret/"
            : destination.provider === "teams"
              ? replacementTeamsWebhookUrl
              : "new-secret-token";
    await h.input(replacement, true);
    expect(h.text()).not.toContain(replacement);
    if (destination.provider === "pushover") {
      await h.choose("Replace user key");
      await h.input("k".repeat(30));
      expect(h.text()).not.toContain("k".repeat(30));
    } else if (destination.provider === "line") {
      await h.choose("Replace recipient ID");
      expect(h.text()).not.toContain(destination.recipientId);
      const opened = h.tui.openCount;
      h.tui.press("tui.input.submit");
      await h.tui.waitForPending();
      expect(h.tui.openCount).toBe(opened);
      await h.input(`C${"b".repeat(32)}`, true);
    } else if (destination.provider === "bark" || destination.provider === "ntfy") {
      await h.choose("Change server URL");
      await h.input("http://localhost:8080/base/");
      expect(h.text()).toContain("HTTP sends credentials and metadata without encryption");
    }
    expect(await fs.readFile(store.userPath, "utf8")).toBe(original);
    if (completion === "save") await h.choose("Save changes");
    h.tui.press("ctrl+c");
    await running;
    if (completion === "cancel") expect(await fs.readFile(store.userPath, "utf8")).toBe(original);
    else {
      const saved = store.snapshot.effective.destinations.saved;
      expect(saved?.provider).toBe(destination.provider);
      if (saved?.provider === "ntfy")
        expect(saved).toMatchObject({ accessToken: replacement, serverUrl: "http://localhost:8080/base/" });
      if (saved?.provider === "pushover")
        expect(saved).toMatchObject({ appToken: replacement, userKey: "k".repeat(30) });
      if (saved?.provider === "bark")
        expect(saved).toMatchObject({ deviceKey: replacement, serverUrl: "http://localhost:8080/base" });
      if (saved?.provider === "discord" || saved?.provider === "webhook" || saved?.provider === "teams")
        expect(saved.webhookUrl).toBe(replacement);
      if (saved?.provider === "line")
        expect(saved).toMatchObject({ channelAccessToken: replacement, recipientId: `C${"b".repeat(32)}` });
    }
    expect(store.snapshot.effective.targetIds).toEqual([]);
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain(replacement);
  },
);

it.each(
  examples
    .filter((destination) => destination.provider === "line" || destination.provider === "teams")
    .flatMap((destination) =>
      (destination.provider === "teams" ? ["credential"] : ["credential", "recipient"]).flatMap((stage) =>
        ["cancel", "hard-cancel", "dispose", "replace"].map((cause) => ({ destination, stage, cause })),
      ),
    ),
)("releases pending $destination.provider setup at $stage after $cause", async ({ destination, stage, cause }) => {
  const h = harness(true);
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose("Destinations");
  await h.choose("Add destination");
  await h.choose(`Add ${destination.label.replace(" notifications", "")} destination`);
  if (stage === "recipient" && destination.provider === "line") await h.input(destination.channelAccessToken, true);
  for (const secret of secrets) expect(h.text()).not.toContain(secret);
  const value =
    destination.provider === "line"
      ? stage === "recipient"
        ? destination.recipientId
        : destination.channelAccessToken
      : destination.provider === "teams"
        ? destination.webhookUrl
        : "";
  h.tui.send(`\x1b[200~${value}X\x1b[201~`);
  h.tui.send("\x7f");
  expect(h.text()).not.toContain(value);
  for (const secret of secrets) expect(h.text()).not.toContain(secret);
  if (cause === "dispose" || cause === "cancel") {
    await h.transition(() => (cause === "dispose" ? h.tui.dispose() : h.tui.send("\x11")));
    expect(h.text()).toContain("Add destination · User");
    h.tui.press("ctrl+c");
  } else if (cause === "replace") owner.abort();
  else h.tui.press("ctrl+c");
  await running;
  expect(h.tui.isOpen).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
  expect(store.snapshot.effective.destinations).toEqual({});
  expect(h.notify).not.toHaveBeenCalled();
});

it.each(
  examples
    .filter((destination) => destination.provider === "line" || destination.provider === "teams")
    .flatMap((destination) =>
      (destination.provider === "teams" ? ["webhook URL"] : ["recipient ID", "channel access token"]).map((field) => ({
        destination,
        field,
      })),
    ),
)(
  "recovers from invalid $destination.provider $field edits and failed saves without changing routing or exposing secrets",
  async ({ destination, field }) => {
    await saveDestination(store, "saved", destination, owner.signal);
    const original = await fs.readFile(store.userPath, "utf8");
    const snapshot = store.snapshot;
    const h = harness(true);
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose("Destinations");
    await h.choose(destination.label);
    await h.choose("Edit destination");
    await h.choose(`Replace ${field}`);
    for (const secret of secrets) expect(h.text()).not.toContain(secret);
    const invalid =
      field === "webhook URL"
        ? `${teamsWebhookUrl}&sig=private-secret-invalid`
        : field === "recipient ID"
          ? "private-secret-invalid"
          : "private:secret:invalid";
    await h.input(invalid, true);
    expect(h.notify).toHaveBeenCalled();
    expect(store.snapshot).toBe(snapshot);
    expect(await fs.readFile(store.userPath, "utf8")).toBe(original);
    await h.choose(`Replace ${field}`);
    const replacement =
      field === "webhook URL"
        ? replacementTeamsWebhookUrl
        : field === "recipient ID"
          ? `R${"c".repeat(32)}`
          : "recovered-line-secret";
    await h.input(replacement, true);
    await h.choose("Change label");
    await h.input("Recovered");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error(JSON.stringify(destination)));
    await h.choose("Save changes");
    expect(store.snapshot).toBe(snapshot);
    expect(await fs.readFile(store.userPath, "utf8")).toBe(original);
    expect(h.text()).toContain("Recovered");
    await h.choose("Save changes");
    expect(store.snapshot.effective.destinations.saved).toMatchObject({ label: "Recovered" });
    expect(store.snapshot.effective.destinations.saved).toMatchObject({
      [field === "webhook URL" ? "webhookUrl" : field === "recipient ID" ? "recipientId" : "channelAccessToken"]:
        replacement,
    });
    expect(store.snapshot.effective.targetIds).toEqual(["saved"]);
    h.tui.press("ctrl+c");
    await running;
    const output = JSON.stringify(h.notify.mock.calls);
    expect(output).not.toContain(invalid);
    expect(output).not.toContain(replacement);
    for (const secret of secrets) expect(output).not.toContain(secret);
  },
);

it.each(["token", "recipient"])(
  "recovers from invalid initial LINE %s setup without saving or sending",
  async (field) => {
    const destination = examples.find((value) => value.provider === "line");
    if (destination?.provider !== "line") throw new Error("Missing LINE example");
    const h = harness(true);
    const send = vi.spyOn(coordinator, "send");
    const running = h.run();
    await h.tui.waitForOpen();
    await h.choose("Destinations");
    await h.choose("Add destination");
    await h.choose("Add LINE destination");
    const invalid = "private:invalid:value";
    await h.input(field === "token" ? invalid : destination.channelAccessToken, true);
    await h.input(field === "recipient" ? invalid : destination.recipientId, true);
    expect(h.text()).toContain("Add destination · User");
    expect(h.notify).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain(invalid);
    expect(await fs.readdir(directory)).toEqual([]);
    expect(store.snapshot.effective.destinations).toEqual({});
    expect(send).not.toHaveBeenCalled();
    await h.choose("Add LINE destination");
    await h.input(destination.channelAccessToken, true);
    await h.input(destination.recipientId, true);
    await h.choose("Save and use");
    expect(Object.values(store.snapshot.effective.destinations)).toEqual([destination]);
    expect(send).not.toHaveBeenCalled();
    h.tui.press("ctrl+c");
    await running;
    for (const secret of secrets) expect(JSON.stringify(h.notify.mock.calls)).not.toContain(secret);
  },
);

it("recovers from an invalid initial Teams URL without saving or sending", async () => {
  const destination = examples.find((value) => value.provider === "teams");
  if (destination?.provider !== "teams") throw new Error("Missing Teams example");
  const h = harness(true);
  const send = vi.spyOn(coordinator, "send");
  const running = h.run();
  await h.tui.waitForOpen();
  await h.choose("Destinations");
  await h.choose("Add destination");
  await h.choose("Add Microsoft Teams destination");
  await h.input(`${teamsWebhookUrl}&sig=private-invalid-signature`, true);
  expect(h.text()).toContain("Add destination · User");
  expect(h.notify).toHaveBeenCalledOnce();
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain("private-invalid-signature");
  expect(await fs.readdir(directory)).toEqual([]);
  expect(store.snapshot.effective.destinations).toEqual({});
  expect(send).not.toHaveBeenCalled();
  await h.choose("Add Microsoft Teams destination");
  h.tui.send(`\x1b[200~${teamsWebhookUrl}X\x1b[201~`);
  h.tui.send("\x7f");
  for (const secret of secrets) expect(h.text()).not.toContain(secret);
  await h.transition(() => h.tui.press("tui.input.submit"));
  await h.choose("Save and use");
  expect(Object.values(store.snapshot.effective.destinations)).toEqual([destination]);
  expect(send).not.toHaveBeenCalled();
  h.tui.press("ctrl+c");
  await running;
  for (const secret of secrets) expect(JSON.stringify(h.notify.mock.calls)).not.toContain(secret);
});

it.each(examples)("renders $provider destination summaries without secrets outside the TUI", (destination) => {
  const text = [destinationDescription(destination), ...destinationLines(destination)].join("\n");
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).toContain(destination.label);
});
