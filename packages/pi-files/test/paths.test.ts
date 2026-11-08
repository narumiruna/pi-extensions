import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertScopeTarget, resolveScopeTarget, resolveWritePath } from "../src/scope/paths.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "scope-paths-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

// Branch inventory from installed tools/{write,edit,path-utils}.js and utils/paths.js:
// no trim; each Unicode-space replacement; exactly one leading @; native Windows
// shell-path conditions; bare/prefixed/non-leading tilde; case-sensitive file://;
// URL decoding/errors; absolute/relative resolution; separate cwd normalization.
const unicodeSpaces = [
  "\u00a0",
  ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)),
  "\u202f",
  "\u205f",
  "\u3000",
];
const nativeCases = [
  "a.txt",
  "./a.txt",
  "dir/../a.txt",
  "../outside.txt",
  "@a.txt",
  "@@a.txt",
  "a@b.txt",
  "@~/a.txt",
  "~",
  "~/a.txt",
  "~/",
  "~/../a.txt",
  "~someone/a.txt",
  "a/~/b",
  "~\\a.txt",
  " a.txt ",
  " ~",
  "@ @a.txt",
  "\u202f@a.txt",
  "@a\u202f.txt",
  "   ",
  "",
  "@",
  "\ta.txt\n",
  "a\u200bb.txt",
  "a\ufeffb.txt",
  "a\u1680b.txt",
  "file:/not-a-url",
  "FILE:///not-a-url",
  "https://example.test/a",
  "npm:thing",
  "C:\\dir\\file.txt",
  "C:relative.txt",
  "\\\\server\\share\\file.txt",
  "/c",
  "/c/",
  "/c/dir/file",
  "/mnt/c/dir/file",
  "/cygdrive/C/dir/file",
  "/mnt/c",
  "/cygdrive/c",
  "//server/share/file",
  "/c/dir\\file",
  "/c/dir//file",
  "/cc/dir",
  "/mnt/cc/dir",
  "/mnt/c:/dir",
  "/1/dir",
  ...unicodeSpaces.map((space) => `a${space}b.txt`),
];

async function observeBuiltins(raw: string, cwd: string, contextCwd = cwd) {
  const written: string[] = [];
  const edited: string[] = [];
  const made: string[] = [];
  const write = createWriteToolDefinition(cwd, {
    operations: {
      mkdir: async (path) => {
        made.push(path);
      },
      writeFile: async (path) => {
        written.push(path);
      },
    },
  });
  const edit = createEditToolDefinition(cwd, {
    operations: {
      access: async (path) => {
        edited.push(path);
      },
      readFile: async (path) => {
        edited.push(path);
        return Buffer.from("before");
      },
      writeFile: async (path) => {
        edited.push(path);
      },
    },
  });
  const ctx = { cwd: contextCwd } as ExtensionToolContext;
  await write.execute("conformance-write", { path: raw, content: "after" }, undefined, undefined, ctx);
  await edit.execute(
    "conformance-edit",
    { path: raw, edits: [{ oldText: "before", newText: "after" }] },
    undefined,
    undefined,
    ctx,
  );
  return { written, edited, made };
}

