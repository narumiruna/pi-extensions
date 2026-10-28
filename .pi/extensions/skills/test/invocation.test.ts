import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadSkillsFromDir, parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesystem } from "../filesystem.ts";
import { required } from "../invariant.ts";
import { createInvocationSettings } from "../invocation.ts";
import type { Guard, Location } from "../types.ts";

const KEY = "disable-model-invocation";
const document = (fields = "", body = "Instructions.\n") =>
  `---\nname: one\ndescription: Test skill\n${fields}---\n${body}`;
const failure = (code: string) => Object.assign(new Error(code), { code });
const exists = (path: string) =>
  fs.lstat(path).then(
    () => true,
    () => false,
  );
function handshake() {
  const entered = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  return {
    ready: entered.promise,
    release: () => resumed.resolve(),
    async pause() {
      entered.resolve();
      await resumed.promise;
    },
  };
}

type Handle = Awaited<ReturnType<typeof fs.open>>;
// Bind native methods to their real handle; only the named operations are replaced.
function wrapHandle(handle: Handle, overrides: Partial<Handle>): Handle {
  return new Proxy(handle, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let temporary: string;
let root: string;
let filePath: string;
let controller: AbortController;
let trusted: boolean;
let owned: boolean;
let guard: Guard;
let location: Location;

function loaded(path = filePath, source = "project"): Skill {
  const result = loadSkillsFromDir({ dir: dirname(path), source });
  return required(result.skills.find((skill) => skill.filePath === path));
}
async function fixture(content = document(), name = "one/SKILL.md") {
  const path = join(root, name);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content);
  return path;
}
async function noTemporaryFiles(path = filePath) {
  expect((await fs.readdir(dirname(path))).filter((name) => name.includes(".invocation-"))).toEqual([]);
}
function invalidate(kind: string) {
  if (kind === "trust") trusted = false;
  else if (kind === "owner") owned = false;
  else controller.abort(new Error("Cancelled"));
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(join(tmpdir(), "pi-skills-invocation-test-"));
  root = join(temporary, "skills");
  filePath = await fixture();
  controller = new AbortController();
  trusted = true;
  owned = true;
  guard = {
    signal: controller.signal,
    check() {
      if (!owned) throw new Error("Session replaced");
    },
    isProjectTrusted: () => trusted,
  };
  location = { id: root, path: root, label: "Temporary skills", scope: "project" };
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("invocation snapshots and native semantics", () => {
  it.each([
    { field: "", enabled: true },
    { field: `${KEY}: false\n`, enabled: true },
    { field: `${KEY}: true\n`, enabled: false },
  ])("reads native flag $field without writing or exposing source", async ({ field, enabled }) => {
    const original = document(field);
    await fs.writeFile(filePath, original);
    const native = loaded();
    // A loaded object's flag is not a substitute for reading current metadata.
    native.disableModelInvocation = !native.disableModelInvocation;
    const open = vi.fn(fs.open);
    const rename = vi.fn(fs.rename);
    const writeFile = vi.fn(fs.writeFile);
    const mkdtemp = vi.fn((): never => {
      throw new Error("Reading settings must not create validation staging");
    });
    const settings = createInvocationSettings({ open, rename, writeFile, mkdtemp });
    const snapshot = await settings.readInvocation(native, guard);
    expect(snapshot).toEqual({ filePath, canonicalPath: await fs.realpath(filePath), enabled });
    expect(Reflect.ownKeys(snapshot).sort()).toEqual(["canonicalPath", "enabled", "filePath"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    await noTemporaryFiles();
  });

  it.each(
    ["standalone", "linked"].flatMap((kind) => ["a".repeat(252), "界".repeat(83)].map((name) => ({ kind, name }))),
  )("saves a valid long $kind filename without extending its basename", async ({ kind, name }) => {
    const target = await fixture(document(), `${name}.md`);
    const source = kind === "linked" ? join(root, "alias.md") : target;
    if (kind === "linked") await fs.symlink(target, source);
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(loaded(source), guard);
    const disabled = await settings.updateInvocation(snapshot, false, guard);
    expect(loaded(target).disableModelInvocation).toBe(true);
    await settings.updateInvocation(disabled.snapshot, true, guard);
    expect(await fs.readFile(target, "utf8")).toBe(document());
    if (kind === "linked") expect((await fs.lstat(source)).isSymbolicLink()).toBe(true);
    await noTemporaryFiles(target);
  });

  it("rejects copied, fabricated, and another instance's snapshots", async () => {
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(loaded(), guard);
    const other = createInvocationSettings();
    await expect(other.updateInvocation(snapshot, false, guard)).rejects.toThrow("Select a loaded skill");
    for (const invalid of [{ ...snapshot }, Object.freeze({ filePath, canonicalPath: filePath, enabled: true })]) {
      await expect(settings.updateInvocation(invalid, false, guard)).rejects.toThrow("Select a loaded skill");
    }
    expect(await fs.readFile(filePath, "utf8")).toBe(document());
    expect((await settings.updateInvocation(snapshot, false, guard)).changed).toBe(true);
  });

  it.each(["\n", "\r\n", "\r"].flatMap((newline) => ["", "\ufeff"].map((bom) => ({ newline, bom }))))(
    "round-trips twice with newline=$newline BOM=$bom and preserves all unowned bytes and mode",
    async ({ newline, bom }) => {
      const header =
        [
          "---",
          "name: one",
          "description: Test skill",
          "# Keep comment",
          "unknown: {list: [a, b]}",
          "notes: |",
          `  ${KEY}: false`,
        ].join(newline) + newline;
      const body = `---${newline}# Body\r\n${KEY}: false\r---\nEnd  `;
      const original = `${bom}${header}${body}`;
      const disabled = `${bom}${header}${KEY}: true${newline}${body}`;
      await fs.writeFile(filePath, original);
      await fs.chmod(filePath, 0o751);
      const rename = vi.fn(fs.rename);
      const settings = createInvocationSettings({ rename });
      let snapshot = await settings.readInvocation(loaded(), guard);
      for (let round = 0; round < 2; round++) {
        const noOp = await settings.updateInvocation(snapshot, true, guard);
        expect(noOp).toEqual({ snapshot, changed: false });
        expect(noOp.snapshot).toBe(snapshot);
        const off = await settings.updateInvocation(snapshot, false, guard);
        expect(off.changed).toBe(true);
        expect(off.snapshot.enabled).toBe(false);
        expect(await fs.readFile(filePath, "utf8")).toBe(disabled);
        expect(loaded().disableModelInvocation).toBe(true);
        const repeated = await settings.updateInvocation(off.snapshot, false, guard);
        expect(repeated).toEqual({ snapshot: off.snapshot, changed: false });
        const on = await settings.updateInvocation(off.snapshot, true, guard);
        expect(on.changed).toBe(true);
        expect(on.snapshot.enabled).toBe(true);
        expect(loaded().disableModelInvocation).toBe(false);
        expect(await fs.readFile(filePath, "utf8")).toBe(original);
        expect((await fs.stat(filePath)).mode & 0o7777).toBe(0o751);
        snapshot = on.snapshot;
      }
      expect(rename).toHaveBeenCalledTimes(4);
      await noTemporaryFiles();
    },
  );

  it.each(["false", "True", "TRUE"])("edits only an original simple %s field", async (value) => {
    const original = document(`'${KEY}'\t: ${value} # Keep\nunknown: keep\n`);
    await fs.writeFile(filePath, original);
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(loaded(), guard);
    const off = await settings.updateInvocation(snapshot, false, guard);
    expect(off.changed).toBe(value === "false");
    expect(await fs.readFile(filePath, "utf8")).toBe(
      value === "false" ? original.replace(": false #", ": true #") : original,
    );
    const on = await settings.updateInvocation(off.snapshot, true, guard);
    expect(on.changed).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe(document("unknown: keep\n"));
  });

  it("updates a standalone Markdown skill without changing siblings", async () => {
    const standalone = await fixture(document(), "standalone.md");
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(loaded(standalone), guard);
    const off = await settings.updateInvocation(snapshot, false, guard);
    expect(off.snapshot).toEqual({ filePath: standalone, canonicalPath: standalone, enabled: false });
    expect(loaded(standalone).disableModelInvocation).toBe(true);
    const on = await settings.updateInvocation(off.snapshot, true, guard);
    expect(on.snapshot.enabled).toBe(true);
    expect(await fs.readFile(standalone, "utf8")).toBe(document());
    expect(await fs.readFile(filePath, "utf8")).toBe(document());
    await noTemporaryFiles(standalone);
  });

  it("publishes through one same-directory rename, not an in-place write or hard link", async () => {
    const original = await fs.stat(filePath);
    const link = vi.fn(fs.link);
    let staged = "";
    const settings = createInvocationSettings({
      link,
      rename: async (from, to) => {
        staged = String(from);
        expect(dirname(staged)).toBe(dirname(filePath));
        expect(basename(staged)).toMatch(/^\.invocation-.+\.tmp$/u);
        expect(String(to)).toBe(filePath);
        expect(await fs.readFile(filePath, "utf8")).toBe(document());
        expect(await fs.readFile(staged, "utf8")).toBe(document(`${KEY}: true\n`));
        expect((await fs.stat(staged)).mode & 0o7777).toBe(original.mode & 0o7777);
        await fs.rename(from, to);
      },
    });
    const result = await settings.updateInvocation(await settings.readInvocation(loaded(), guard), false, guard);
    expect(result.changed).toBe(true);
    expect(staged).not.toBe("");
    expect((await fs.stat(filePath)).ino).not.toBe(original.ino);
    expect(await exists(staged)).toBe(false);
    expect(link).not.toHaveBeenCalled();
    await noTemporaryFiles();
  });
});

describe("native validation and unsupported source data", () => {
  it.each([
    ["malformed YAML", document("unknown: [broken\n")],
    ["missing description", "---\nname: one\n---\nBody"],
    ["empty description", "---\ndescription: '  '\n---\nBody"],
    ["duplicate source keys", document(`${KEY}: true\n'${KEY}': false\n`)],
    ["duplicate escaped key", document(`${KEY}: true\n"disable-model-invocatio\\u006e": false\n`)],
    ...["'true'", "yes", "null", "[true]", "{value: false}", "&flag true", "!!bool true", "|\n  true"].map((value) => [
      value,
      document(`${KEY}: ${value}\n`),
    ]),
  ])("refuses %s without changing the source", async (_label, original) => {
    const native = loaded();
    await fs.writeFile(filePath, original);
    const settings = createInvocationSettings();
    await expect(settings.readInvocation(native, guard)).rejects.toThrow();
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    await noTemporaryFiles();
    await fs.writeFile(filePath, document());
    const repaired = await settings.readInvocation(native, guard);
    expect((await settings.updateInvocation(repaired, false, guard)).changed).toBe(true);
  });

  it.each([
    ["flow mapping", `{description: Test skill, ${KEY}: false}`],
    ["escaped key", `description: Test skill\n"disable-model-invocatio\\u006e": false`],
    ["explicit native key", `description: Test skill\n? ${KEY}\n: false`],
  ])("rejects a native-invalid candidate from %s and keeps the queue usable", async (_label, fields) => {
    const original = `---\n${fields}\n---\nBody\n`;
    await fs.writeFile(filePath, original);
    expect(parseFrontmatter(original).frontmatter[KEY]).toBe(false);
    expect(loaded().disableModelInvocation).toBe(false);
    const rename = vi.fn(fs.rename);
    const directories: string[] = [];
    const settings = createInvocationSettings({
      rename,
      mkdtemp: (async (...args: Parameters<typeof fs.mkdtemp>) => {
        const directory = await fs.mkdtemp(...args);
        directories.push(String(directory));
        return directory;
      }) as typeof fs.mkdtemp,
    });
    // A conservative reader can reject an unsupported source before save.
    const attempt = async () => settings.updateInvocation(await settings.readInvocation(loaded(), guard), false, guard);
    await expect(attempt()).rejects.toThrow();
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    for (const directory of directories) expect(await exists(directory)).toBe(false);
    await noTemporaryFiles();
    await fs.writeFile(filePath, document());
    expect(
      (await settings.updateInvocation(await settings.readInvocation(loaded(), guard), false, guard)).changed,
    ).toBe(true);
  });

  it.each([
    ["flow mapping", `{description: Test skill, ${KEY}: true}`],
    ["escaped key", `description: Test skill\n"disable-model-invocatio\\u006e": true`],
    ["explicit native key", `description: Test skill\n? ${KEY}\n: true`],
  ])("does not report a successful enable for an uneditable %s source", async (_label, fields) => {
    const original = `---\n${fields}\n---\nBody\n`;
    await fs.writeFile(filePath, original);
    expect(loaded().disableModelInvocation).toBe(true);
    const settings = createInvocationSettings();
    await expect(
      (async () => {
        const snapshot = await settings.readInvocation(loaded(), guard);
        return settings.updateInvocation(snapshot, true, guard);
      })(),
    ).rejects.toThrow();
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    await noTemporaryFiles();
  });
});

describe("ownership, trust, and asynchronous checks", () => {
  it.each(["project", "path"])("requires trust for %s sources before reading", async (source) => {
    const open = vi.fn(fs.open);
    const settings = createInvocationSettings({ open });
    trusted = false;
    await expect(settings.readInvocation(loaded(filePath, source), guard)).rejects.toThrow("trust");
    expect(open).not.toHaveBeenCalled();
  });

  it("does not require project trust for user-owned skills", async () => {
    const native = loaded(filePath, "user");
    trusted = false;
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(native, guard);
    expect((await settings.updateInvocation(snapshot, false, guard)).changed).toBe(true);
  });

  it("captures the loaded path and trust scope before the first await", async () => {
    const native = loaded();
    const other = await fixture(document(), "two/SKILL.md");
    const gate = handshake();
    const settings = createInvocationSettings({
      realpath: (async (...args: Parameters<typeof fs.realpath>) => {
        const result = await fs.realpath(...args);
        await gate.pause();
        return result;
      }) as typeof fs.realpath,
    });
    const reading = settings.readInvocation(native, guard);
    try {
      await gate.ready;
      native.filePath = other;
      native.sourceInfo = { ...native.sourceInfo, scope: "user" };
      trusted = false;
    } finally {
      gate.release();
    }
    await expect(reading).rejects.toThrow("trust");
    trusted = true;
    const snapshot = await settings.readInvocation(loaded(), guard);
    const selected = loaded();
    selected.filePath = other;
    selected.sourceInfo = { ...selected.sourceInfo, scope: "user" };
    const result = await settings.updateInvocation(snapshot, false, guard);
    expect(result.snapshot.filePath).toBe(filePath);
    expect(await fs.readFile(other, "utf8")).toBe(document());
  });

  it.each(["trust", "owner", "abort"])("rechecks %s after an awaited source read", async (kind) => {
    const gate = handshake();
    const settings = createInvocationSettings({
      realpath: (async (...args: Parameters<typeof fs.realpath>) => {
        const result = await fs.realpath(...args);
        await gate.pause();
        return result;
      }) as typeof fs.realpath,
    });
    const reading = settings.readInvocation(loaded(), guard);
    try {
      await gate.ready;
      invalidate(kind);
    } finally {
      gate.release();
    }
    await expect(reading).rejects.toThrow(
      kind === "trust" ? /trust/u : kind === "owner" ? /Session replaced/u : /Cancelled/u,
    );
    expect(await fs.readFile(filePath, "utf8")).toBe(document());
  });

  it.each(["trust", "owner", "abort"].flatMap((kind) => ["validation", "staging"].map((phase) => ({ kind, phase }))))(
    "rechecks $kind after awaited $phase and removes unpublished files",
    async ({ kind, phase }) => {
      const gate = handshake();
      const directories: string[] = [];
      const rename = vi.fn(fs.rename);
      const settings = createInvocationSettings({
        rename,
        mkdtemp: (async (...args: Parameters<typeof fs.mkdtemp>) => {
          const directory = await fs.mkdtemp(...args);
          directories.push(String(directory));
          return directory;
        }) as typeof fs.mkdtemp,
        writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
          await fs.writeFile(...args);
          if (phase === "validation") await gate.pause();
        }) as typeof fs.writeFile,
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          if (phase !== "staging" || args[1] !== "wx") return handle;
          return wrapHandle(handle, {
            async chmod(mode) {
              await handle.chmod(mode);
              await gate.pause();
            },
          });
        }) as typeof fs.open,
      });
      const snapshot = await settings.readInvocation(loaded(), guard);
      const saving = settings.updateInvocation(snapshot, false, guard);
      try {
        await gate.ready;
        invalidate(kind);
      } finally {
        gate.release();
      }
      await expect(saving).rejects.toThrow();
      expect(rename).not.toHaveBeenCalled();
      expect(await fs.readFile(filePath, "utf8")).toBe(document());
      for (const directory of directories) expect(await exists(directory)).toBe(false);
      await noTemporaryFiles();
    },
  );

  it.each(["trust", "owner", "abort"])("rechecks %s after closing an awaited source handle", async (kind) => {
    const gate = handshake();
    const settings = createInvocationSettings({
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        return wrapHandle(handle, {
          async close() {
            await handle.close();
            await gate.pause();
          },
        });
      }) as typeof fs.open,
    });
    const reading = settings.readInvocation(loaded(), guard);
    try {
      await gate.ready;
      invalidate(kind);
    } finally {
      gate.release();
    }
    await expect(reading).rejects.toThrow();
    expect(await fs.readFile(filePath, "utf8")).toBe(document());
  });

  it("rejects cancellation before save without changing the source", async () => {
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(loaded(), guard);
    controller.abort(new Error("Cancelled"));
    await expect(settings.updateInvocation(snapshot, false, guard)).rejects.toThrow("Cancelled");
    expect(await fs.readFile(filePath, "utf8")).toBe(document());
    await noTemporaryFiles();
  });

  it.each(["abort", "owner", "trust"])(
    "returns plain committed data for %s invalidation during rename",
    async (kind) => {
      const gate = handshake();
      const settings = createInvocationSettings({
        rename: async (from, to) => {
          await fs.rename(from, to);
          await gate.pause();
        },
      });
      const snapshot = await settings.readInvocation(loaded(), guard);
      const saving = settings.updateInvocation(snapshot, false, guard);
      try {
        await gate.ready;
        invalidate(kind);
      } finally {
        gate.release();
      }
      const result = await saving;
      expect(result).toEqual({ changed: true, snapshot: { filePath, canonicalPath: filePath, enabled: false } });
      expect(Reflect.ownKeys(result.snapshot).sort()).toEqual(["canonicalPath", "enabled", "filePath"]);
      expect(await fs.readFile(filePath, "utf8")).toBe(document(`${KEY}: true\n`));
      await noTemporaryFiles();
    },
  );
});

