import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GotifyDestination } from "../src/provider.js";
import { providers } from "../src/providers.js";
import { resolveSettings, SettingsStore, saveDestination, savePolicy } from "../src/settings.js";

let directory: string;
let store: SettingsStore;
const signal = () => new AbortController().signal;
const destination = {
  provider: "telegram" as const,
  label: "Personal",
  botToken: `123:${"s".repeat(30)}`,
  chatId: "123",
};
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-notify-test-"));
  store = new SettingsStore(
    join(directory, "agent", "pi-notify.json"),
    join(directory, "project", "pi-notify.json"),
    providers,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
it("loads defaults without creating directories and creates private files only on save", async () => {
  expect((await store.load()).effective.enabled).toBe(true);
  expect(await fs.readdir(directory)).toEqual([]);
  await saveDestination(store, "personal", destination, signal());
  if (process.platform !== "win32") expect((await fs.stat(store.userPath)).mode & 0o777).toBe(0o600);
  const names = await fs.readdir(join(directory, "agent"));
  expect(names).toEqual(["pi-notify.json"]);
});
it("selects new destinations atomically while preserving existing selections and explicit Off", async () => {
  await savePolicy(store, "user", "enabled", false, signal());
  await saveDestination(store, "personal", destination, signal());
  await saveDestination(store, "work", destination, signal());
  expect(store.snapshot.effective.targetIds).toEqual(["personal", "work"]);
  expect(store.snapshot.effective.enabled).toBe(false);
  await savePolicy(store, "user", "targetIds", ["work"], signal());
  await saveDestination(store, "personal", { ...destination, label: "Renamed" }, signal());
  expect(store.snapshot.effective.targetIds).toEqual(["work"]);
  await savePolicy(store, "project", "targetIds", [], signal());
  await saveDestination(store, "other", destination, signal());
  expect(store.snapshot.user.targetIds).toEqual(["work", "other"]);
  expect(store.snapshot.effective.targetIds).toEqual([]);
  const before = await fs.readFile(store.userPath, "utf8");
  const snapshot = store.snapshot;
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("failure"));
  await expect(saveDestination(store, "failed", destination, signal())).rejects.toThrow("not saved");
  expect(store.snapshot).toBe(snapshot);
  expect(await fs.readFile(store.userPath, "utf8")).toBe(before);
});
it.each([null, "invalid", ["personal", "personal"]])(
  "protects invalid selections when adding: %j",
  async (targetIds) => {
    await fs.mkdir(join(directory, "agent"));
    const before = JSON.stringify({ targetIds });
    await fs.writeFile(store.userPath, before);
    await expect(saveDestination(store, "personal", destination, signal())).rejects.toThrow("Repair");
    expect(await fs.readFile(store.userPath, "utf8")).toBe(before);
  },
);
it("merges trusted project policy only and supports inheritance reset", async () => {
  await saveDestination(store, "personal", destination, signal());
  await savePolicy(store, "user", "targetIds", ["personal"], signal());
  await savePolicy(store, "user", "enabled", true, signal());
  await savePolicy(store, "project", "mode", "after-inactivity", signal());
  await savePolicy(store, "project", "targetIds", [], signal());
  expect(store.snapshot.effective).toMatchObject({ enabled: true, mode: "after-inactivity", targetIds: [] });
  await savePolicy(store, "project", "targetIds", undefined, signal());
  expect(store.snapshot.effective.targetIds).toEqual(["personal"]);
  const untrusted = new SettingsStore(store.userPath, undefined, providers);
  expect((await untrusted.load()).effective.mode).toBe("immediate");
  await expect(savePolicy(untrusted, "project", "enabled", true, signal())).rejects.toThrow("trusted");
});
it.each(["{bad", "[]", "null", '"text"'])("warns and protects malformed files: %s", async (bytes) => {
  await fs.mkdir(join(directory, "agent"));
  await fs.writeFile(store.userPath, bytes);
  expect((await store.load()).diagnostics.length).toBeGreaterThan(0);
  await expect(savePolicy(store, "user", "enabled", true, signal())).rejects.toThrow("Repair");
  expect(await fs.readFile(store.userPath, "utf8")).toBe(bytes);
});
it.each([[], ["legacy-secret"], "legacy-secret", null, 42, false].map((value) => [value]))(
  "protects invalid destination collections during every destination mutation: %j",
  async (destinations) => {
    await fs.mkdir(join(directory, "agent"));
    const bytes = `${JSON.stringify({ destinations, unrelated: { keep: true } }, null, 2)}\n`;
    await fs.writeFile(store.userPath, bytes);
    await store.load();
    const snapshot = store.snapshot;
    for (const value of [destination, undefined]) {
      await expect(saveDestination(store, "personal", value, signal())).rejects.toThrow("Repair");
      expect(await fs.readFile(store.userPath, "utf8")).toBe(bytes);
      expect(store.snapshot).toBe(snapshot);
      expect(await fs.readdir(join(directory, "agent"))).toEqual(["pi-notify.json"]);
    }
    await fs.writeFile(store.userPath, '{"destinations":{},"unrelated":{"keep":true}}');
    await saveDestination(store, "personal", destination, signal());
    expect(store.snapshot.effective.destinations.personal).toMatchObject(destination);
    expect(store.snapshot.user.unrelated).toEqual({ keep: true });
  },
);
it.each([[], "legacy-secret", null, 42, false].map((value) => [value]))(
  "does not replace an invalid destination entry with a new object: %j",
  async (entry) => {
    await fs.mkdir(join(directory, "agent"));
    const bytes = JSON.stringify({ destinations: { personal: entry, other: destination } });
    await fs.writeFile(store.userPath, bytes);
    await store.load();
    const snapshot = store.snapshot;
    await expect(saveDestination(store, "personal", destination, signal())).rejects.toThrow("Repair");
    expect(await fs.readFile(store.userPath, "utf8")).toBe(bytes);
    expect(store.snapshot).toBe(snapshot);
  },
);
it("preserves unrelated fields and nested destination fields", async () => {
  await fs.mkdir(join(directory, "agent"));
  await fs.writeFile(
    store.userPath,
    JSON.stringify({ custom: { future: 1 }, destinations: { personal: { ...destination, future: "keep" } } }),
  );
  await store.load();
  await saveDestination(store, "personal", { ...destination, label: "Changed" }, signal());
  const raw = JSON.parse(await fs.readFile(store.userPath, "utf8"));
  expect(raw.custom).toEqual({ future: 1 });
  expect(raw.destinations.personal.future).toBe("keep");
});
it("rejects unsupported routing without exposing raw values, and preserves unknown providers", async () => {
  const raw = { destinations: { future: { provider: "future-secret", token: "secret" } } };
  await fs.mkdir(join(directory, "agent"));
  await fs.writeFile(store.userPath, JSON.stringify(raw));
  const snapshot = await store.load();
  expect(snapshot.effective.enabled).toBe(false);
  expect(snapshot.diagnostics.join(" ")).not.toMatch(/future-secret|token|secret/);
  await savePolicy(store, "user", "mode", "after-inactivity", signal());
  expect(JSON.parse(await fs.readFile(store.userPath, "utf8")).destinations).toEqual(raw.destinations);
});
it("blocks destination removal while selected in this trusted project", async () => {
  await saveDestination(store, "personal", destination, signal());
  await savePolicy(store, "user", "targetIds", ["personal"], signal());
  await savePolicy(store, "project", "targetIds", ["personal"], signal());
  await expect(saveDestination(store, "personal", undefined, signal())).rejects.toThrow("Project");
  await savePolicy(store, "project", "targetIds", undefined, signal());
  await saveDestination(store, "personal", undefined, signal());
  expect(store.snapshot.effective.targetIds).toEqual([]);
  expect(store.snapshot.effective.destinations).toEqual({});
});
it("recovers after atomic publication failure without changing effective state or disk", async () => {
  await savePolicy(store, "user", "inactivitySeconds", 60, signal());
  const before = await fs.readFile(store.userPath, "utf8");
  const snapshot = store.snapshot;
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("secret path"));
  await expect(savePolicy(store, "user", "inactivitySeconds", 120, signal())).rejects.toThrow("not saved");
  expect(store.snapshot).toBe(snapshot);
  expect(await fs.readFile(store.userPath, "utf8")).toBe(before);
  expect(await fs.readdir(join(directory, "agent"))).toEqual(["pi-notify.json"]);
  await savePolicy(store, "user", "inactivitySeconds", 90, signal());
  expect((await store.load()).effective.inactivitySeconds).toBe(90);
});
it("orders writes and reads across store instances without lock-order deadlocks", async () => {
  const other = new SettingsStore(store.userPath, store.projectPath, providers);
  const writes = [
    savePolicy(store, "user", "inactivitySeconds", 60, signal()),
    savePolicy(other, "project", "mode", "after-inactivity", signal()),
    savePolicy(store, "user", "inactivitySeconds", 120, signal()),
  ];
  await Promise.all(writes);
  expect((await other.load()).effective).toMatchObject({ mode: "after-inactivity", inactivitySeconds: 120 });
  const write = savePolicy(store, "user", "inactivitySeconds", 90, signal());
  const reload = store.load();
  await write;
  expect((await reload).effective.inactivitySeconds).toBe(90);
});
it("does not save a cancelled operation and keeps the queue usable", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(savePolicy(store, "user", "enabled", true, controller.signal)).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
  await savePolicy(store, "user", "inactivitySeconds", 60, signal());
  expect(store.snapshot.effective.inactivitySeconds).toBe(60);
});
it.each([
  { enabled: "yes" },
  { mode: "unknown" },
  { inactivitySeconds: 0 },
  { inactivitySeconds: 86401 },
  { targetIds: ["unknown"] },
  { targetIds: ["a", "a"] },
  { destinations: [] },
  { destinations: { constructor: destination } },
])("fails closed on invalid settings %j", (raw) => {
  const snapshot = resolveSettings({ ...raw, enabled: "enabled" in raw ? raw.enabled : true }, {}, providers);
  expect(snapshot.effective.enabled).toBe(false);
  expect(snapshot.diagnostics.length).toBeGreaterThan(0);
});
it("rechecks project selections from disk before removing a destination", async () => {
  await saveDestination(store, "personal", destination, signal());
  const other = new SettingsStore(store.userPath, store.projectPath, providers);
  await other.load();
  await savePolicy(other, "project", "targetIds", ["personal"], signal());
  await expect(saveDestination(store, "personal", undefined, signal())).rejects.toThrow("Project");
});
it("clears an optional topic without deleting unknown destination fields", async () => {
  await saveDestination(store, "personal", { ...destination, messageThreadId: 42 }, signal());
  await saveDestination(store, "personal", destination, signal());
  expect(store.snapshot.effective.destinations.personal).toMatchObject({
    provider: "telegram",
    messageThreadId: undefined,
  });
  expect(JSON.parse(await fs.readFile(store.userPath, "utf8")).destinations.personal).not.toHaveProperty(
    "messageThreadId",
  );
});
it.each([
  ["inactivitySeconds", 0],
  ["mode", "invalid"],
  ["targetIds", ["missing"]],
])("rejects invalid policy writes %s", async (key, value) => {
  await expect(savePolicy(store, "user", key as "mode", value, signal())).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
});
it("does not treat the canonical user file as its own project overlay", async () => {
  const colliding = new SettingsStore(store.userPath, store.userPath, providers);
  await saveDestination(colliding, "personal", destination, signal());
  expect(colliding.projectPath).toBeUndefined();
  expect((await colliding.load()).diagnostics).toEqual([]);
});
it("does not accept project credential destinations", () => {
  const snapshot = resolveSettings({ enabled: true }, { destinations: { evil: destination } }, providers);
  expect(snapshot.effective.enabled).toBe(false);
  expect(snapshot.effective.destinations).toEqual({});
});