describe("built-in write/edit lexical conformance", () => {
  it.each(nativeCases)("matches public operation targets for %j", async (raw) => {
    const expected = resolveWritePath(raw, root);
    const actual = await observeBuiltins(raw, root);
    expect(actual).toEqual({ written: [expected], edited: [expected, expected, expected], made: [dirname(expected)] });
  });

  it("matches absolute paths, @absolute paths, and file URL branches", async () => {
    const absolute = join(root, "a b.txt");
    const url = pathToFileURL(absolute).href;
    for (const raw of [
      absolute,
      `@${absolute}`,
      url,
      `@${url}`,
      `${url}?ignored=yes#ignored`,
      url.replace("file:///", "file://localhost/"),
      pathToFileURL(join(root, "a\u202fb.txt")).href,
      `file://${join(root, "a\u202fb.txt")}`,
    ]) {
      const expected = resolveWritePath(raw, root);
      const actual = await observeBuiltins(raw, root);
      expect(actual.written).toEqual([expected]);
      expect(actual.edited).toEqual([expected, expected, expected]);
    }
    // Percent decoding occurs after Unicode-space normalization, so these differ.
    expect(resolveWritePath(pathToFileURL(join(root, "a\u202fb.txt")).href, root)).toBe(join(root, "a\u202fb.txt"));
    expect(resolveWritePath(" a.txt ", root)).toBe(join(root, " a.txt "));
    expect(resolveWritePath("@@a.txt", root)).toBe(join(root, "@a.txt"));
    expect(resolveWritePath("~", root)).toBe(resolve(homedir()));
  });

  it.each(["file:///bad%xx", "file:///bad%2Fseparator"])("matches invalid URL errors for %s", async (raw) => {
    expect(() => resolveWritePath(raw, root)).toThrow();
    await expect(observeBuiltins(raw, root)).rejects.toThrow();
  });

  it("retains NUL lexically but rejects it in filesystem target resolution and native operations", async () => {
    expect(resolveWritePath("a\0b", root)).toBe(join(root, "a\0b"));
    await expect(observeBuiltins("a\0b", root)).rejects.toThrow();
    await expect(resolveScopeTarget("a\0b", root, "either")).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("rejects foreign file URL authorities on POSIX", async () => {
    expect(() => resolveWritePath("file://remote/share/a", root)).toThrow();
    await expect(observeBuiltins("file://remote/share/a", root)).rejects.toThrow();
  });

  it("normalizes cwd without stripping @ or replacing its Unicode spaces", async () => {
    for (const cwd of [
      join(root, "@base\u202fdir"),
      pathToFileURL(join(root, "url base")).href,
      "~/scope-base",
      ".",
      "~",
    ]) {
      const expected = resolveWritePath("a.txt", cwd);
      const actual = await observeBuiltins("a.txt", "ignored-factory-cwd", cwd);
      expect(actual.written).toEqual([expected]);
      expect(actual.edited).toEqual([expected, expected, expected]);
    }
    expect(resolveWritePath("a.txt", join(root, "@base\u202fdir"))).toBe(join(root, "@base\u202fdir", "a.txt"));
  });

  it("still normalizes cwd before resolving an absolute target", async () => {
    const badCwd = "file:///bad%xx";
    expect(() => resolveWritePath(join(root, "a"), badCwd)).toThrow();
    await expect(observeBuiltins(join(root, "a"), badCwd)).rejects.toThrow();
  });

  it.each([null, 12, {}, []])("rejects non-string native input %j", async (raw) => {
    expect(() => resolveWritePath(raw as unknown as string, root)).toThrow();
    await expect(observeBuiltins(raw as unknown as string, root)).rejects.toThrow();
  });

  it("matches the factory cwd fallback when the context cwd is empty", async () => {
    expect((await observeBuiltins("a.txt", root, "")).written).toEqual([resolveWritePath("a.txt", root)]);
  });

  it.runIf(process.platform === "win32")(
    "normalizes Windows shell drives, tilde separators, and UNC forms",
    async () => {
      expect(resolveWritePath("/mnt/c/dir/file", root)).toBe("C:\\dir\\file");
      expect(resolveWritePath("/cygdrive/d", root)).toBe("D:\\");
      expect(resolveWritePath("/e", root)).toBe("E:\\");
      expect(resolveWritePath("~\\a", root)).toBe(join(homedir(), "a"));
      expect(resolveWritePath("\\\\server\\share\\a", root)).toBe("\\\\server\\share\\a");
    },
  );
});

describe("canonical targets", () => {
  it("resolves existing files and exact missing suffixes without creating anything", async () => {
    const path = join(root, "existing.txt");
    await fs.writeFile(path, "before");
    const canonicalRoot = await fs.realpath(root);
    expect(await resolveScopeTarget("existing.txt", root, "existing")).toEqual({
      path,
      canonical: join(canonicalRoot, "existing.txt"),
      exists: true,
    });
    const before = await fs.readdir(root);
    expect(await resolveScopeTarget("new/deep/ a.txt ", root, "new")).toEqual({
      path: join(root, "new/deep/ a.txt "),
      canonical: join(canonicalRoot, "new/deep/ a.txt "),
      exists: false,
    });
    expect(await fs.readdir(root)).toEqual(before);
    await expect(resolveScopeTarget("existing.txt", root, "new")).rejects.toThrow("already exists");
    await expect(resolveScopeTarget("missing.txt", root, "existing")).rejects.toThrow("does not exist");
    await expect(resolveScopeTarget(".", root, "either")).rejects.toThrow("regular file");
    await expect(resolveScopeTarget("a\0b", root, "either")).rejects.toThrow();
  });

  it("uses native filename matching without read-only macOS fallbacks", async () => {
    for (const [typed, actual] of [
      ["Screenshot 9 PM.png", "Screenshot 9\u202fPM.png"],
      ["caf\u00e9.txt", "cafe\u0301.txt"],
      ["l'ami.txt", "l\u2019ami.txt"],
      ["caf\u00e9 l'ami.txt", "cafe\u0301 l\u2019ami.txt"],
    ]) {
      await fs.writeFile(join(root, actual), "before");
      const path = join(root, typed);
      expect(resolveWritePath(typed, root)).toBe(path);
      // Some filesystems resolve Unicode-equivalent names without an application fallback.
      const canonical = await fs.realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (canonical === undefined) {
        await expect(resolveScopeTarget(typed, root, "existing")).rejects.toThrow("does not exist");
      } else {
        expect(await resolveScopeTarget(typed, root, "existing")).toEqual({ path, canonical, exists: true });
      }
    }
  });

  it("resolves symlink files and missing targets through existing directory aliases", async () => {
    await fs.mkdir(join(root, "real"));
    await fs.writeFile(join(root, "real", "a"), "before");
    await fs.symlink(join(root, "real"), join(root, "alias"), "junction");
    await fs.symlink(join(root, "real", "a"), join(root, "linked"), "file");
    const canonical = await fs.realpath(join(root, "real", "a"));
    expect((await resolveScopeTarget("linked", root, "existing")).canonical).toBe(canonical);
    expect((await resolveScopeTarget("alias/new/deep", root, "new")).canonical).toBe(
      join(dirname(canonical), "new/deep"),
    );
  });

  it("rejects dangling final and ancestor links, loops, and non-directory ancestors", async () => {
    await fs.symlink(join(root, "absent"), join(root, "dangling"), "file");
    await fs.symlink(join(root, "loop"), join(root, "loop"), "file");
    await fs.writeFile(join(root, "plain"), "before");
    for (const path of ["dangling", "dangling/new/a", "loop", "plain/new/a"]) {
      await expect(resolveScopeTarget(path, root, "either")).rejects.toThrow();
    }
    expect(await fs.readdir(root)).toEqual(["dangling", "loop", "plain"]);
  });

  it("rejects hardlinks, including links added after selection", async () => {
    await fs.writeFile(join(root, "a"), "before");
    const selected = await resolveScopeTarget("a", root, "existing");
    await fs.link(join(root, "a"), join(root, "other"));
    await expect(resolveScopeTarget("a", root, "existing")).rejects.toThrow("hard-linked");
    await expect(assertScopeTarget("a", root, [selected])).rejects.toThrow("hard-linked");
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("does not treat lstat %s as missing", async (code) => {
    const error = Object.assign(new Error("injected inspect failure"), { code });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(error);
    await expect(resolveScopeTarget("absent/deep", root, "new")).rejects.toBe(error);
  });

  it("does not treat realpath/stat failures as missing", async () => {
    await fs.writeFile(join(root, "a"), "before");
    const failure = Object.assign(new Error("injected metadata failure"), { code: "EIO" });
    vi.spyOn(fs, "realpath").mockRejectedValueOnce(failure);
    await expect(resolveScopeTarget("a", root, "either")).rejects.toBe(failure);
    vi.spyOn(fs, "stat").mockRejectedValueOnce(failure);
    await expect(resolveScopeTarget("a", root, "either")).rejects.toBe(failure);
  });

  it.each(["lstat", "realpath", "stat"] as const)("drains in-flight %s before reporting an abort", async (phase) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const wait = async () => {
      started.resolve();
      await release.promise;
    };
    if (phase === "lstat") {
      const original = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementationOnce(async (...args) => {
        await wait();
        return original(...args);
      });
    } else if (phase === "realpath") {
      const original = fs.realpath;
      vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
        await wait();
        return original(...args);
      });
    } else {
      const original = fs.stat;
      vi.spyOn(fs, "stat").mockImplementationOnce(async (...args) => {
        await wait();
        return original(...args);
      });
    }
    let settled = false;
    const pending = resolveScopeTarget("missing", root, "new", controller.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toThrow("stop");
    await started.promise;
    controller.abort(new Error("stop"));
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await rejected;
  });

  it("checks a pre-aborted signal before accessing the filesystem", async () => {
    const spy = vi.spyOn(fs, "lstat");
    await expect(resolveScopeTarget("a", root, "either", AbortSignal.abort(new Error("stop")))).rejects.toThrow("stop");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("authorization rechecks", () => {
  it("requires exact canonical equality, never prefixes or globs", async () => {
    await fs.writeFile(join(root, "a"), "before");
    const selected = await resolveScopeTarget("a", root, "existing");
    await assertScopeTarget("./a", root, [selected]);
    for (const denied of ["ab", "a-other", "*", "other/a"]) {
      await expect(assertScopeTarget(denied, root, [selected])).rejects.toThrow("not an allowed file");
    }
    await expect(assertScopeTarget("a", root, [{ path: root, canonical: `${root}/*` }])).rejects.toThrow(
      "not an allowed file",
    );
  });

  it("accepts canonical aliases and newly created reserved files with the normal built-ins", async () => {
    const selected = await resolveScopeTarget("new/deep/a", root, "new");
    await assertScopeTarget("new/deep/./a", root, [selected]);
    await createWriteToolDefinition(root).execute(
      "write",
      { path: "new/deep/a", content: "before" },
      undefined,
      undefined,
      { cwd: root } as ExtensionToolContext,
    );
    await fs.symlink(join(root, "new/deep/a"), join(root, "alias"), "file");
    await assertScopeTarget("alias", root, [selected]);
    await createEditToolDefinition(root).execute(
      "edit",
      { path: "alias", edits: [{ oldText: "before", newText: "after" }] },
      undefined,
      undefined,
      { cwd: root } as ExtensionToolContext,
    );
    expect(await fs.readFile(selected.path, "utf8")).toBe("after");
  });

  it("does not normalize a saved lexical path a second time", async () => {
    const directory = join(root, "base\u202fdir");
    await fs.mkdir(directory);
    const path = join(directory, "a\u202fb.txt");
    await fs.writeFile(path, "before");
    const raw = pathToFileURL(path).href;
    const selected = await resolveScopeTarget(raw, root, "existing");
    expect(selected.path).toBe(path);
    await assertScopeTarget(raw, root, [selected]);
    const child = await resolveScopeTarget("new", directory, "new");
    await assertScopeTarget("new", directory, [child]);
  });

  it("does not expand a scope after a symlink target changes", async () => {
    await fs.writeFile(join(root, "a"), "before");
    await fs.writeFile(join(root, "b"), "other");
    await fs.symlink(join(root, "a"), join(root, "alias"), "file");
    const selected = await resolveScopeTarget("alias", root, "existing");
    await fs.unlink(join(root, "alias"));
    await fs.symlink(join(root, "b"), join(root, "alias"), "file");
    await expect(assertScopeTarget("alias", root, [selected])).rejects.toThrow("not an allowed file");
    await expect(assertScopeTarget("a", root, [selected])).rejects.toThrow("changed since selection");
    expect(await fs.readFile(join(root, "b"), "utf8")).toBe("other");
  });

  it("rejects a reserved suffix redirected by a newly created ancestor link", async () => {
    await fs.mkdir(join(root, "real"));
    const selected = await resolveScopeTarget("new/a", root, "new");
    await fs.symlink(join(root, "real"), join(root, "new"), "junction");
    await expect(assertScopeTarget("new/a", root, [selected])).rejects.toThrow("not an allowed file");
  });

  it("checks the mutation again after awaiting the selected target", async () => {
    await fs.writeFile(join(root, "a"), "before");
    await fs.writeFile(join(root, "b"), "other");
    await fs.symlink(join(root, "a"), join(root, "alias"), "file");
    const selected = await resolveScopeTarget("a", root, "existing");
    const original = fs.stat;
    let calls = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await original(...args);
      calls += 1;
      if (calls === 2) {
        await fs.unlink(join(root, "alias"));
        await fs.symlink(join(root, "b"), join(root, "alias"), "file");
      }
      return result;
    });
    await expect(assertScopeTarget("alias", root, [selected])).rejects.toThrow("changed during validation");
  });
});