describe("stale source and target protection", () => {
  it("follows a symlink source while preserving its stable canonical target and the link itself", async () => {
    const alias = await fixture(document(), "alias/SKILL.md");
    await fs.unlink(alias);
    await fs.symlink(filePath, alias);
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(loaded(alias), guard);
    expect(snapshot).toEqual({ filePath: alias, canonicalPath: filePath, enabled: true });
    const off = await settings.updateInvocation(snapshot, false, guard);
    expect(off.snapshot.canonicalPath).toBe(filePath);
    expect(off.snapshot.filePath).toBe(alias);
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(alias)).toBe(filePath);
    expect(loaded().disableModelInvocation).toBe(true);
    expect((await settings.updateInvocation(off.snapshot, true, guard)).changed).toBe(true);
  });

  it("rejects a retargeted source symlink without editing either target", async () => {
    const second = await fixture(document(), "two/SKILL.md");
    const alias = join(root, "linked.md");
    await fs.symlink(filePath, alias);
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(loaded(alias), guard);
    await fs.unlink(alias);
    await fs.symlink(second, alias);
    await expect(settings.updateInvocation(snapshot, false, guard)).rejects.toThrow("changed");
    expect(await fs.readFile(filePath, "utf8")).toBe(document());
    expect(await fs.readFile(second, "utf8")).toBe(document());
  });

  it.each([
    "content",
    "same-signature content",
    "mode",
    "identity",
    "parent",
    "directory",
    "link",
    "hardlink",
    "missing",
  ])("rejects %s changes since review instead of overwriting", async (change) => {
    const settings = createInvocationSettings();
    if (change === "same-signature content") await fs.utimes(filePath, 1_000, 1_000);
    const snapshot = await settings.readInvocation(loaded(), guard);
    const original = await fs.stat(filePath);
    if (change === "content" || change === "same-signature content") {
      await fs.writeFile(filePath, document().replace("Instructions", "Replacement!"));
      if (change === "same-signature content") await fs.utimes(filePath, original.atime, original.mtime);
    } else if (change === "mode") await fs.chmod(filePath, 0o600);
    else if (change === "identity") {
      await fs.rename(filePath, join(temporary, "old.md"));
      await fs.writeFile(filePath, document());
    } else if (change === "parent") {
      const old = join(temporary, "old-parent");
      await fs.rename(dirname(filePath), old);
      await fs.mkdir(dirname(filePath));
      await fs.rename(join(old, "SKILL.md"), filePath);
    } else if (change === "hardlink") await fs.link(filePath, join(temporary, "hardlink.md"));
    else {
      await fs.rename(filePath, join(temporary, "retained.md"));
      if (change === "directory") await fs.mkdir(filePath);
      else if (change === "link") await fs.symlink(join(temporary, "retained.md"), filePath);
    }
    const before = await fs.lstat(filePath).catch(() => undefined);
    const content = before?.isFile() ? await fs.readFile(filePath) : undefined;
    await expect(settings.updateInvocation(snapshot, false, guard)).rejects.toThrow();
    if (content) expect(await fs.readFile(filePath)).toEqual(content);
    if (before) expect((await fs.lstat(filePath)).ino).toBe(before.ino);
    else expect(await exists(filePath)).toBe(false);
    await noTemporaryFiles();
  });

  it("rejects source replacement during an awaited read", async () => {
    const gate = handshake();
    let first = true;
    const settings = createInvocationSettings({
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (first) {
          first = false;
          await gate.pause();
        }
        return handle;
      }) as typeof fs.open,
    });
    const reading = settings.readInvocation(loaded(), guard);
    try {
      await gate.ready;
      await fs.rename(filePath, join(temporary, "retained.md"));
      await fs.writeFile(filePath, document("unknown: replacement\n"));
    } finally {
      gate.release();
    }
    await expect(reading).rejects.toThrow("changed while reading");
    expect(await fs.readFile(filePath, "utf8")).toBe(document("unknown: replacement\n"));
    expect((await settings.readInvocation(loaded(), guard)).enabled).toBe(true);
  });

  it.each(["content", "mode", "identity", "parent"])(
    "rejects %s changes while a source read is pending",
    async (kind) => {
      const gate = handshake();
      let paused = false;
      const settings = createInvocationSettings({
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          return wrapHandle(handle, {
            read: (async (...readArgs: Parameters<Handle["read"]>) => {
              const result = await handle.read(...readArgs);
              if (!paused) {
                paused = true;
                await gate.pause();
              }
              return result;
            }) as Handle["read"],
          });
        }) as typeof fs.open,
      });
      const reading = settings.readInvocation(loaded(), guard);
      try {
        await gate.ready;
        if (kind === "content") await fs.writeFile(filePath, document("external: keep\n"));
        else if (kind === "mode") await fs.chmod(filePath, 0o600);
        else if (kind === "identity") {
          await fs.rename(filePath, join(temporary, "old.md"));
          await fs.writeFile(filePath, document());
        } else {
          const old = join(temporary, "old-parent");
          await fs.rename(dirname(filePath), old);
          await fs.mkdir(dirname(filePath));
          await fs.rename(join(old, "SKILL.md"), filePath);
        }
      } finally {
        gate.release();
      }
      await expect(reading).rejects.toThrow("changed while reading");
      expect((await settings.readInvocation(loaded(), guard)).enabled).toBe(true);
      await noTemporaryFiles();
    },
  );

  it("checks the source again after validation and before rename", async () => {
    const gate = handshake();
    const rename = vi.fn(fs.rename);
    const settings = createInvocationSettings({
      rename,
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        if (args[1] !== "wx") return handle;
        return wrapHandle(handle, {
          async chmod(mode) {
            await handle.chmod(mode);
            await gate.pause();
          },
        });
      }) as typeof fs.open,
    });
    const snapshot = await settings.readInvocation(loaded(), guard);
    const saving = settings.updateInvocation(snapshot, false, guard);
    try {
      await gate.ready;
      await fs.writeFile(filePath, document("unknown: external change\n"));
    } finally {
      gate.release();
    }
    await expect(saving).rejects.toThrow("changed since review");
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe(document("unknown: external change\n"));
    await noTemporaryFiles();
  });
});

