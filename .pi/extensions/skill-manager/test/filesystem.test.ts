import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesystem } from "../filesystem.ts";
import { required } from "../invariant.ts";
import type { Guard, Location, OperationRequest, SkillBundle } from "../types.ts";

let temporary: string;
let controller: AbortController;
let trusted: boolean;
let guard: Guard;
let source: Location;
let target: Location;
const content = (name = "one") => `---\nname: ${name}\ndescription: Test skill\n---\nInstructions.\n`;
function bundle(name = "one"): SkillBundle {
  return {
    id: name,
    directoryName: name,
    name,
    warnings: [],
    files: [
      { path: "SKILL.md", content: Buffer.from(content(name)), executable: false },
      { path: "scripts/run.sh", content: Buffer.from([0, 1, 2, 255]), executable: true },
      { path: ".notice", content: Buffer.from("license"), executable: false },
    ],
  };
}
async function skill(root = source.path, directory = "one", name = directory) {
  const path = join(root, directory);
  await fs.mkdir(join(path, "scripts"), { recursive: true });
  await fs.writeFile(join(path, "SKILL.md"), content(name));
  await fs.writeFile(join(path, "scripts/run.sh"), Buffer.from([0, 1, 255]), { mode: 0o751 });
  await fs.writeFile(join(path, ".notice"), "notice", { mode: 0o640 });
  return path;
}
async function exists(path: string) {
  return fs.lstat(path).then(
    () => true,
    () => false,
  );
}
async function stages() {
  return (await fs.readdir(temporary)).filter((name) => name.startsWith(".pi-skills-stage-"));
}
const failure = (code: string) => Object.assign(new Error(code), { code });

