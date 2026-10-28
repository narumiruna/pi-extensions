import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { required } from "../invariant.ts";
import { createInvocationSettings } from "../invocation.ts";
import type { Guard } from "../types.ts";

const primaryGroup = process.getgid?.();
const sharedGroup = process.getgroups?.().find((group) => group !== primaryGroup);
const content = "---\nname: shared\ndescription: Shared skill\n---\nInstructions\n";
const guard: Guard = {
  signal: new AbortController().signal,
  check() {},
  isProjectTrusted: () => true,
};
type Handle = Awaited<ReturnType<typeof fs.open>>;
function wrap(handle: Handle, overrides: Partial<Handle>): Handle {
  return new Proxy(handle, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// A real supplementary group proves the permission difference without root or
// changing process identity. The test remains unavailable on single-group hosts.
describe.skipIf(process.platform === "win32" || sharedGroup === undefined)("shared source permissions", () => {
  let directory: string;
  let filePath: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "pi-skills-permissions-"));
    filePath = join(directory, "one", "SKILL.md");
    await fs.mkdir(dirname(filePath));
    await fs.writeFile(filePath, content);
    const info = await fs.stat(filePath);
    await fs.chown(filePath, info.uid, required(sharedGroup));
    await fs.chmod(filePath, 0o640);
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  function native(path = filePath) {
    return required(
      loadSkillsFromDir({ dir: dirname(path), source: "user" }).skills.find((skill) => skill.filePath === path),
    );
  }
  async function clean() {
    expect((await fs.readdir(dirname(filePath))).filter((name) => name.includes(".invocation-"))).toEqual([]);
  }

  it.each(["regular", "linked", "standalone"])(
    "preserves UID, supplementary GID and mode through %s saves",
    async (kind) => {
      let source = filePath;
      if (kind === "standalone") {
        const path = join(dirname(filePath), "shared.md");
        await fs.rename(filePath, path);
        filePath = path;
        source = path;
      } else if (kind === "linked") {
        source = join(directory, "alias.md");
        await fs.symlink(filePath, source);
      }
      const before = await fs.stat(filePath);
      expect(before.gid).toBe(sharedGroup);
      expect(before.gid).not.toBe(primaryGroup);
      const settings = createInvocationSettings();
      const original = await settings.readInvocation(native(source), guard);
      const disabled = await settings.updateInvocation(original, false, guard);
      const after = await fs.stat(filePath);
      expect([after.uid, after.gid, after.mode & 0o7777]).toEqual([before.uid, before.gid, 0o640]);
      await settings.updateInvocation(disabled.snapshot, true, guard);
      const restored = await fs.stat(filePath);
      expect([restored.uid, restored.gid, restored.mode & 0o7777]).toEqual([before.uid, before.gid, 0o640]);
      expect(await fs.readFile(filePath, "utf8")).toBe(content);
      await clean();
    },
  );

  it.each(["chown", "ownership", "mode"])("refuses failed %s preservation and permits retry", async (failure) => {
    const settings = createInvocationSettings({
      open: async (path, flags, mode) => {
        const staging = flags === "wx";
        const handle = await fs.open(path, flags, staging && failure === "mode" ? 0o600 : mode);
        if (!staging) return handle;
        return wrap(handle, {
          chown: async (uid, gid) => {
            if (failure === "chown") throw Object.assign(new Error("Cannot preserve ownership"), { code: "EPERM" });
            if (failure !== "ownership") await handle.chown(uid, gid);
          },
          chmod: async (value) => {
            if (failure !== "mode") await handle.chmod(value);
          },
        });
      },
    });
    const before = await fs.stat(filePath);
    const snapshot = await settings.readInvocation(native(), guard);
    await expect(settings.updateInvocation(snapshot, false, guard)).rejects.toThrow();
    expect(await fs.readFile(filePath, "utf8")).toBe(content);
    const after = await fs.stat(filePath);
    expect([after.uid, after.gid, after.mode & 0o7777, after.ino]).toEqual([before.uid, before.gid, 0o640, before.ino]);
    await clean();
    const retry = createInvocationSettings();
    const current = await retry.readInvocation(native(), guard);
    expect((await retry.updateInvocation(current, false, guard)).changed).toBe(true);
  });

  it("rejects source group changes after review without overwriting them", async () => {
    const settings = createInvocationSettings();
    const snapshot = await settings.readInvocation(native(), guard);
    const before = await fs.stat(filePath);
    await fs.chown(filePath, before.uid, required(primaryGroup));
    await expect(settings.updateInvocation(snapshot, false, guard)).rejects.toThrow("changed since review");
    expect(await fs.readFile(filePath, "utf8")).toBe(content);
    expect((await fs.stat(filePath)).gid).toBe(primaryGroup);
    await clean();
  });
});
