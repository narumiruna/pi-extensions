import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, SettingsStore, validCols } from "../src/settings.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let directory: string;
let store: SettingsStore;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-illustrate-settings-"));
  store = new SettingsStore(join(directory, "agent"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function document(value: unknown) {
  await fs.mkdir(join(directory, "agent"), { recursive: true });
  await fs.writeFile(store.path, JSON.stringify(value));
}

async function stored() {
  return JSON.parse(await fs.readFile(store.path, "utf8"));
}

describe("user settings", () => {
  it("loads missing settings without creating the user directory or any files", async () => {
    expect(await store.load()).toEqual({ settings: defaultSettings() });
    expect(await fs.readdir(directory)).toEqual([]);
    expect(store.path).toBe(join(directory, "agent", "pi-illustrate.json"));
    const snapshot = store.settings;
    snapshot.defaultCols = 99;
    expect(store.settings).toEqual(defaultSettings());
    expect(defaultSettings()).not.toBe(defaultSettings());
  });

  it.each([
    ["auto", true],
    [1, true],
    [Number.MAX_SAFE_INTEGER, true],
    [80, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [Infinity, false],
    [NaN, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    ["80", false],
    ["AUTO", false],
    [null, false],
    [{}, false],
  ])("validates width %j", (value, valid) => {
    expect(validCols(value)).toBe(valid);
  });

  it.each(["auto", "dark", "light"] as const)("loads appearance %s and numeric widths", async (appearance) => {
    await document({ defaultCols: 81, mermaidAppearance: appearance });
    expect(await store.load()).toEqual({ settings: { defaultCols: 81, mermaidAppearance: appearance } });
  });

  it.each(
    [
      null,
      [],
      1,
      "text",
      { defaultCols: 0 },
      { defaultCols: "80" },
      { mermaidAppearance: "system" },
      { defaultCols: 50, mermaidAppearance: false },
    ].map((value) => ({ value })),
  )("warns on invalid documents and refuses UI replacement: $value", async ({ value }) => {
    await document(value);
    const original = await fs.readFile(store.path, "utf8");
    const loaded = await store.load();
    expect(loaded.settings).toEqual(defaultSettings());
    expect(loaded.warning).toContain("Cannot load Illustrate settings");
    await expect(store.save({ defaultCols: 90 })).rejects.toThrow();
    expect(await fs.readFile(store.path, "utf8")).toBe(original);
  });

  it("protects malformed JSON, keeps the last valid values, and recovers after repair", async () => {
    await store.save({ defaultCols: 70 });
    await fs.writeFile(store.path, "{");
    expect((await store.load()).settings.defaultCols).toBe(70);
    expect((await store.load()).warning).toBeDefined();
    await expect(store.save({ mermaidAppearance: "dark" })).rejects.toThrow();
    expect(await fs.readFile(store.path, "utf8")).toBe("{");
    await document({ defaultCols: 45 });
    expect((await store.load()).settings.defaultCols).toBe(45);
    await store.save({ mermaidAppearance: "light" });
    expect(await stored()).toEqual({ defaultCols: 45, mermaidAppearance: "light" });
  });

  it("returns read errors without output or loss of the last valid settings", async () => {
    await store.save({ defaultCols: 77 });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("private-path: secret-value"), { code: "EACCES" }),
    );
    const loaded = await store.load();
    expect(loaded.settings.defaultCols).toBe(77);
    expect(loaded.warning).toContain("EACCES");
    expect(loaded.warning).not.toContain("private-path");
    expect(loaded.warning).not.toContain("secret-value");
    await store.save({ defaultCols: 78 });
    expect((await store.load()).settings.defaultCols).toBe(78);
  });

  it("creates only the explicit user setting on the first save", async () => {
    await store.save({ defaultCols: 100 });
    expect(await stored()).toEqual({ defaultCols: 100 });
    expect(store.settings).toEqual({ defaultCols: 100, mermaidAppearance: "auto" });
    expect(await fs.readdir(join(directory, "agent"))).toEqual(["pi-illustrate.json"]);
  });

  it("reads the latest valid document and preserves unknown nested fields and unknown keys", async () => {
    await document({ defaultCols: 40, future: { colors: ["a", "b"] } });
    await store.load();
    await document({ defaultCols: 55, future: { newer: true }, extra: "external change" });
    await store.save({ mermaidAppearance: "dark" });
    expect(await stored()).toEqual({
      defaultCols: 55,
      mermaidAppearance: "dark",
      future: { newer: true },
      extra: "external change",
    });
    expect(store.settings).toEqual({ defaultCols: 55, mermaidAppearance: "dark" });
  });

  it("preserves special unknown keys without changing object prototypes", async () => {
    await document(JSON.parse('{"__proto__":{"future":true},"constructor":{"value":1},"defaultCols":40}'));
    await store.save({ mermaidAppearance: "dark" });
    const latest = await stored();
    expect(Object.hasOwn(latest, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(latest, "__proto__")?.value).toEqual({ future: true });
    expect(latest.constructor).toEqual({ value: 1 });
    expect(Object.getPrototypeOf(store.settings)).toBe(Object.prototype);
  });

  it("rejects invalid patch values without touching the file or poisoning the queue", async () => {
    await expect(store.save({ defaultCols: 0 })).rejects.toThrow("defaultCols");
    await expect(store.save({ mermaidAppearance: undefined })).rejects.toThrow("mermaidAppearance");
    expect(await fs.readdir(directory)).toEqual([]);
    await store.save({ defaultCols: "auto" });
    expect((await store.load()).warning).toBeUndefined();
  });

  it.each([null, [], { unexpected: true }, { defaultCols: "auto", extra: 1 }])(
    "rejects malformed or unknown patch fields %#",
    async (patch) => {
      await expect(store.save(patch as Parameters<typeof store.save>[0])).rejects.toThrow();
      expect(await fs.readdir(directory)).toEqual([]);
      await store.save({ defaultCols: 50 });
      expect(store.settings.defaultCols).toBe(50);
    },
  );

  it("rejects asynchronous application without waiting for an unowned pending promise", async () => {
    await store.save({ defaultCols: 60 });
    const apply = vi.fn((next: ReturnType<typeof defaultSettings>) =>
      next.defaultCols === 80 ? new Promise<void>(() => {}) : undefined,
    );
    await expect(store.save({ defaultCols: 80 }, { apply })).rejects.toThrow("synchronous");
    expect(store.settings.defaultCols).toBe(60);
    expect((await stored()).defaultCols).toBe(60);
    expect(apply.mock.calls.map(([next]) => next.defaultCols)).toEqual([80, 60]);
    await store.save({ defaultCols: 90 });
    expect(store.settings.defaultCols).toBe(90);
  });

  it("does not disclose malformed document contents in a load warning", async () => {
    await fs.mkdir(join(directory, "agent"), { recursive: true });
    await fs.writeFile(store.path, '{"secret":"do-not-quote-this"');
    const loaded = await store.load();
    expect(loaded.warning).toContain("not valid JSON");
    expect(loaded.warning).not.toContain("do-not-quote-this");
  });

  it("keeps same-field saves in action order across stores while an earlier write is pending", async () => {
    const entered = gate();
    const release = gate();
    const write = fs.writeFile;
    let first = true;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (first && String(args[0]).endsWith(".tmp")) {
        first = false;
        entered.release();
        await release.promise;
      }
      return write(...args);
    });
    const applied: number[] = [];
    const options = {
      apply: (next: ReturnType<typeof defaultSettings>) => {
        applied.push(next.defaultCols as number);
      },
    };
    const one = store.save({ defaultCols: 20 }, options);
    await entered.promise;
    const two = store.save({ defaultCols: 30 }, options);
    const other = new SettingsStore(join(directory, "agent"));
    const three = other.save({ defaultCols: 40 }, options);
    release.release();
    await Promise.all([one, two, three]);
    expect(applied).toEqual([20, 30, 40]);
    expect((await stored()).defaultCols).toBe(40);
  });

  it("serializes action order and observes a pending save before load and flush", async () => {
    const entered = gate();
    const release = gate();
    const original = fs.writeFile;
    let first = true;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".tmp") && first) {
        first = false;
        entered.release();
        await release.promise;
      }
      return original(...args);
    });
    const applied: number[] = [];
    const firstSave = store.save({ defaultCols: 20 }, { apply: (next) => applied.push(next.defaultCols as number) });
    const secondSave = store.save({ defaultCols: 30 }, { apply: (next) => applied.push(next.defaultCols as number) });
    const loading = store.load();
    let flushed = false;
    const flushing = store.flush().then(() => {
      flushed = true;
    });
    await entered.promise;
    expect(flushed).toBe(false);
    expect(applied).toEqual([]);
    release.release();
    await Promise.all([firstSave, secondSave, flushing]);
    expect((await loading).settings.defaultCols).toBe(30);
    expect(applied).toEqual([20, 30]);
    expect((await stored()).defaultCols).toBe(30);
  });

  it("finishes an earlier load before a subsequent write can publish", async () => {
    await document({ defaultCols: 22 });
    const entered = gate();
    const release = gate();
    const original = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
      const bytes = await original(...args);
      entered.release();
      await release.promise;
      return bytes;
    });
    const loading = store.load();
    await entered.promise;
    const saving = store.save({ defaultCols: 99 });
    release.release();
    expect((await loading).settings.defaultCols).toBe(22);
    await saving;
    expect(store.settings.defaultCols).toBe(99);
    expect((await stored()).defaultCols).toBe(99);
  });

  it("orders multiple stores and Pi file mutations targeting the same path", async () => {
    await document({ future: 1 });
    const entered = gate();
    const release = gate();
    const mutation = withFileMutationQueue(store.path, async () => {
      entered.release();
      await release.promise;
      await fs.writeFile(store.path, JSON.stringify({ future: 2 }));
    });
    await entered.promise;
    const other = new SettingsStore(join(directory, "agent"));
    const first = store.save({ defaultCols: 25 });
    const second = other.save({ mermaidAppearance: "light" });
    release.release();
    await Promise.all([mutation, first, second]);
    expect(await stored()).toEqual({ future: 2, defaultCols: 25, mermaidAppearance: "light" });
  });

  it.each(["writeFile", "rename"] as const)(
    "retains disk and runtime after %s failure, cleans temporary files, then recovers",
    async (method) => {
      await store.save({ defaultCols: 60 });
      const original = await fs.readFile(store.path, "utf8");
      const apply = vi.fn();
      vi.spyOn(fs, method).mockRejectedValueOnce(new Error("disk unavailable"));
      await expect(store.save({ defaultCols: 80 }, { apply })).rejects.toThrow("disk unavailable");
      expect(store.settings.defaultCols).toBe(60);
      expect(await fs.readFile(store.path, "utf8")).toBe(original);
      expect(await fs.readdir(join(directory, "agent"))).toEqual(["pi-illustrate.json"]);
      if (method === "rename") {
        expect(apply.mock.calls.map(([next]) => next.defaultCols)).toEqual([80, 60]);
      } else expect(apply).not.toHaveBeenCalled();
      await store.save({ defaultCols: 90 });
      expect((await store.load()).settings.defaultCols).toBe(90);
      await store.flush();
    },
  );

  it("publishes by same-directory rename while the original file remains readable before publication", async () => {
    await store.save({ defaultCols: 33 });
    const original = fs.rename;
    const evidence: Array<{ source: string; target: string; before: number }> = [];
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      evidence.push({ source: String(source), target: String(target), before: (await stored()).defaultCols });
      await original(source, target);
    });
    await store.save({ defaultCols: 44 });
    expect(evidence).toEqual([
      { source: expect.stringMatching(/pi-illustrate\.json\..+\.tmp$/), target: store.path, before: 33 },
    ]);
    expect(evidence[0]?.source.startsWith(`${store.path}.`)).toBe(true);
    expect((await stored()).defaultCols).toBe(44);
  });

  it("rolls back a partially applied runtime change before file publication", async () => {
    await store.save({ mermaidAppearance: "dark" });
    const original = await fs.readFile(store.path, "utf8");
    let appearance = "dark";
    const values: string[] = [];
    const apply = (next: ReturnType<typeof defaultSettings>) => {
      appearance = next.mermaidAppearance;
      values.push(appearance);
      if (appearance === "light") throw new Error("apply failed");
    };
    await expect(store.save({ mermaidAppearance: "light" }, { apply })).rejects.toThrow("apply failed");
    expect(values).toEqual(["light", "dark"]);
    expect(appearance).toBe("dark");
    expect(store.settings.mermaidAppearance).toBe("dark");
    expect(await fs.readFile(store.path, "utf8")).toBe(original);
    await store.save({ defaultCols: 12 });
  });

  it("exposes application rollback failure and leaves subsequent operations usable", async () => {
    const apply = vi.fn(() => {
      throw new Error("application unavailable");
    });
    await expect(store.save({ defaultCols: 13 }, { apply })).rejects.toBeInstanceOf(AggregateError);
    expect(store.settings).toEqual(defaultSettings());
    await store.save({ defaultCols: 14 });
    expect((await store.load()).settings.defaultCols).toBe(14);
  });

  it.each(["signal", "generation"] as const)("rejects stale %s before staging", async (kind) => {
    const controller = new AbortController();
    controller.abort();
    const options = kind === "signal" ? { signal: controller.signal } : { isCurrent: () => false };
    await expect(store.save({ defaultCols: 90 }, options)).rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.readdir(directory)).toEqual([]);
    expect(store.settings).toEqual(defaultSettings());
  });

  it("rechecks ownership after staging and never applies or publishes stale work", async () => {
    await store.save({ defaultCols: 60 });
    const original = fs.writeFile;
    let active = true;
    const apply = vi.fn();
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await original(...args);
      active = false;
    });
    await expect(store.save({ defaultCols: 70 }, { isCurrent: () => active, apply })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(apply).not.toHaveBeenCalled();
    expect((await stored()).defaultCols).toBe(60);
    expect(store.settings.defaultCols).toBe(60);
  });

  it.each([false, true])(
    "restores original bytes after ownership changes during rename (existing=%s)",
    async (exists) => {
      if (exists) await store.save({ defaultCols: 60 });
      const original = fs.rename;
      const controller = new AbortController();
      vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
        await original(...args);
        controller.abort();
      });
      const apply = vi.fn();
      await expect(store.save({ defaultCols: 70 }, { signal: controller.signal, apply })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(store.settings.defaultCols).toBe(exists ? 60 : "auto");
      if (exists) expect((await stored()).defaultCols).toBe(60);
      else await expect(fs.stat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(apply.mock.calls.map(([next]) => next.defaultCols)).toEqual([70, exists ? 60 : "auto"]);
    },
  );
});
