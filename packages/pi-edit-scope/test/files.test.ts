import type { Dir, Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverScopeFiles,
  MAX_SCOPE_DEPTH,
  MAX_SCOPE_ENTRIES,
  MAX_SCOPE_FILES,
  SCOPE_EXCLUDED_DIRECTORIES,
} from "../src/files.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "scope-files-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function entry(name: string, kind: "file" | "directory" | "symlink" = "file"): Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  } as Dirent;
}

function stats(kind: "file" | "directory" | "symlink" | "other" = "file"): Stats {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  } as Stats;
}

function directory(entries: Dirent[]) {
  let index = 0;
  const read = vi.fn(async () => entries[index++] ?? null);
  const close = vi.fn(async () => {});
  return { handle: { read, close } as unknown as Dir, read, close };
}

describe("cwd discovery", () => {
  it("returns sorted absolute lexical paths, preserves filename spaces, and ignores .gitignore", async () => {
    await fs.mkdir(join(root, "src"));
    await fs.mkdir(join(root, ".hidden-dir"));
    for (const path of [
      "z",
      "src/a",
      "src/ a \u202fb.txt ",
      ".hidden",
      ".hidden-dir/inside",
      ".gitignore",
      "ignored",
    ]) {
      await fs.writeFile(join(root, path), path === ".gitignore" ? "ignored\n" : "before");
    }
    expect(await discoverScopeFiles(join(root, "src", ".."), false)).toEqual([
      join(root, "ignored"),
      join(root, "src/ a \u202fb.txt "),
      join(root, "src/a"),
      join(root, "z"),
    ]);
    const all = await discoverScopeFiles(root, true);
    expect(all).toContain(join(root, ".hidden"));
    expect(all).toContain(join(root, ".hidden-dir/inside"));
    expect(all).toContain(join(root, ".gitignore"));
    expect(all).toEqual([...all].sort());
  });

  it("skips each documented excluded directory at every depth, but not files with those names", async () => {
    await fs.mkdir(join(root, "src"));
    for (const name of SCOPE_EXCLUDED_DIRECTORIES) {
      await fs.mkdir(join(root, name));
      await fs.writeFile(join(root, name, "skip"), "before");
      await fs.mkdir(join(root, "src", name));
      await fs.writeFile(join(root, "src", name, "skip"), "before");
    }
    await fs.mkdir(join(root, "keep"));
    await fs.writeFile(join(root, "keep", "dist"), "before");
    expect(await discoverScopeFiles(root, true)).toEqual([join(root, "keep", "dist")]);
  });

  it("skips symlink entries, including outside directories and dangling links", async () => {
    await fs.mkdir(join(root, "real"));
    await fs.writeFile(join(root, "real", "a"), "before");
    await fs.symlink(join(root, "real", "a"), join(root, "file-alias"), "file");
    await fs.symlink(join(root, "real"), join(root, "dir-alias"), "junction");
    await fs.symlink(dirnameOutside(root), join(root, "outside"), "junction");
    await fs.symlink(join(root, "absent"), join(root, "dangling"), "file");
    expect(await discoverScopeFiles(root, true)).toEqual([join(root, "real", "a")]);
    // A cwd alias retains its lexical prefix; only entries are excluded as symlinks.
    expect(await discoverScopeFiles(join(root, "dir-alias"), true)).toEqual([join(root, "dir-alias", "a")]);
  });

  it.runIf(process.platform !== "win32")(
    "preserves terminal controls in raw paths for the display boundary to sanitize",
    async () => {
      const path = join(root, "unsafe\u001b[31m\n");
      await fs.writeFile(path, "before");
      expect(await discoverScopeFiles(root, false)).toEqual([path]);
    },
  );

  it("does not start from the Git root", async () => {
    await fs.mkdir(join(root, ".git"));
    await fs.writeFile(join(root, "outside-cwd"), "before");
    await fs.mkdir(join(root, "nested"));
    await fs.writeFile(join(root, "nested", "inside"), "before");
    expect(await discoverScopeFiles(join(root, "nested"), false)).toEqual([join(root, "nested", "inside")]);
  });

  it("creates no filesystem entries", async () => {
    await fs.writeFile(join(root, "a"), "before");
    const mkdir = vi.spyOn(fs, "mkdir");
    const write = vi.spyOn(fs, "writeFile");
    const open = vi.spyOn(fs, "open");
    const rename = vi.spyOn(fs, "rename");
    await discoverScopeFiles(root, true);
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
});

function dirnameOutside(path: string) {
  return resolve(path, "..");
}

describe("bounded work and failures", () => {
  it("rejects too many files instead of returning the first page", async () => {
    const dir = directory(Array.from({ length: MAX_SCOPE_FILES + 1 }, (_, index) => entry(`file-${index}`)));
    vi.spyOn(fs, "opendir").mockResolvedValue(dir.handle);
    vi.spyOn(fs, "lstat").mockResolvedValue(stats());
    await expect(discoverScopeFiles(root, true)).rejects.toThrow(`${MAX_SCOPE_FILES} files`);
    expect(dir.close).toHaveBeenCalledOnce();
  });

  it("allows exactly the file cap", async () => {
    const dir = directory(Array.from({ length: MAX_SCOPE_FILES }, (_, index) => entry(`file-${index}`)));
    vi.spyOn(fs, "opendir").mockResolvedValue(dir.handle);
    vi.spyOn(fs, "lstat").mockResolvedValue(stats());
    expect(await discoverScopeFiles(root, false)).toHaveLength(MAX_SCOPE_FILES);
    expect(dir.close).toHaveBeenCalledOnce();
  });

  it("counts hidden and symlink entries toward the entry cap", async () => {
    const dir = directory(
      Array.from({ length: MAX_SCOPE_ENTRIES + 1 }, (_, index) => entry(`.hidden-${index}`, "symlink")),
    );
    vi.spyOn(fs, "opendir").mockResolvedValue(dir.handle);
    const inspect = vi.spyOn(fs, "lstat");
    await expect(discoverScopeFiles(root, false)).rejects.toThrow(`${MAX_SCOPE_ENTRIES} entries`);
    expect(inspect).not.toHaveBeenCalled();
    expect(dir.close).toHaveBeenCalledOnce();
  });

  it("allows exactly the entry cap when every entry is skipped", async () => {
    const dir = directory(Array.from({ length: MAX_SCOPE_ENTRIES }, (_, index) => entry(`.hidden-${index}`)));
    vi.spyOn(fs, "opendir").mockResolvedValue(dir.handle);
    expect(await discoverScopeFiles(root, false)).toEqual([]);
    expect(dir.close).toHaveBeenCalledOnce();
  });

  it.each([MAX_SCOPE_DEPTH, MAX_SCOPE_DEPTH + 1])("enforces depth with cwd at zero (%s)", async (depth) => {
    const handles: ReturnType<typeof directory>[] = [];
    vi.spyOn(fs, "opendir").mockImplementation(async (path) => {
      const current = relative(root, String(path)).split(sep).filter(Boolean).length;
      const dir = directory([entry(current < depth ? "d" : "a", current < depth ? "directory" : "file")]);
      handles.push(dir);
      return dir.handle;
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (path) =>
      stats(String(path).endsWith(`${sep}a`) ? "file" : "directory"),
    );
    if (depth === MAX_SCOPE_DEPTH) {
      expect(await discoverScopeFiles(root, true)).toEqual([
        join(root, ...Array.from({ length: depth }, () => "d"), "a"),
      ]);
    } else {
      await expect(discoverScopeFiles(root, true)).rejects.toThrow(`depth ${MAX_SCOPE_DEPTH}`);
    }
    expect(handles).toHaveLength(MAX_SCOPE_DEPTH + 1);
    for (const dir of handles) expect(dir.close).toHaveBeenCalledOnce();
  });

  it.each(["EACCES", "ENOENT", "EIO", "ENOTDIR"])("reports directory open failure %s", async (code) => {
    const failure = Object.assign(new Error("injected open failure"), { code });
    vi.spyOn(fs, "opendir").mockRejectedValueOnce(failure);
    await expect(discoverScopeFiles(root, true)).rejects.toMatchObject({
      message: expect.stringContaining(code),
      cause: failure,
    });
  });

  it("reports read failure and closes the directory without partial results", async () => {
    const dir = directory([entry("first")]);
    const failure = Object.assign(new Error("injected read failure"), { code: "EIO" });
    dir.read.mockResolvedValueOnce(entry("first")).mockRejectedValueOnce(failure);
    vi.spyOn(fs, "opendir").mockResolvedValueOnce(dir.handle);
    vi.spyOn(fs, "lstat").mockResolvedValue(stats());
    await expect(discoverScopeFiles(root, true)).rejects.toMatchObject({
      message: expect.stringContaining("read directory"),
      cause: failure,
    });
    expect(dir.close).toHaveBeenCalledOnce();
  });

  it("reports entry metadata failure rather than dropping an unreadable file", async () => {
    const dir = directory([entry("a"), entry("b")]);
    const failure = Object.assign(new Error("injected entry failure"), { code: "EACCES" });
    vi.spyOn(fs, "opendir").mockResolvedValueOnce(dir.handle);
    vi.spyOn(fs, "lstat").mockResolvedValueOnce(stats()).mockRejectedValueOnce(failure);
    await expect(discoverScopeFiles(root, true)).rejects.toMatchObject({
      message: expect.stringContaining("inspect entry"),
      cause: failure,
    });
    expect(dir.close).toHaveBeenCalledOnce();
  });

  it("reports close failures", async () => {
    const dir = directory([]);
    const failure = new Error("injected close failure");
    dir.close.mockRejectedValueOnce(failure);
    vi.spyOn(fs, "opendir").mockResolvedValueOnce(dir.handle);
    await expect(discoverScopeFiles(root, true)).rejects.toMatchObject({
      message: expect.stringContaining("close directory"),
      cause: failure,
    });
  });

  it("skips entries changed to symlinks and other nonregular files", async () => {
    const dir = directory([entry("swapped", "directory"), entry("special")]);
    vi.spyOn(fs, "opendir").mockResolvedValueOnce(dir.handle);
    vi.spyOn(fs, "lstat").mockResolvedValueOnce(stats("symlink")).mockResolvedValueOnce(stats("other"));
    expect(await discoverScopeFiles(root, true)).toEqual([]);
    expect(dir.close).toHaveBeenCalledOnce();
  });
});

describe("cancellation", () => {
  it("checks a pre-aborted signal before opening anything", async () => {
    const open = vi.spyOn(fs, "opendir");
    await expect(discoverScopeFiles(root, false, AbortSignal.abort(new Error("stop")))).rejects.toThrow("stop");
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["open", "read", "inspect", "close"])(
    "drains %s before rejecting, and closes every owned handle",
    async (phase) => {
      const dir = directory([entry("a")]);
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const wait = async () => {
        started.resolve();
        await release.promise;
      };
      const open = vi.spyOn(fs, "opendir").mockResolvedValue(dir.handle);
      const inspect = vi.spyOn(fs, "lstat").mockResolvedValue(stats());
      if (phase === "open")
        open.mockImplementationOnce(async () => {
          await wait();
          return dir.handle;
        });
      if (phase === "read")
        dir.read.mockImplementationOnce(async () => {
          await wait();
          return entry("a");
        });
      if (phase === "inspect")
        inspect.mockImplementationOnce(async () => {
          await wait();
          return stats();
        });
      if (phase === "close") dir.close.mockImplementationOnce(wait);
      let settled = false;
      const pending = discoverScopeFiles(root, false, controller.signal).finally(() => {
        settled = true;
      });
      const rejected = expect(pending).rejects.toThrow("stop");
      await started.promise;
      controller.abort(new Error("stop"));
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      await rejected;
      expect(dir.close).toHaveBeenCalledOnce();
      if (phase === "read" || phase === "open") expect(inspect).not.toHaveBeenCalled();
    },
  );
});
