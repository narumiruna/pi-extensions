import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Destination } from "../src/provider.js";
import { providers } from "../src/providers.js";
import { resolveSettings, SettingsStore, saveDestination, savePolicy } from "../src/settings.js";

let directory: string;
let store: SettingsStore;
const signal = () => new AbortController().signal;
const telegram: Destination = {
  provider: "telegram",
  label: "Personal",
  botToken: `123:${"s".repeat(30)}`,
  chatId: "123",
};
const destinations = [
  {
    provider: "ntfy",
    label: "Private topic",
    serverUrl: "https://ntfy.example/proxy",
    topic: "build-events",
    accessToken: "ntfy-access-secret",
    priority: 4,
  },
  {
    provider: "pushover",
    label: "Phone",
    appToken: "A".repeat(30),
    userKey: "U".repeat(30),
  },
  {
    provider: "discord",
    label: "Channel",
    webhookUrl: "https://discord.com/api/webhooks/123456789012345678/DiscordSecretToken",
  },
  {
    provider: "bark",
    label: "Self-hosted phone",
    serverUrl: "http://192.168.1.2/bark",
    deviceKey: "bark-device-secret",
  },
  {
    provider: "webhook",
    label: "Home Assistant",
    webhookUrl: "http://127.0.0.1:8123/api/webhook/SecretEndpoint/",
    bearerToken: "webhook-bearer-secret",
  },
  {
    provider: "teams",
    label: "Microsoft Teams notifications",
    webhookUrl:
      "https://tenant.example.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/workflow-123/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=synthetic-signature_123",
  },
  {
    provider: "line",
    label: "LINE recipient",
    channelAccessToken: "line-secret-token",
    recipientId: `U${"a".repeat(32)}`,
  },
] satisfies Destination[];

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-notify-settings-providers-"));
  store = new SettingsStore(
    join(directory, "agent", "pi-notify.json"),
    join(directory, "project", "pi-notify.json"),
    providers,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.flush();
  await fs.rm(directory, { recursive: true, force: true });
});

it("round-trips all ten providers, keeps private credentials, and routes through trusted Project selections", async () => {
  const all: Destination[] = [
    telegram,
    { provider: "gotify", label: "Server", serverUrl: "https://gotify.example/base", appToken: "gotify-secret" },
    {
      provider: "slack",
      label: "Slack",
      webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/SlackSecret",
    },
    ...destinations,
  ];
  for (const destination of all) await saveDestination(store, destination.provider, destination, signal());
  const loaded = await store.load();
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.effective.enabled).toBe(true);
  expect(loaded.effective.targetIds).toEqual(all.map(({ provider }) => provider));
  const raw = JSON.parse(await fs.readFile(store.userPath, "utf8"));
  for (const destination of all) {
    expect(loaded.effective.destinations[destination.provider]).toEqual(store.validate(destination));
    expect(raw.destinations[destination.provider]).toEqual(destination);
  }
  if (process.platform !== "win32") expect((await fs.stat(store.userPath)).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(dirname(store.userPath))).toEqual(["pi-notify.json"]);

  const selected = ["teams", "line", "discord", "telegram", "bark", "ntfy", "slack", "pushover", "gotify", "webhook"];
  await savePolicy(store, "project", "targetIds", selected, signal());
  expect((await store.load()).effective.targetIds).toEqual(selected);
  expect(JSON.parse(await fs.readFile(store.projectPath as string, "utf8"))).toEqual({ targetIds: selected });
  const untrusted = new SettingsStore(store.userPath, undefined, providers);
  expect((await untrusted.load()).effective.targetIds).toEqual(all.map(({ provider }) => provider));
  await expect(saveDestination(store, "ntfy", undefined, signal())).rejects.toThrow("Project");
  await savePolicy(store, "project", "targetIds", undefined, signal());
  await saveDestination(store, "ntfy", undefined, signal());
  expect(store.snapshot.effective.targetIds).toEqual(
    all.filter(({ provider }) => provider !== "ntfy").map(({ provider }) => provider),
  );
});