describe("failure cleanup and recovery", () => {
  it.each([
    "validation write",
    "native validation",
    "native flag mismatch",
    "temporary open",
    "partial write",
    "chmod",
    "rename",
  ])("cleans up after %s failure and can retry the same snapshot", async (phase) => {
    let fail = true;
    const directories: string[] = [];
    const settings = createInvocationSettings({
      mkdtemp: (async (...args: Parameters<typeof fs.mkdtemp>) => {
        const directory = await fs.mkdtemp(...args);
        directories.push(String(directory));
        return directory;
      }) as typeof fs.mkdtemp,
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        if (fail && phase === "validation write") throw failure("ENOSPC");
        if (fail && phase === "native validation") return fs.writeFile(args[0], "---\ndescription: [broken\n---\nBody");
        if (fail && phase === "native flag mismatch") return fs.writeFile(args[0], document());
        return fs.writeFile(...args);
      }) as typeof fs.writeFile,
      open: (async (...args: Parameters<typeof fs.open>) => {
        if (fail && phase === "temporary open" && args[1] === "wx") throw failure("EACCES");
        const handle = await fs.open(...args);
        if (args[1] !== "wx") return handle;
        return wrapHandle(handle, {
          async writeFile(data, options) {
            if (fail && phase === "partial write") {
              await handle.writeFile("partial");
              throw failure("ENOSPC");
            }
            return handle.writeFile(data, options);
          },
          async chmod(mode) {
            if (fail && phase === "chmod") throw failure("EPERM");
            return handle.chmod(mode);
          },
        });
      }) as typeof fs.open,
      rename: async (from, to) => {
        if (fail && phase === "rename") throw failure("EACCES");
        return fs.rename(from, to);
      },
    });
    const before = await fs.stat(filePath);
    const snapshot = await settings.readInvocation(loaded(), guard);
    await expect(settings.updateInvocation(snapshot, false, guard)).rejects.toThrow();
    expect(await fs.readFile(filePath, "utf8")).toBe(document());
    expect((await fs.stat(filePath)).ino).toBe(before.ino);
    for (const directory of directories) expect(await exists(directory)).toBe(false);
    await noTemporaryFiles();
    fail = false;
    expect((await settings.readInvocation(loaded(), guard)).enabled).toBe(true);
    const result = await settings.updateInvocation(snapshot, false, guard);
    expect(result.changed).toBe(true);
    expect(loaded().disableModelInvocation).toBe(true);
    for (const directory of directories) expect(await exists(directory)).toBe(false);
    await noTemporaryFiles();
  });

  it.each(["unreadable", "nonregular", "hardlink", "oversized", "UTF-8", "short read"])(
    "rejects %s source data safely",
    async (kind) => {
      const native = loaded();
      if (kind === "nonregular") {
        await fs.unlink(filePath);
        await fs.mkdir(filePath);
      } else if (kind === "hardlink") await fs.link(filePath, join(temporary, "linked.md"));
      else if (kind === "oversized") {
        const handle = await fs.open(filePath, "w");
        try {
          await handle.truncate(64 * 1024 * 1024 + 1);
        } finally {
          await handle.close();
        }
      } else if (kind === "UTF-8")
        await fs.writeFile(filePath, Buffer.concat([Buffer.from(document()), Buffer.from([0xff])]));
      const settings = createInvocationSettings({
        open: (async (...args: Parameters<typeof fs.open>) => {
          // Inject EACCES because chmod is not a reliable unreadability test under root.
          if (kind === "unreadable") throw failure("EACCES");
          const handle = await fs.open(...args);
          return kind === "short read"
            ? wrapHandle(handle, { read: (async () => ({ bytesRead: 0 })) as Handle["read"] })
            : handle;
        }) as typeof fs.open,
      });
      await expect(settings.readInvocation(native, guard)).rejects.toThrow(
        kind === "unreadable"
          ? /EACCES/u
          : kind === "nonregular"
            ? /regular file/u
            : kind === "hardlink"
              ? /Hard-linked/u
              : kind === "oversized"
                ? /64 MiB/u
                : kind === "UTF-8"
                  ? /UTF-8/u
                  : /changed while reading/u,
      );
      await noTemporaryFiles();
    },
  );
});

