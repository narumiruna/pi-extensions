import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeSettingsStore } from "../settings.ts";

let root: string;
let path: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "scope-settings-"));
  path = join(root, "agent", "pi-scope.json");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function put(text: string) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text);
}

async function disk() {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

function holdNextRename() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = fs.rename;
  const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
    started.resolve();
    await release.promise;
    await original(...args);
  });
  return { started: started.promise, release: release.resolve, rename };
}

describe("loading and validation", () => {
  it("loads missing settings without creating a file, directory, or temporary resource", async () => {
    const store = new ScopeSettingsStore(path);
    const mkdir = vi.spyOn(fs, "mkdir");
    const open = vi.spyOn(fs, "open");
    const write = vi.spyOn(fs, "writeFile");
    expect(store.current).toEqual({ showHiddenFiles: false });
    expect(await store.load()).toEqual({ showHiddenFiles: false });
    await store.flush();
    expect(await fs.readdir(root)).toEqual([]);
    expect(mkdir).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("loads valid settings and isolates returned objects from effective state", async () => {
    await put('{"showHiddenFiles":true,"unknown":{"keep":[1,2]}}');
    const store = new ScopeSettingsStore(path);
    const loaded = await store.load();
    loaded.showHiddenFiles = false;
    const current = store.current;
    current.showHiddenFiles = false;
    expect(store.current).toEqual({ showHiddenFiles: true });
    expect(await fs.readFile(path, "utf8")).toBe('{"showHiddenFiles":true,"unknown":{"keep":[1,2]}}');
  });

  it("uses the default when the owned field is absent or the file is removed", async () => {
    await put('{"showHiddenFiles":true}');
    const store = new ScopeSettingsStore(path);
    await store.load();
    await put('{"unknown":3}');
    expect(await store.load()).toEqual({ showHiddenFiles: false });
    await put('{"showHiddenFiles":true}');
    await store.load();
    await fs.unlink(path);
    expect(await store.load()).toEqual({ showHiddenFiles: false });
  });

  it.each([
    "",
    "{broken",
    "null",
    "[]",
    "true",
    "1",
    '"text"',
    '{"showHiddenFiles":null}',
    '{"showHiddenFiles":"true"}',
    '{"showHiddenFiles":1}',
    '{"showHiddenFiles":{}}',
  ])("rejects invalid existing documents without losing effective state or replacing bytes: %j", async (invalid) => {
    await put('{"showHiddenFiles":true}');
    const store = new ScopeSettingsStore(path);
    await store.load();
    await put(invalid);
    await expect(store.load()).rejects.toThrow("Invalid Scope settings");
    expect(store.current).toEqual({ showHiddenFiles: true });
    await expect(store.saveShowHiddenFiles(false)).rejects.toThrow("Invalid Scope settings");
    expect(store.current).toEqual({ showHiddenFiles: true });
    expect(await fs.readFile(path, "utf8")).toBe(invalid);
    expect(await fs.readdir(dirname(path))).toEqual([basename(path)]);
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("does not treat lstat %s as absent", async (code) => {
    const store = new ScopeSettingsStore(path);
    const failure = Object.assign(new Error("injected metadata failure"), { code });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    await expect(store.load()).rejects.toBe(failure);
    await expect(store.saveShowHiddenFiles(true)).rejects.toBe(failure);
    expect(store.current).toEqual({ showHiddenFiles: false });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["ENOENT", "EACCES", "EIO"])(
    "does not treat read failure %s after successful lstat as a missing file",
    async (code) => {
      await put('{"showHiddenFiles":true}');
      const store = new ScopeSettingsStore(path);
      await store.load();
      const failure = Object.assign(new Error("injected read failure"), { code });
      vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
      const create = vi.spyOn(fs, "open");
      await expect(store.load()).rejects.toBe(failure);
      await expect(store.saveShowHiddenFiles(false)).rejects.toBe(failure);
      expect(store.current).toEqual({ showHiddenFiles: true });
      expect(create).not.toHaveBeenCalled();
      expect(await fs.readFile(path, "utf8")).toBe('{"showHiddenFiles":true}');
    },
  );

  it.each([false, true])(
    "rejects settings-file symlinks (dangling=%s) without changing their referents",
    async (dangling) => {
      await fs.mkdir(dirname(path));
      const referent = join(root, "referent.json");
      if (!dangling) await fs.writeFile(referent, '{"showHiddenFiles":true}');
      await fs.symlink(referent, path, "file");
      const store = new ScopeSettingsStore(path);
      await expect(store.load()).rejects.toThrow("not a symlink");
      await expect(store.saveShowHiddenFiles(true)).rejects.toThrow("not a symlink");
      expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
      if (!dangling) expect(await fs.readFile(referent, "utf8")).toBe('{"showHiddenFiles":true}');
      else await expect(fs.lstat(referent)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a directory used as the settings file", async () => {
    await fs.mkdir(path, { recursive: true });
    const store = new ScopeSettingsStore(path);
    await expect(store.load()).rejects.toThrow("regular file");
    await expect(store.saveShowHiddenFiles(true)).rejects.toThrow("regular file");
    expect((await fs.lstat(path)).isDirectory()).toBe(true);
  });
});

describe("atomic saves", () => {
  it("creates settings only on explicit save with same-directory temporary rename", async () => {
    const store = new ScopeSettingsStore(path);
    const rename = vi.spyOn(fs, "rename");
    expect(await store.saveShowHiddenFiles(true)).toEqual({ showHiddenFiles: true });
    await store.flush();
    expect(await disk()).toEqual({ showHiddenFiles: true });
    expect(store.current).toEqual({ showHiddenFiles: true });
    const [source, destination] = rename.mock.calls[0] ?? [];
    expect(dirname(String(source))).toBe(dirname(path));
    expect(source).not.toBe(path);
    expect(destination).toBe(path);
    expect(await fs.readdir(dirname(path))).toEqual([basename(path)]);
    if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves latest unknown fields, including __proto__, rather than a cached snapshot", async () => {
    await put('{"showHiddenFiles":false,"unknown":{"v":1},"__proto__":{"keep":true}}');
    const store = new ScopeSettingsStore(path);
    await store.load();
    await put('{"showHiddenFiles":false,"unknown":{"v":2},"newField":[1,2],"__proto__":{"keep":true}}');
    await store.saveShowHiddenFiles(true);
    expect(await disk()).toEqual(
      JSON.parse('{"showHiddenFiles":true,"unknown":{"v":2},"newField":[1,2],"__proto__":{"keep":true}}'),
    );
  });

  it("keeps the previous file and effective value until publication completes", async () => {
    await put('{"showHiddenFiles":false,"keep":3}');
    const store = new ScopeSettingsStore(path);
    await store.load();
    const held = holdNextRename();
    const pending = store.saveShowHiddenFiles(true);
    await held.started;
    expect(await disk()).toEqual({ showHiddenFiles: false, keep: 3 });
    expect(store.current).toEqual({ showHiddenFiles: false });
    expect(await fs.readdir(dirname(path))).toHaveLength(2);
    held.release();
    await pending;
    expect(await disk()).toEqual({ showHiddenFiles: true, keep: 3 });
    expect(await fs.readdir(dirname(path))).toEqual([basename(path)]);
  });

  it.runIf(process.platform !== "win32")("retains private existing file permissions", async () => {
    await put('{"showHiddenFiles":false}');
    await fs.chmod(path, 0o600);
    await new ScopeSettingsStore(path).saveShowHiddenFiles(true);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid runtime values without creating anything", async () => {
    const store = new ScopeSettingsStore(path);
    await expect(store.saveShowHiddenFiles("true" as unknown as boolean)).rejects.toThrow("must be a boolean");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["mkdir", "open", "write", "close", "rename"])(
    "retains disk/effective state and removes owned temp files after %s failure",
    async (phase) => {
      await put('{"showHiddenFiles":true,"keep":3}');
      const before = await fs.readFile(path, "utf8");
      const store = new ScopeSettingsStore(path);
      await store.load();
      const failure = Object.assign(new Error(`injected ${phase} failure`), { code: "EIO" });
      if (phase === "mkdir") vi.spyOn(fs, "mkdir").mockRejectedValueOnce(failure);
      if (phase === "open") vi.spyOn(fs, "open").mockRejectedValueOnce(failure);
      if (phase === "rename") vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
      if (phase === "write" || phase === "close") {
        const original = fs.open;
        vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
          const handle = await original(...args);
          if (phase === "write") vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
          else vi.spyOn(handle, "close").mockRejectedValueOnce(failure);
          return handle;
        });
      }
      await expect(store.saveShowHiddenFiles(false)).rejects.toBe(failure);
      expect(store.current).toEqual({ showHiddenFiles: true });
      expect(await fs.readFile(path, "utf8")).toBe(before);
      expect(await fs.readdir(dirname(path))).toEqual([basename(path)]);
      // A failed operation must not poison the shared queue or the instance.
      expect(await store.saveShowHiddenFiles(false)).toEqual({ showHiddenFiles: false });
      await store.flush();
      expect(await disk()).toEqual({ showHiddenFiles: false, keep: 3 });
    },
  );

  it("uses exclusive temp creation and never removes a temp file it did not create", async () => {
    await put('{"showHiddenFiles":false}');
    const store = new ScopeSettingsStore(path);
    const collision = Object.assign(new Error("injected temp collision"), { code: "EEXIST" });
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(collision);
    const unlink = vi.spyOn(fs, "unlink");
    await expect(store.saveShowHiddenFiles(true)).rejects.toBe(collision);
    expect(open.mock.calls[0]?.[1]).toBe("wx");
    expect(unlink).not.toHaveBeenCalled();
    expect(await disk()).toEqual({ showHiddenFiles: false });
  });

  it("reports cleanup failure with the original error and keeps the previous effective state", async () => {
    await put('{"showHiddenFiles":false}');
    const store = new ScopeSettingsStore(path);
    const publishError = new Error("injected rename failure");
    const cleanupError = new Error("injected unlink failure");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(publishError);
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(cleanupError);
    let caught: unknown;
    try {
      await store.saveShowHiddenFiles(true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([publishError, cleanupError]);
    expect(store.current).toEqual({ showHiddenFiles: false });
    expect(await disk()).toEqual({ showHiddenFiles: false });
    await store.saveShowHiddenFiles(true);
    expect(store.current).toEqual({ showHiddenFiles: true });
  });
});

describe("shared in-process ordering", () => {
  it("queues a load behind a pending save in another instance of the same normalized path", async () => {
    await put('{"showHiddenFiles":false}');
    const first = new ScopeSettingsStore(path);
    const second = new ScopeSettingsStore(join(dirname(path), ".", basename(path)));
    const held = holdNextRename();
    const save = first.saveShowHiddenFiles(true);
    await held.started;
    let loaded = false;
    const load = second.load().then((value) => {
      loaded = true;
      return value;
    });
    await Promise.resolve();
    expect(loaded).toBe(false);
    held.release();
    await save;
    expect(await load).toEqual({ showHiddenFiles: true });
    expect(second.current).toEqual({ showHiddenFiles: true });
  });

  it("saves in request order across instances and reads each latest valid document", async () => {
    await put('{"showHiddenFiles":false,"keep":{"v":1}}');
    const first = new ScopeSettingsStore(path);
    const second = new ScopeSettingsStore(path);
    const held = holdNextRename();
    const saveTrue = first.saveShowHiddenFiles(true);
    await held.started;
    const saveFalse = second.saveShowHiddenFiles(false);
    const reload = first.load();
    held.release();
    expect(await saveTrue).toEqual({ showHiddenFiles: true });
    expect(await saveFalse).toEqual({ showHiddenFiles: false });
    expect(await reload).toEqual({ showHiddenFiles: false });
    expect(await disk()).toEqual({ showHiddenFiles: false, keep: { v: 1 } });
  });

  it("recovers queued reads/saves after a publication fails", async () => {
    await put('{"showHiddenFiles":true,"keep":3}');
    const first = new ScopeSettingsStore(path);
    const second = new ScopeSettingsStore(path);
    await first.load();
    const failure = new Error("injected rename failure");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    const rejected = expect(first.saveShowHiddenFiles(false)).rejects.toBe(failure);
    const loaded = second.load();
    const saved = second.saveShowHiddenFiles(false);
    await rejected;
    expect(await loaded).toEqual({ showHiddenFiles: true });
    expect(await saved).toEqual({ showHiddenFiles: false });
    expect(first.current).toEqual({ showHiddenFiles: true });
    expect(await disk()).toEqual({ showHiddenFiles: false, keep: 3 });
  });

  it("flush drains earlier operations from every store targeting the same path", async () => {
    const first = new ScopeSettingsStore(path);
    const second = new ScopeSettingsStore(path);
    const held = holdNextRename();
    const pending = first.saveShowHiddenFiles(true);
    await held.started;
    let flushed = false;
    const flush = second.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    held.release();
    await Promise.all([pending, flush]);
    expect(flushed).toBe(true);
    expect(await disk()).toEqual({ showHiddenFiles: true });
  });

  it("does not block a different settings path behind a pending save", async () => {
    const first = new ScopeSettingsStore(path);
    const other = new ScopeSettingsStore(join(root, "other.json"));
    const held = holdNextRename();
    const pending = first.saveShowHiddenFiles(true);
    await held.started;
    expect(await other.saveShowHiddenFiles(true)).toEqual({ showHiddenFiles: true });
    held.release();
    await pending;
  });

  it("keeps state after a failed load and resumes once the document is repaired", async () => {
    await put('{"showHiddenFiles":true}');
    const store = new ScopeSettingsStore(path);
    await store.load();
    await put("bad JSON");
    await expect(store.load()).rejects.toThrow("Invalid Scope settings");
    expect(store.current).toEqual({ showHiddenFiles: true });
    await put('{"showHiddenFiles":false,"repaired":true}');
    expect(await store.load()).toEqual({ showHiddenFiles: false });
    await store.saveShowHiddenFiles(true);
    expect(await disk()).toEqual({ showHiddenFiles: true, repaired: true });
  });
});