it("preserves unknown fields for every new provider while clearing owned optional fields", async () => {
  await fs.mkdir(dirname(store.userPath));
  await fs.writeFile(
    store.userPath,
    JSON.stringify({
      future: { version: 1 },
      destinations: Object.fromEntries(
        destinations.map((destination) => [destination.provider, { ...destination, future: { keep: true } }]),
      ),
      targetIds: destinations.map(({ provider }) => provider),
    }),
  );
  await store.load();
  await savePolicy(store, "user", "mode", "after-inactivity", signal());
  for (const destination of destinations) {
    const replacement: Destination =
      destination.provider === "ntfy"
        ? { ...destination, label: "Renamed ntfy", accessToken: undefined, priority: undefined }
        : destination.provider === "webhook"
          ? { ...destination, label: "Renamed webhook", bearerToken: undefined }
          : { ...destination, label: `Renamed ${destination.provider}` };
    await saveDestination(store, destination.provider, replacement, signal());
    expect(store.snapshot.effective.destinations[destination.provider]).toEqual(store.validate(replacement));
    if (process.platform !== "win32") expect((await fs.stat(store.userPath)).mode & 0o777).toBe(0o600);
  }
  const raw = JSON.parse(await fs.readFile(store.userPath, "utf8"));
  expect(raw.future).toEqual({ version: 1 });
  for (const destination of destinations) expect(raw.destinations[destination.provider].future).toEqual({ keep: true });
  expect(raw.destinations.ntfy).not.toHaveProperty("accessToken");
  expect(raw.destinations.ntfy).not.toHaveProperty("priority");
  expect(raw.destinations.webhook).not.toHaveProperty("bearerToken");
  const reloaded = await store.load();
  expect(reloaded.diagnostics).toEqual([]);
  expect(reloaded.effective.destinations.ntfy).toMatchObject({ accessToken: undefined, priority: undefined });
  expect(reloaded.effective.destinations.webhook).toMatchObject({ bearerToken: undefined });
});

it.each(destinations.flatMap((destination) => [false, true].map((selected) => ({ destination, selected }))))(
  "fails closed on invalid $destination.provider settings without exposing credentials (selected: $selected)",
  ({ destination, selected }) => {
    // Provider tests own the complete validation matrix; exercise one invalid credential per settings branch.
    const invalid =
      destination.provider === "ntfy"
        ? { ...destination, accessToken: "private-secret\ninvalid" }
        : destination.provider === "pushover"
          ? { ...destination, userKey: "private-secret" }
          : destination.provider === "discord"
            ? { ...destination, webhookUrl: "https://discord.com/api/webhooks/0/private-secret" }
            : destination.provider === "bark"
              ? { ...destination, deviceKey: "private-secret\ninvalid" }
              : destination.provider === "line"
                ? { ...destination, channelAccessToken: "private-secret\ninvalid" }
                : destination.provider === "teams"
                  ? { ...destination, webhookUrl: `${destination.webhookUrl}&sig=private-secret` }
                  : { ...destination, webhookUrl: "https://user:private-secret@webhook.example/SecretEndpoint" };
    const snapshot = resolveSettings(
      {
        destinations: { personal: telegram, invalid },
        targetIds: selected ? ["personal", "invalid"] : ["personal"],
      },
      {},
      providers,
    );
    expect(snapshot.effective.enabled).toBe(false);
    expect(snapshot.effective.destinations).toEqual({ personal: telegram });
    expect(snapshot.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot.diagnostics)).not.toMatch(
      /private-secret|SecretEndpoint|discord\.com|webhook\.example|line-secret|U[a-f0-9]{32}|powerplatform|workflow-123|synthetic-signature/,
    );
  },
);

it.each(destinations)("forbids Project $provider definitions even when User owns the same ID", (destination) => {
  const user = { destinations: { one: destination }, targetIds: ["one"] };
  for (const source of [{}, user]) {
    const snapshot = resolveSettings(source, { destinations: { one: destination }, targetIds: ["one"] }, providers);
    expect(snapshot.effective.enabled).toBe(false);
    expect(snapshot.effective.destinations).toEqual(source === user ? { one: store.validate(destination) } : {});
    expect(snapshot.diagnostics).toContain("Project destinations are forbidden; use User settings.");
    expect(JSON.stringify(snapshot.diagnostics)).not.toMatch(
      /secret|Secret|ntfy\.example|discord\.com|192\.168|127\.0|AAAA|UUUU|U[a-f0-9]{32}|powerplatform|workflow-123|synthetic-signature/,
    );
  }
});

it.each(destinations)(
  "requires removing $provider definitions, not only selections, before an older registry can route",
  async (destination) => {
    await saveDestination(store, "personal", telegram, signal());
    await saveDestination(store, "new", destination, signal());
    await savePolicy(store, "project", "targetIds", ["new"], signal());
    const oldProviders = new Map(
      [...providers].filter(([id]) =>
        destination.provider === "teams"
          ? id !== "teams"
          : destination.provider === "line"
            ? id !== "line" && id !== "teams"
            : ["telegram", "gotify", "slack"].includes(id),
      ),
    );
    expect(oldProviders.size).toBe(destination.provider === "teams" ? 9 : destination.provider === "line" ? 8 : 3);
    const oldStore = new SettingsStore(store.userPath, store.projectPath, oldProviders);
    expect((await oldStore.load()).effective.enabled).toBe(false);
    await savePolicy(store, "user", "targetIds", ["personal"], signal());
    expect((await oldStore.load()).effective.enabled).toBe(false);
    await savePolicy(store, "project", "targetIds", undefined, signal());
    expect((await oldStore.load()).effective.enabled).toBe(false);
    await savePolicy(oldStore, "user", "mode", "after-inactivity", signal());
    expect(JSON.parse(await fs.readFile(store.userPath, "utf8")).destinations.new).toEqual(destination);
    await saveDestination(store, "new", undefined, signal());
    const recovered = await oldStore.load();
    expect(recovered.diagnostics).toEqual([]);
    expect(recovered.effective).toMatchObject({
      enabled: true,
      targetIds: ["personal"],
      destinations: { personal: telegram },
    });
  },
);