describe("shared mutation ordering", () => {
  it("serializes concurrent saves of the same snapshot and rejects the stale second save", async () => {
    const gate = handshake();
    const rename = vi.fn(async (...[from, to]: Parameters<typeof fs.rename>) => {
      await gate.pause();
      await fs.rename(from, to);
    });
    const settings = createInvocationSettings({ rename });
    const snapshot = await settings.readInvocation(loaded(), guard);
    const first = settings.updateInvocation(snapshot, false, guard);
    let second: ReturnType<typeof settings.updateInvocation>;
    try {
      await gate.ready;
      second = settings.updateInvocation(snapshot, true, guard);
    } finally {
      gate.release();
    }
    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { changed: true, snapshot: { enabled: false } } });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("changed since review") }),
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(loaded().disableModelInvocation).toBe(true);
    expect((await settings.readInvocation(loaded(), guard)).enabled).toBe(false);
  });

  it("queues a read from another settings instance behind a pending metadata write", async () => {
    const gate = handshake();
    const settings = createInvocationSettings({
      rename: async (from, to) => {
        await gate.pause();
        await fs.rename(from, to);
      },
    });
    const other = createInvocationSettings();
    const native = loaded();
    const saving = settings.updateInvocation(await settings.readInvocation(native, guard), false, guard);
    let reading: ReturnType<typeof other.readInvocation>;
    try {
      await gate.ready;
      reading = other.readInvocation(native, guard);
    } finally {
      gate.release();
    }
    expect((await saving).changed).toBe(true);
    expect((await reading).enabled).toBe(false);
  });

  it("holds directory removal behind an in-progress metadata read", async () => {
    const engine = createFilesystem();
    const inventory = await engine.scanInventory([location], guard);
    const gate = handshake();
    let removalStarted = false;
    let readComplete = false;
    let applyingStarted = false;
    const settings = createInvocationSettings({
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        await gate.pause();
        expect(removalStarted).toBe(false);
        return wrapHandle(handle, {
          async close() {
            await handle.close();
            readComplete = true;
          },
        });
      }) as typeof fs.open,
    });
    const removingEngine = createFilesystem({
      lstat: (async (...args: Parameters<typeof fs.lstat>) => {
        // Preparation is complete before the read starts. Every apply I/O must
        // wait for the read, not merely the final recursive removal.
        if (applyingStarted) expect(readComplete).toBe(true);
        return fs.lstat(...args);
      }) as typeof fs.lstat,
      rm: async (path, options) => {
        removalStarted = true;
        return fs.rm(path, options);
      },
    });
    const removal = await removingEngine.prepareOperation({ kind: "remove", skills: inventory.skills }, guard);
    const reading = settings.readInvocation(loaded(), guard);
    let applying: ReturnType<typeof removal.apply>;
    try {
      await gate.ready;
      applyingStarted = true;
      applying = removal.apply(guard);
    } finally {
      gate.release();
    }
    expect((await reading).enabled).toBe(true);
    expect((await applying)[0]).toMatchObject({ status: "removed", changed: true });
    expect(removalStarted).toBe(true);
    expect(await exists(filePath)).toBe(false);
  });

  it("holds metadata reads behind a directory move and reads only the committed tree", async () => {
    const gate = handshake();
    let moved = false;
    const engine = createFilesystem({
      rename: async (from, to) => {
        await gate.pause();
        await fs.rename(from, to);
        moved = true;
      },
    });
    const inventory = await engine.scanInventory([location], guard);
    const target: Location = { ...location, id: "target", path: join(temporary, "target") };
    const batch = await engine.prepareOperation({ kind: "move", target, skills: inventory.skills }, guard);
    const movedFile = join(target.path, "one/SKILL.md");
    const native = { ...loaded(), filePath: movedFile };
    const open = vi.fn(fs.open);
    const settings = createInvocationSettings({
      open,
      realpath: (async (...args: Parameters<typeof fs.realpath>) => {
        expect(moved).toBe(true);
        return fs.realpath(...args);
      }) as typeof fs.realpath,
    });
    const applying = batch.apply(guard);
    let reading: ReturnType<typeof settings.readInvocation>;
    try {
      await gate.ready;
      reading = settings.readInvocation(native, guard);
    } finally {
      gate.release();
    }
    expect((await applying)[0]).toMatchObject({ status: "moved", changed: true });
    expect(await reading).toEqual({ filePath: movedFile, canonicalPath: movedFile, enabled: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(await exists(filePath)).toBe(false);
  });
});