beforeEach(async () => {
  temporary = await fs.mkdtemp(join(tmpdir(), "pi-skills-fs-test-"));
  controller = new AbortController();
  trusted = true;
  guard = { signal: controller.signal, check() {}, isProjectTrusted: () => trusted };
  source = { id: "source", label: "Source", scope: "project", path: join(temporary, "source") };
  target = { id: "target", label: "Target", scope: "user", path: join(temporary, "target") };
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("inventory", () => {
  it("keeps duplicate names at distinct native roots, stops at SKILL.md, and ignores hidden/cache directories", async () => {
    const engine = createFilesystem();
    const roots = ["agent/skills", "project/.pi/skills", "home/.agents/skills", "project/.agents/skills"].map(
      (path, id) => ({ ...source, id: String(id), path: join(temporary, path) }),
    );
    for (const root of roots) await skill(root.path, "one", "duplicate");
    await skill(join(required(roots[0]).path, "one"), "nested");
    await skill(join(required(roots[0]).path, ".hidden"));
    await skill(join(required(roots[0]).path, "node_modules"));
    const result = await engine.scanInventory(roots, guard);
    expect(result.skills).toHaveLength(4);
    expect(new Set(result.skills.map((entry) => entry.path)).size).toBe(4);
    expect(result.skills.every((entry) => entry.name === "duplicate")).toBe(true);
    expect(result.skills.every((entry) => entry.directoryPath === entry.path)).toBe(true);
    expect(result.warnings.join("\n")).toContain("Duplicate declared name");
  });
  it("finds nested bundles, malformed skills and standalone native Markdown without making Markdown writable", async () => {
    const engine = createFilesystem();
    const path = await skill(join(source.path, "category"), "broken");
    await fs.writeFile(join(path, "SKILL.md"), "---\nname: [invalid\n");
    await fs.writeFile(join(source.path, "standalone.md"), content("standalone"));
    const result = await engine.scanInventory([source], guard);
    expect(result.skills).toHaveLength(2);
    const broken = required(result.skills.find((entry) => entry.path === path));
    expect(broken.readOnlyReason).toBeUndefined();
    expect(broken.warnings.length).toBeGreaterThan(0);
    const markdown = required(result.skills.find((entry) => entry.path.endsWith(".md")));
    expect(markdown.readOnlyReason).toContain("Standalone");
    expect(markdown.directoryPath).toBe(source.path);
    expect(broken.directoryPath).toBe(path);
    const remove = await engine.prepareOperation({ kind: "remove", skills: [broken, markdown] }, guard);
    expect((await remove.apply(guard)).map((item) => item.status)).toEqual(["removed", "skipped"]);
    expect(await exists(source.path)).toBe(true);
    expect(await exists(markdown.path)).toBe(true);
  });
  it("marks linked roots, parent links, and linked skill directories read-only", async () => {
    const engine = createFilesystem();
    await skill();
    const linked = { ...source, path: join(temporary, "linked") };
    await fs.symlink(source.path, linked.path);
    await fs.symlink(join(source.path, "one"), join(source.path, "alias"));
    const inventory = await engine.scanInventory([linked, source], guard);
    expect(inventory.skills.some((entry) => entry.path === join(linked.path, "one") && entry.readOnlyReason)).toBe(
      true,
    );
    expect(inventory.skills.some((entry) => entry.path === join(source.path, "alias") && entry.readOnlyReason)).toBe(
      true,
    );
    const batch = await engine.prepareOperation(
      { kind: "remove", skills: inventory.skills.filter((entry) => entry.readOnlyReason) },
      guard,
    );
    expect((await batch.apply(guard)).every((entry) => !entry.changed)).toBe(true);
    expect(await exists(join(source.path, "one"))).toBe(true);
  });
  it("bounds file reads and refuses special file types without copying them", async () => {
    const path = await skill();
    const large = join(path, "large");
    const handle = await fs.open(large, "w");
    await handle.truncate(65 * 1024 * 1024);
    await handle.close();
    const engine = createFilesystem();
    const inventory = await engine.scanInventory([source], guard);
    expect(inventory.skills[0]?.readOnlyReason).toContain("oversized");
    await fs.unlink(large);
    const special = join(path, "special");
    await fs.writeFile(special, "not actually a FIFO");
    const unsupported = createFilesystem({
      lstat: (async (file: string) => {
        const value = await fs.lstat(file);
        if (String(file) === special) value.isFile = () => false;
        return value;
      }) as typeof fs.lstat,
    });
    const blocked = await unsupported.scanInventory([source], guard);
    expect(blocked.skills[0]?.readOnlyReason).toContain("Unsupported special file");
    const move = await unsupported.prepareOperation({ kind: "move", target, skills: blocked.skills }, guard);
    expect((await move.apply(guard))[0]?.status).toBe("skipped");
    expect(await exists(target.path)).toBe(false);
  });
  it("does not read untrusted project roots and bounds recursion", async () => {
    const engine = createFilesystem();
    trusted = false;
    expect((await engine.scanInventory([source], guard)).warnings.join()).toContain("trust");
    trusted = true;
    const deep = join(source.path, ...Array.from({ length: 34 }, () => "d"));
    await skill(deep);
    const result = await engine.scanInventory([source], guard);
    expect(result.skills).toHaveLength(0);
    expect(result.warnings.join()).toContain("depth limit");
  });
});

describe("add", () => {
  it("prepares in memory then preserves complete bytes/modes, without staging under a discovered root", async () => {
    const engine = createFilesystem();
    const input = bundle();
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [input] }, guard);
    expect(batch.summary.join()).toContain(join(target.path, "one"));
    expect(await fs.readdir(temporary)).toEqual([]);
    required(input.files[0]).content = Buffer.from("mutated caller data");
    const result = await batch.apply(guard);
    expect(result[0]).toMatchObject({ status: "installed", changed: true });
    expect(await fs.readFile(join(target.path, "one/SKILL.md"), "utf8")).toBe(content());
    expect(await fs.readFile(join(target.path, "one/scripts/run.sh"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect((await fs.stat(join(target.path, "one/scripts/run.sh"))).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(join(target.path, "one/.notice"), "utf8")).toBe("license");
    expect(await stages()).toEqual([]);
    await expect(batch.apply(guard)).rejects.toThrow("already");
  });
  it("keeps publication staging outside every scanned root, including an enclosing custom root", async () => {
    await skill();
    const prefixes: string[] = [];
    const engine = createFilesystem({
      mkdtemp: (async (prefix: string) => {
        prefixes.push(prefix);
        return fs.mkdtemp(prefix);
      }) as typeof fs.mkdtemp,
    });
    await engine.scanInventory([source], guard);
    const nested = { ...target, path: join(source.path, "nested-container") };
    const batch = await engine.prepareOperation({ kind: "add", target: nested, bundles: [bundle("two")] }, guard);
    expect(prefixes).toEqual([]);
    expect((await batch.apply(guard))[0]?.status).toBe("installed");
    expect(prefixes).toHaveLength(1);
    expect(prefixes[0]?.startsWith(source.path)).toBe(false);
    expect(await stages()).toEqual([]);
  });
  it("skips occupied targets and rejects traversal, internal conflicts and missing metadata", async () => {
    const engine = createFilesystem();
    await skill(target.path);
    const traverse = { ...bundle(), directoryName: "../escape" };
    const fileEscape = bundle("file-escape");
    required(fileEscape.files[1]).path = "../escape";
    const conflict = bundle("conflict");
    conflict.files.push({ path: "scripts", content: Buffer.from("bad"), executable: false });
    const invalid = bundle("invalid");
    required(invalid.files[0]).content = Buffer.from("No description");
    const batch = await engine.prepareOperation(
      { kind: "add", target, bundles: [bundle(), traverse, fileEscape, conflict, invalid] },
      guard,
    );
    expect(batch.summary.filter((row) => row.startsWith("Skip"))).toHaveLength(5);
    expect((await batch.apply(guard)).every((entry) => entry.status === "skipped")).toBe(true);
    expect(await fs.readFile(join(target.path, "one/SKILL.md"), "utf8")).toBe(content());
    expect(await exists(join(temporary, "escape"))).toBe(false);
  });
  it("rejects ignore files that hide the declared SKILL.md before publication", async () => {
    const engine = createFilesystem();
    const ignored = bundle();
    ignored.files.push({ path: ".ignore", content: Buffer.from("SKILL.md\n"), executable: false });
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [ignored] }, guard);
    expect(required((await batch.apply(guard))[0]).status).toBe("skipped");
    expect(await exists(target.path)).toBe(false);
  });
  it("rejects a replaced destination container and a destination appearing during staging", async () => {
    const engine = createFilesystem();
    await fs.mkdir(target.path);
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    await fs.rename(target.path, join(temporary, "previous"));
    await fs.mkdir(target.path);
    expect(required((await batch.apply(guard))[0]).message).toContain("container changed");
    expect(await fs.readdir(target.path)).toEqual([]);
    let injected = false;
    const changing = createFilesystem({
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        await fs.writeFile(...args);
        if (!injected) {
          injected = true;
          await fs.mkdir(join(target.path, "one"));
          await fs.writeFile(join(target.path, "one/external"), "safe");
        }
      }) as typeof fs.writeFile,
    });
    const fresh = await changing.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    expect(required((await fresh.apply(guard))[0]).message).toContain("no overwrite");
    expect(await fs.readFile(join(target.path, "one/external"), "utf8")).toBe("safe");
    expect(await stages()).toEqual([]);
  });
  it("cleans an interrupted staging write and stops before the next item", async () => {
    const engine = createFilesystem({
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        await fs.writeFile(...args);
        controller.abort();
      }) as typeof fs.writeFile,
    });
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle(), bundle("two")] }, guard);
    expect((await batch.apply(guard)).map((item) => [item.status, item.changed])).toEqual([
      ["failed", false],
      ["skipped", false],
    ]);
    expect(await exists(target.path)).toBe(false);
    expect(await stages()).toEqual([]);
  });
  it("stops stale owners independently of the AbortSignal", async () => {
    let current = true;
    const ownerGuard = {
      ...guard,
      check() {
        if (!current) throw new Error("Session replaced");
      },
    };
    const engine = createFilesystem({
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        await fs.writeFile(...args);
        current = false;
      }) as typeof fs.writeFile,
    });
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, ownerGuard);
    expect(required((await batch.apply(ownerGuard))[0]).message).toContain("Session replaced");
    expect(await stages()).toEqual([]);
    expect(await exists(target.path)).toBe(false);
  });
  it("rejects a stale destination created after confirmation without overwrite", async () => {
    const engine = createFilesystem();
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    await fs.mkdir(join(target.path, "one"), { recursive: true });
    await fs.writeFile(join(target.path, "one/owner"), "external");
    expect((await batch.apply(guard))[0]).toMatchObject({ status: "failed", changed: false });
    expect(await fs.readFile(join(target.path, "one/owner"), "utf8")).toBe("external");
  });
  it("does not create state for cancellation before apply or oversized selections", async () => {
    const engine = createFilesystem();
    await expect(
      engine.prepareOperation({ kind: "add", target, bundles: Array.from({ length: 513 }, () => bundle()) }, guard),
    ).rejects.toThrow("count limit");
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    controller.abort();
    const register = vi.fn();
    expect((await batch.apply(guard, register))[0]).toMatchObject({ status: "skipped", changed: false });
    expect(register).not.toHaveBeenCalled();
    expect(await fs.readdir(temporary)).toEqual([]);
  });
  it("retains a published copy after registration failure and stops the batch without retry", async () => {
    const engine = createFilesystem();
    const batch = await engine.prepareOperation(
      { kind: "add", target, bundles: [bundle(), bundle("two"), bundle("three")] },
      guard,
    );
    const register = vi.fn().mockRejectedValueOnce(failure("EACCES")).mockResolvedValue(undefined);
    const results = await batch.apply(guard, register);
    expect(register).toHaveBeenCalledTimes(1);
    expect(results.map((entry) => entry.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(results[0]).toMatchObject({ changed: true });
    expect(required(results[0]).message).toContain("registration not confirmed");
    expect(await exists(join(target.path, "one"))).toBe(true);
    expect(await exists(join(target.path, "two"))).toBe(false);
    expect(await exists(join(target.path, "three"))).toBe(false);
  });
  it("reports registration uncertainty when persistence completes before cancellation", async () => {
    const controller = new AbortController();
    const current = {
      ...guard,
      signal: controller.signal,
      check() {
        controller.signal.throwIfAborted();
        guard.check();
      },
    };
    const engine = createFilesystem();
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, current);
    const committed = join(temporary, "registration-committed");
    const results = await batch.apply(current, async () => {
      await fs.writeFile(committed, "persisted");
      controller.abort();
      current.check();
    });
    expect(await fs.readFile(committed, "utf8")).toBe("persisted");
    expect(required(results[0]).message).toContain("registration not confirmed");
    expect(results[0]).toMatchObject({ changed: true });
    expect(await exists(join(target.path, "one"))).toBe(true);
  });
  it("never registers an unsuccessful publication and cleans failed stages", async () => {
    const engine = createFilesystem({
      rename: async () => {
        throw failure("EACCES");
      },
    });
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    const register = vi.fn();
    expect((await batch.apply(guard, register))[0]).toMatchObject({ status: "failed", changed: false });
    expect(register).not.toHaveBeenCalled();
    expect(await stages()).toEqual([]);
    expect(await exists(join(target.path, "one"))).toBe(false);
  });
  it("rechecks trust and ownership after asynchronous staging before publication", async () => {
    const projectTarget = { ...target, scope: "project" as const };
    const engine = createFilesystem({
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        await fs.writeFile(...args);
        trusted = false;
      }) as typeof fs.writeFile,
    });
    const batch = await engine.prepareOperation({ kind: "add", target: projectTarget, bundles: [bundle()] }, guard);
    const results = await batch.apply(guard);
    expect(results[0]).toMatchObject({ changed: false, status: "failed" });
    expect(await exists(projectTarget.path)).toBe(false);
    expect(await stages()).toEqual([]);
  });
  it("honors explicit read-only reasons and rejects symlink-swapped destination parents", async () => {
    const engine = createFilesystem();
    await expect(
      engine.prepareOperation(
        { kind: "add", target: { ...target, readOnlyReason: "Package-owned root" }, bundles: [bundle()] },
        guard,
      ),
    ).rejects.toThrow("Package-owned");
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    await fs.mkdir(source.path);
    await fs.symlink(source.path, target.path);
    expect(required((await batch.apply(guard))[0]).message).toContain("Symbolic link");
    expect(await fs.readdir(source.path)).toEqual([]);
  });
});