it.each(destinations.filter(({ provider }) => provider === "line" || provider === "teams"))(
  "blocks $provider saves over malformed settings and recovers after repair",
  async (destination) => {
    await fs.mkdir(dirname(store.userPath));
    for (const invalid of ["{private-secret", JSON.stringify({ destinations: "private-secret" })]) {
      await fs.writeFile(store.userPath, invalid);
      await store.load();
      expect(store.snapshot.effective.enabled).toBe(false);
      await expect(saveDestination(store, "one", destination, signal())).rejects.toThrow(/Repair|repair/);
      expect(await fs.readFile(store.userPath, "utf8")).toBe(invalid);
      expect(await fs.readdir(dirname(store.userPath))).toEqual(["pi-notify.json"]);
      expect(JSON.stringify(store.snapshot.diagnostics)).not.toContain("private-secret");
    }
    await fs.writeFile(store.userPath, "{}");
    await saveDestination(store, "one", destination, signal());
    expect((await store.load()).diagnostics).toEqual([]);
    expect(store.snapshot.effective.destinations.one).toEqual(store.validate(destination));
  },
);

it.each(destinations.filter(({ provider }) => provider === "line" || provider === "teams"))(
  "preserves saved Off and explicit Project selections while adding, editing, and removing $provider",
  async (destination) => {
    await saveDestination(store, "personal", telegram, signal());
    await savePolicy(store, "user", "enabled", false, signal());
    await savePolicy(store, "project", "targetIds", ["personal"], signal());
    const project = await fs.readFile(store.projectPath as string, "utf8");
    await saveDestination(store, "new", destination, signal(), false);
    await saveDestination(store, "new", { ...destination, label: "Renamed" }, signal());
    expect(store.snapshot.effective).toMatchObject({ enabled: false, targetIds: ["personal"] });
    expect(store.snapshot.user.targetIds).toEqual(["personal"]);
    await saveDestination(store, "new", undefined, signal());
    expect((await store.load()).effective).toMatchObject({ enabled: false, targetIds: ["personal"] });
    expect(await fs.readFile(store.projectPath as string, "utf8")).toBe(project);
  },
);

it.each(destinations)(
  "recovers after a failed $provider save and orders pending writes before another store's load",
  async (destination) => {
    await saveDestination(store, "one", destination, signal(), false);
    const before = await fs.readFile(store.userPath, "utf8");
    const snapshot = store.snapshot;
    const secret = JSON.stringify(destination);
    const rename = fs.rename.bind(fs);
    const publication = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error(secret));
    await expect(saveDestination(store, "one", { ...destination, label: "Failed" }, signal())).rejects.toThrow(
      /^Settings were not saved\. Check file permissions and available disk space\.$/,
    );
    expect(store.snapshot).toBe(snapshot);
    expect(await fs.readFile(store.userPath, "utf8")).toBe(before);
    expect(await fs.readdir(dirname(store.userPath))).toEqual(["pi-notify.json"]);
    expect((await store.load()).effective.destinations.one).toEqual(store.validate(destination));

    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const publishing = new Promise<void>((resolve) => {
      started = resolve;
    });
    publication.mockImplementationOnce(async (...args) => {
      started?.();
      await pending;
      return rename(...args);
    });
    const first = saveDestination(store, "one", { ...destination, label: "First" }, signal());
    await publishing;
    const second = saveDestination(store, "one", { ...destination, label: "Second" }, signal());
    const dependentReload = store.load();
    const other = new SettingsStore(store.userPath, store.projectPath, providers);
    const reloaded = other.load();
    try {
      expect(store.snapshot.effective.destinations.one).toEqual(store.validate(destination));
      expect(await fs.readFile(store.userPath, "utf8")).toBe(before);
    } finally {
      assert.ok(release);
      release();
    }
    await Promise.all([first, second]);
    // A different store can load between queued transactions, but never before the active publication.
    expect((await reloaded).effective.destinations.one?.label).toMatch(/^(First|Second)$/);
    expect((await dependentReload).effective.destinations.one).toEqual(
      store.validate({ ...destination, label: "Second" }),
    );
    expect((await other.load()).effective.destinations.one).toEqual(
      store.validate({ ...destination, label: "Second" }),
    );
    expect(store.snapshot.effective.targetIds).toEqual([]);
    if (process.platform !== "win32") expect((await fs.stat(store.userPath)).mode & 0o777).toBe(0o600);
  },
);