const gotify: GotifyDestination = {
  provider: "gotify",
  label: "Gotify",
  serverUrl: "https://push.example.com/base/",
  appToken: "A-application-token",
};
it("persists mixed providers, normalizes Gotify URLs, and clears optional priority without losing unknown fields", async () => {
  await saveDestination(store, "personal", destination, signal());
  await saveDestination(store, "gotify", { ...gotify, priority: 5 }, signal());
  await store.change(
    "user",
    (document) => {
      const entry = (document.destinations as Record<string, Record<string, unknown>>).gotify;
      assert.ok(entry);
      entry.future = "keep";
    },
    signal(),
  );
  await saveDestination(store, "gotify", gotify, signal());
  const loaded = await store.load();
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.effective.targetIds).toEqual(["personal", "gotify"]);
  expect(loaded.effective.destinations.gotify).toMatchObject({
    ...gotify,
    serverUrl: "https://push.example.com/base",
    priority: undefined,
  });
  const raw = JSON.parse(await fs.readFile(store.userPath, "utf8"));
  expect(raw.destinations.gotify.future).toBe("keep");
  expect(raw.destinations.gotify).not.toHaveProperty("priority");
  expect(raw.destinations.personal).toEqual(destination);
  if (process.platform !== "win32") expect((await fs.stat(store.userPath)).mode & 0o777).toBe(0o600);
  await savePolicy(store, "project", "targetIds", ["gotify"], signal());
  expect(store.snapshot.effective.targetIds).toEqual(["gotify"]);
  await expect(saveDestination(store, "gotify", undefined, signal())).rejects.toThrow("Project");
  await savePolicy(store, "project", "targetIds", undefined, signal());
  await saveDestination(store, "gotify", undefined, signal());
  expect(store.snapshot.effective.targetIds).toEqual(["personal"]);
});
it("rolls back Gotify edits after publication failure and preserves the queue", async () => {
  await saveDestination(store, "gotify", gotify, signal(), false);
  const before = await fs.readFile(store.userPath, "utf8");
  const snapshot = store.snapshot;
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error(gotify.appToken));
  await expect(saveDestination(store, "gotify", { ...gotify, appToken: "replacement" }, signal())).rejects.toThrow(
    "not saved",
  );
  expect(store.snapshot).toBe(snapshot);
  expect(await fs.readFile(store.userPath, "utf8")).toBe(before);
  await saveDestination(store, "gotify", { ...gotify, priority: 0 }, signal());
  expect(store.snapshot.effective.destinations.gotify).toMatchObject({ priority: 0 });
  expect(store.snapshot.effective.targetIds).toEqual([]);
});
it("fails closed on invalid Gotify settings without exposing URL credentials or tokens", () => {
  const snapshot = resolveSettings(
    {
      destinations: { personal: destination, gotify: { ...gotify, serverUrl: "https://user:secret@host" } },
      targetIds: ["personal", "gotify"],
    },
    {},
    providers,
  );
  expect(snapshot.effective.enabled).toBe(false);
  expect(JSON.stringify(snapshot.diagnostics)).not.toMatch(/secret|application-token/);
  const project = resolveSettings({}, { destinations: { gotify } }, providers);
  expect(project.effective.enabled).toBe(false);
  expect(project.effective.destinations).toEqual({});
});