describe("remove and move", () => {
  it("removes a whole link-containing bundle without following the link or removing siblings/container", async () => {
    const engine = createFilesystem();
    const path = await skill();
    const outside = join(temporary, "outside");
    await fs.writeFile(outside, "safe");
    await fs.symlink(outside, join(path, "linked"));
    await fs.writeFile(join(source.path, "sibling"), "safe");
    const inventory = await engine.scanInventory([source], guard);
    const remove = await engine.prepareOperation({ kind: "remove", skills: inventory.skills }, guard);
    expect(required((await remove.apply(guard))[0]).status).toBe("removed");
    expect(await fs.readFile(outside, "utf8")).toBe("safe");
    expect(await fs.readFile(join(source.path, "sibling"), "utf8")).toBe("safe");
    expect(await exists(source.path)).toBe(true);
  });
  it.each(["bytes", "mode", "new-file"])("rejects stale source %s changes after preparation", async (change) => {
    const engine = createFilesystem();
    const path = await skill();
    const inventory = await engine.scanInventory([source], guard);
    const batch = await engine.prepareOperation({ kind: "move", target, skills: inventory.skills }, guard);
    if (change === "bytes") await fs.writeFile(join(path, ".notice"), "changed");
    else if (change === "mode") await fs.chmod(join(path, "scripts/run.sh"), 0o700);
    else await fs.writeFile(join(path, "new"), "changed");
    const result = required((await batch.apply(guard))[0]);
    expect(result).toMatchObject({ status: "failed", changed: false });
    expect(result.message).toContain("changed");
    expect(await exists(path)).toBe(true);
    expect(await exists(target.path)).toBe(false);
  });
  it("refuses roots, siblings, overlapping targets, links and sources replaced by links", async () => {
    const engine = createFilesystem();
    const path = await skill();
    const [entry] = (await engine.scanInventory([source], guard)).skills;
    for (const fake of [
      { ...required(entry), path: source.path },
      { ...required(entry), path: join(temporary, "sibling") },
    ]) {
      const batch = await engine.prepareOperation({ kind: "remove", skills: [fake] }, guard);
      expect(required((await batch.apply(guard))[0]).status).toBe("skipped");
    }
    for (const destination of [source.path, path, join(path, "sub")]) {
      const batch = await engine.prepareOperation(
        { kind: "move", target: { ...target, path: destination }, skills: [required(entry)] },
        guard,
      );
      expect(required((await batch.apply(guard))[0]).status).toBe("skipped");
    }
    await fs.symlink(join(temporary, "outside"), join(path, "link"));
    const linked = (await engine.scanInventory([source], guard)).skills;
    expect(
      required((await (await engine.prepareOperation({ kind: "move", target, skills: linked }, guard)).apply(guard))[0])
        .message,
    ).toContain("symbolic links");
    await fs.unlink(join(path, "link"));
    const fresh = (await engine.scanInventory([source], guard)).skills;
    const batch = await engine.prepareOperation({ kind: "remove", skills: fresh }, guard);
    await fs.rename(path, join(temporary, "kept"));
    await fs.symlink(join(temporary, "kept"), path);
    expect(required((await batch.apply(guard))[0]).message).toContain("Symbolic link");
    expect(await exists(join(temporary, "kept/SKILL.md"))).toBe(true);
  });
  it("rejects stale inventory and a byte-identical replaced source directory", async () => {
    const engine = createFilesystem();
    const path = await skill();
    const inventory = await engine.scanInventory([source], guard);
    await fs.rename(path, join(temporary, "original"));
    await skill();
    const stale = await engine.prepareOperation({ kind: "remove", skills: inventory.skills }, guard);
    expect(required((await stale.apply(guard))[0]).message).toContain("changed since inventory");
    const fresh = (await engine.scanInventory([source], guard)).skills;
    const batch = await engine.prepareOperation({ kind: "remove", skills: fresh }, guard);
    await fs.rename(path, join(temporary, "replacement-original"));
    await skill();
    expect(required((await batch.apply(guard))[0]).message).toContain("changed since confirmation");
    expect(await exists(path)).toBe(true);
  });
  it("permits removing but not moving hard-linked files", async () => {
    const engine = createFilesystem();
    const path = await skill();
    const external = join(temporary, "external");
    await fs.link(join(path, ".notice"), external);
    const inventory = await engine.scanInventory([source], guard);
    const move = await engine.prepareOperation({ kind: "move", target, skills: inventory.skills }, guard);
    expect(required((await move.apply(guard))[0]).message).toContain("hard-linked");
    const remove = await engine.prepareOperation({ kind: "remove", skills: inventory.skills }, guard);
    expect(required((await remove.apply(guard))[0]).status).toBe("removed");
    expect(await fs.readFile(external, "utf8")).toBe("notice");
  });
  it("does not let caller edits change the confirmed kind or paths", async () => {
    const engine = createFilesystem();
    const path = await skill();
    const skills = (await engine.scanInventory([source], guard)).skills;
    const request: OperationRequest = { kind: "move", target: { ...target }, skills };
    const batch = await engine.prepareOperation(request, guard);
    (request as { kind: string }).kind = "remove";
    request.target.path = join(temporary, "unconfirmed");
    skills[0].path = join(temporary, "unconfirmed-source");
    expect((await batch.apply(guard))[0]?.status).toBe("moved");
    expect(await exists(path)).toBe(false);
    expect(await exists(join(target.path, "one/SKILL.md"))).toBe(true);
    expect(await exists(join(temporary, "unconfirmed"))).toBe(false);
  });
  it("uses a safe same-device rename and retains bytes/modes", async () => {
    const rename = vi.fn(fs.rename);
    const engine = createFilesystem({ rename });
    const path = await skill();
    const inventory = await engine.scanInventory([source], guard);
    const batch = await engine.prepareOperation({ kind: "move", target, skills: inventory.skills }, guard);
    expect((await batch.apply(guard))[0]).toMatchObject({ status: "moved", changed: true });
    expect(rename).toHaveBeenCalledWith(path, join(target.path, "one"));
    expect(await exists(path)).toBe(false);
    expect((await fs.stat(join(target.path, "one/scripts/run.sh"))).mode & 0o777).toBe(0o751);
    expect((await fs.stat(join(target.path, "one/.notice"))).mode & 0o777).toBe(0o640);
  });
  it("falls back on EXDEV to a verified stage, then publishes before deleting", async () => {
    const path = await skill();
    const calls: string[] = [];
    const engine = createFilesystem({
      rename: async (from, to) => {
        if (String(from) === path) {
          calls.push("EXDEV");
          throw failure("EXDEV");
        }
        expect(await exists(path)).toBe(true);
        calls.push("publish");
        await fs.rename(from, to);
      },
      rm: async (file, options) => {
        if (String(file) === path) {
          expect(await exists(join(target.path, "one/SKILL.md"))).toBe(true);
          calls.push("remove");
        }
        await fs.rm(file, options);
      },
    });
    const batch = await engine.prepareOperation(
      { kind: "move", target, skills: (await engine.scanInventory([source], guard)).skills },
      guard,
    );
    expect(required((await batch.apply(guard))[0]).status).toBe("moved");
    expect(calls).toEqual(["EXDEV", "publish", "remove"]);
    expect(await stages()).toEqual([]);
  });
  it("retains source on registration failure, and registers once only after publication", async () => {
    const engine = createFilesystem();
    const path = await skill();
    const batch = await engine.prepareOperation(
      { kind: "move", target, skills: (await engine.scanInventory([source], guard)).skills },
      guard,
    );
    const register = vi.fn(async () => {
      expect(await exists(join(target.path, "one/SKILL.md"))).toBe(true);
      expect(await exists(path)).toBe(true);
      throw failure("EACCES");
    });
    expect((await batch.apply(guard, register))[0]).toMatchObject({ status: "source-retained", changed: true });
    expect(register).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(join(path, ".notice"), "utf8")).toBe("notice");
  });
  it("registers only once after publication and keeps all sources until registration succeeds", async () => {
    const engine = createFilesystem();
    await skill();
    await skill(source.path, "two");
    const batch = await engine.prepareOperation(
      { kind: "move", target, skills: (await engine.scanInventory([source], guard)).skills },
      guard,
    );
    const register = vi.fn(async () => {
      expect(await exists(join(target.path, "one/SKILL.md"))).toBe(true);
      expect(await exists(join(source.path, "one/SKILL.md"))).toBe(true);
      expect(await exists(join(source.path, "two/SKILL.md"))).toBe(true);
    });
    expect((await batch.apply(guard, register)).map((item) => item.status)).toEqual(["moved", "moved"]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(source.path)).toEqual([]);
  });
  it.each(["source", "destination"])("retains source if registration work changes the %s", async (changed) => {
    const engine = createFilesystem();
    const path = await skill();
    const batch = await engine.prepareOperation(
      { kind: "move", target, skills: (await engine.scanInventory([source], guard)).skills },
      guard,
    );
    const results = await batch.apply(guard, async () => {
      await fs.writeFile(join(changed === "source" ? path : join(target.path, "one"), ".notice"), "new data");
    });
    expect(results[0]).toMatchObject({ status: "source-retained", changed: true });
    expect(results[0]?.message).toContain("changed");
    expect(await exists(join(path, "SKILL.md"))).toBe(true);
    expect(await fs.readFile(join(path, ".notice"), "utf8")).toBe(changed === "source" ? "new data" : "notice");
  });
  it("stops a move batch on registration failure without deleting any source", async () => {
    const engine = createFilesystem();
    await skill();
    await skill(source.path, "two");
    const batch = await engine.prepareOperation(
      { kind: "move", target, skills: (await engine.scanInventory([source], guard)).skills },
      guard,
    );
    const register = vi.fn(async () => {
      throw failure("EACCES");
    });
    expect((await batch.apply(guard, register)).map((item) => item.status)).toEqual(["source-retained", "skipped"]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(await exists(join(source.path, "one/SKILL.md"))).toBe(true);
    expect(await exists(join(source.path, "two/SKILL.md"))).toBe(true);
    expect(await exists(join(target.path, "two"))).toBe(false);
  });
  it.each(["remove", "move"] as const)("recovers bytes and modes after a partial %s deletion fails", async (kind) => {
    const path = await skill();
    const external = join(temporary, "external");
    await fs.writeFile(external, "safe");
    if (kind === "remove") await fs.symlink(external, join(path, "link"));
    const engine = createFilesystem({
      rm: async (file, options) => {
        if (String(file) === path) {
          await fs.unlink(join(path, ".notice"));
          await fs.unlink(join(path, "scripts/run.sh"));
          if (kind === "remove") await fs.unlink(join(path, "link"));
          throw failure("EACCES");
        }
        return fs.rm(file, options);
      },
    });
    const skills = (await engine.scanInventory([source], guard)).skills;
    const batch = await engine.prepareOperation(kind === "move" ? { kind, target, skills } : { kind, skills }, guard);
    const result = required((await batch.apply(guard, kind === "move" ? async () => {} : undefined))[0]);
    expect(result.status).toBe(kind === "move" ? "source-retained" : "failed");
    expect(result.message).toContain("complete source retained");
    expect(await fs.readFile(join(path, ".notice"), "utf8")).toBe("notice");
    expect(await fs.readFile(join(path, "scripts/run.sh"))).toEqual(Buffer.from([0, 1, 255]));
    expect((await fs.stat(join(path, ".notice"))).mode & 0o777).toBe(0o640);
    expect((await fs.stat(join(path, "scripts/run.sh"))).mode & 0o777).toBe(0o751);
    if (kind === "remove") expect(await fs.readlink(join(path, "link"))).toBe(external);
    expect(await fs.readFile(external, "utf8")).toBe("safe");
    expect(await stages()).toEqual([]);
  });
  it.each([
    ["remove", "rm", "abort"],
    ["remove", "recovery", "abort"],
    ["move", "rm", "abort"],
    ["move", "recovery", "abort"],
    ["remove", "rm", "session"],
    ["remove", "recovery", "session"],
    ["move", "rm", "session"],
    ["move", "recovery", "session"],
  ] as const)("drains %s repair after invalidation during %s (%s)", async (kind, phase, invalidation) => {
    const path = await skill();
    await skill(source.path, "two");
    const precious = join(path, "precious.txt");
    await fs.writeFile(precious, Buffer.from([0, 255, 8]), { mode: 0o640 });
    let owned = true;
    const drainingGuard: Guard = {
      signal: controller.signal,
      check() {
        if (!owned) throw new Error("Session replaced");
      },
      isProjectTrusted() {
        if (!owned) throw new Error("Stale context was called");
        return true;
      },
    };
    function invalidate() {
      if (invalidation === "abort") controller.abort();
      else owned = false;
    }
    const engine = createFilesystem({
      rename: async (from, to) => {
        if (String(from) === path) throw failure("EXDEV");
        return fs.rename(from, to);
      },
      rm: async (file, options) => {
        if (String(file) === path) {
          await fs.unlink(precious);
          await fs.unlink(join(path, "scripts/run.sh"));
          if (phase === "rm") invalidate();
          throw failure("EACCES");
        }
        return fs.rm(file, options);
      },
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        await fs.writeFile(...args);
        if (String(args[0]) === precious && phase === "recovery") invalidate();
      }) as typeof fs.writeFile,
    });
    const skills = (await engine.scanInventory([source], drainingGuard)).skills;
    const batch = await engine.prepareOperation(
      kind === "move" ? { kind, target, skills } : { kind, skills },
      drainingGuard,
    );
    const results = await batch.apply(drainingGuard);
    expect(results.map((item) => item.status)).toEqual([kind === "move" ? "source-retained" : "failed", "skipped"]);
    expect(results[0]?.message).toContain("complete source retained");
    expect(results[0]?.message).not.toContain("incomplete");
    expect(await fs.readFile(precious)).toEqual(Buffer.from([0, 255, 8]));
    expect((await fs.stat(precious)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(join(path, "scripts/run.sh"))).toEqual(Buffer.from([0, 1, 255]));
    expect((await fs.stat(join(path, "scripts/run.sh"))).mode & 0o777).toBe(0o751);
    expect(await fs.readFile(join(path, "SKILL.md"), "utf8")).toBe(content());
    expect(await exists(join(source.path, "two/SKILL.md"))).toBe(true);
    expect(await exists(join(target.path, "two"))).toBe(false);
    expect(await stages()).toEqual([]);
  });
  it.each(["remove", "move"] as const)(
    "restores a fully deleted %s source if rm reports failure after cancellation",
    async (kind) => {
      const path = await skill();
      const engine = createFilesystem({
        rename: async (from, to) => {
          if (String(from) === path) throw failure("EXDEV");
          return fs.rename(from, to);
        },
        rm: async (file, options) => {
          if (String(file) === path) {
            await fs.rm(path, { recursive: true });
            controller.abort();
            throw failure("EACCES");
          }
          return fs.rm(file, options);
        },
      });
      const skills = (await engine.scanInventory([source], guard)).skills;
      const batch = await engine.prepareOperation(kind === "move" ? { kind, target, skills } : { kind, skills }, guard);
      expect((await batch.apply(guard))[0]?.message).toContain("complete source retained");
      expect(await fs.readFile(join(path, ".notice"), "utf8")).toBe("notice");
      expect((await fs.stat(join(path, "scripts/run.sh"))).mode & 0o777).toBe(0o751);
      expect(await stages()).toEqual([]);
    },
  );
  it("reports an incomplete source honestly if partial-delete recovery also fails", async () => {
    const path = await skill();
    const engine = createFilesystem({
      rm: async (file, options) => {
        if (String(file) === path) {
          await fs.unlink(join(path, ".notice"));
          controller.abort();
          throw failure("EACCES");
        }
        return fs.rm(file, options);
      },
      writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]) === join(path, ".notice")) throw failure("EACCES");
        return fs.writeFile(...args);
      }) as typeof fs.writeFile,
    });
    const batch = await engine.prepareOperation(
      { kind: "move", target, skills: (await engine.scanInventory([source], guard)).skills },
      guard,
    );
    const result = required((await batch.apply(guard, async () => {}))[0]);
    expect(result).toMatchObject({ status: "source-retained", changed: true });
    expect(result.message).toContain("source recovery incomplete");
    expect(result.message).toContain(`complete published copy: ${join(target.path, "one")}`);
    expect(result.message).not.toContain("complete source retained");
    expect(await fs.readFile(join(target.path, "one/.notice"), "utf8")).toBe("notice");
    expect(await stages()).toEqual([]);
  });
  it("retains source on copy or source-delete failure", async () => {
    const path = await skill();
    for (const phase of ["copy", "delete"]) {
      const destination = { ...target, path: join(temporary, phase) };
      const engine = createFilesystem({
        writeFile: (async (...args: Parameters<typeof fs.writeFile>) => {
          if (phase === "copy") throw failure("EACCES");
          return fs.writeFile(...args);
        }) as typeof fs.writeFile,
        rm: async (file, options) => {
          if (String(file) === path) throw failure("EACCES");
          return fs.rm(file, options);
        },
      });
      const batch = await engine.prepareOperation(
        { kind: "move", target: destination, skills: (await engine.scanInventory([source], guard)).skills },
        guard,
      );
      const result = required((await batch.apply(guard, async () => {}))[0]);
      expect(result.status).toBe(phase === "copy" ? "failed" : "source-retained");
      expect(await fs.readFile(join(path, ".notice"), "utf8")).toBe("notice");
      expect(await stages()).toEqual([]);
    }
  });
  it("stops remaining items on cancellation but keeps a completed publication result", async () => {
    const engine = createFilesystem({
      rename: async (from, to) => {
        await fs.rename(from, to);
        controller.abort();
      },
    });
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle(), bundle("two")] }, guard);
    const results = await batch.apply(guard);
    expect(results.map((entry) => entry.status)).toEqual(["installed", "skipped"]);
    expect(results.map((entry) => entry.changed)).toEqual([true, false]);
    expect(await stages()).toEqual([]);
    expect(await exists(join(target.path, "two"))).toBe(false);
  });
  it("retains a move source on cancellation after publication and skips registration", async () => {
    const path = await skill();
    const engine = createFilesystem({
      rename: async (from, to) => {
        await fs.rename(from, to);
        controller.abort();
      },
    });
    const batch = await engine.prepareOperation(
      { kind: "move", target, skills: (await engine.scanInventory([source], guard)).skills },
      guard,
    );
    const register = vi.fn();
    expect((await batch.apply(guard, register))[0]).toMatchObject({ status: "source-retained", changed: true });
    expect(register).not.toHaveBeenCalled();
    expect(await exists(path)).toBe(true);
    expect(await stages()).toEqual([]);
  });
  it("serializes overlapping trees across separate engine instances and recovers its queue after failure", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let calls = 0;
    const first = createFilesystem({
      rename: async (from, to) => {
        calls++;
        entered();
        await blocked;
        await fs.rename(from, to);
      },
    });
    const second = createFilesystem({
      rename: async (from, to) => {
        calls++;
        await fs.rename(from, to);
      },
    });
    const one = await first.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    const two = await second.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    const a = one.apply(guard);
    await ready;
    const b = two.apply(guard);
    resume();
    const results = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(results.map((batch) => required(batch[0]).status)).toEqual(["installed", "failed"]);
    const three = await second.prepareOperation({ kind: "add", target, bundles: [bundle("three")] }, guard);
    expect(required((await three.apply(guard))[0]).status).toBe("installed");
    expect(await stages()).toEqual([]);
  });
  it("serializes inventory and preparation behind an active mutation", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const engine = createFilesystem({
      rename: async (from, to) => {
        entered();
        await blocked;
        await fs.rename(from, to);
      },
    });
    const batch = await engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    const applying = batch.apply(guard);
    await ready;
    const inventory = engine.scanInventory([target], guard);
    const preparing = engine.prepareOperation({ kind: "add", target, bundles: [bundle()] }, guard);
    resume();
    await applying;
    expect((await inventory).skills).toHaveLength(1);
    expect((await (await preparing).apply(guard))[0]?.status).toBe("skipped");
  });
  it("reports separate successes, skips and failures in a partial batch", async () => {
    await skill(target.path, "occupied");
    const engine = createFilesystem({
      rename: async (from, to) => {
        if (basename(String(to)) === "failure") throw failure("EACCES");
        await fs.rename(from, to);
      },
    });
    const batch = await engine.prepareOperation(
      { kind: "add", target, bundles: [bundle(), bundle("occupied"), bundle("failure"), bundle("last")] },
      guard,
    );
    expect((await batch.apply(guard)).map((entry) => entry.status)).toEqual([
      "installed",
      "skipped",
      "failed",
      "installed",
    ]);
    expect(await stages()).toEqual([]);
  });
});
