import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { createRpcHarness, type RpcHarnessStep } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServices, showSkillsMenu } from "../menu.ts";
import type { Environment, Guard, Inventory, RepositorySnapshot, SkillBundle } from "../types.ts";

let root: string;
let env: Environment;
let guard: Guard;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-integration-"));
  env = {
    cwd: join(root, "workspace"),
    agentDir: join(root, "agent"),
    homeDir: join(root, "home"),
    isProjectTrusted: () => true,
  };
  await mkdir(env.cwd);
  guard = { signal: new AbortController().signal, check() {}, isProjectTrusted: () => true };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const content = "---\nname: sample\ndescription: An integration skill\n---\nInstructions\n";
const snapshot: RepositorySnapshot = {
  repository: "a/b",
  commit: "a".repeat(40),
  entries: [],
  skills: [
    {
      id: "selected",
      directory: "skills/group/sample",
      directoryName: "sample",
      name: "sample",
      description: "An integration skill",
      content,
      warnings: [],
    },
    {
      id: "not-selected",
      directory: "skills/group/unselected",
      directoryName: "unselected",
      name: "unselected",
      description: "Not selected",
      content,
      warnings: [],
    },
  ],
};
const bundle: SkillBundle = {
  id: "selected",
  directoryName: "sample",
  name: "sample",
  warnings: [],
  files: [
    { path: "SKILL.md", content: Buffer.from(content), executable: false },
    { path: "references/example.txt", content: Buffer.from("  exact\tbytes\r\n"), executable: false },
    { path: "scripts/helper.sh", content: Buffer.from("#!/bin/sh\nprintf safe\\n\n"), executable: true },
  ],
};
function choice(response: string): RpcHarnessStep {
  return { kind: "select", response };
}

describe("confirmed UI to real filesystem integration", () => {
  it("removes one original bundle after scanning overlapping skill roots", async () => {
    const skills = join(env.cwd, ".pi", "skills");
    const group = join(skills, "group");
    const path = join(group, "alpha");
    const sibling = join(skills, "beta", "SKILL.md");
    await mkdir(path, { recursive: true });
    await mkdir(join(skills, "beta"));
    await writeFile(join(path, "SKILL.md"), content.replace("name: sample", "name: alpha"));
    await writeFile(sibling, content.replace("name: sample", "name: beta"));
    const rpc = createRpcHarness([
      choice("Scan custom directory"),
      { kind: "input", response: group },
      choice("Scan directory"),
      choice(`alpha · Not loaded · Project (Pi) · ${join(path, "SKILL.md")}`),
      choice("Remove…"),
      choice("Apply changes"),
      choice("Close without reload"),
    ]);
    const services = {
      ...defaultServices,
      scanInventory: vi.fn(defaultServices.scanInventory),
      prepareOperation: vi.fn(defaultServices.prepareOperation),
    };
    const notify = vi.fn();
    const ctx = {
      cwd: env.cwd,
      mode: "rpc",
      hasUI: true,
      getSystemPromptOptions: () => ({ skills: [] }),
      ui: { ...rpc.ui, notify },
    } as unknown as ExtensionCommandContext;
    expect(await showSkillsMenu(ctx, { kind: "main" }, env, guard, services)).toBe(false);
    rpc.assertConsumed();
    const inventory: Inventory = await services.scanInventory.mock.results[1].value;
    const originals = inventory.skills.filter((skill) => skill.path === path);
    expect(originals).toHaveLength(2);
    const request = services.prepareOperation.mock.calls[0][0];
    expect(request).toMatchObject({ kind: "remove", skills: [{ path, location: { id: "project-pi" } }] });
    if (request.kind !== "remove") throw new Error("Expected bundle removal");
    expect(request.skills).toHaveLength(1);
    expect(request.skills[0]).toBe(originals[0]);
    expect(notify).not.toHaveBeenCalled();
    expect(rpc.dialogs.some((dialog) => dialog.title.includes("Selected source trees overlap"))).toBe(false);
    await expect(readFile(join(path, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sibling, "utf8")).toBe(content.replace("name: sample", "name: beta"));
  });

  it("refreshes a saved invocation setting before preparing a subsequent bundle removal", async () => {
    const path = join(env.cwd, ".pi", "skills", "sample");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), content);
    const native = loadSkillsFromDir({ dir: path, source: "project" }).skills;
    const before = JSON.stringify(native);
    const rpc = createRpcHarness([
      choice("Manage skills"),
      choice(`sample · Automatic · Project (Pi) · ${join(path, "SKILL.md")}`),
      choice("Model invocation"),
      choice("Open invocation setting"),
      choice("Model invocation (automatic)"),
      choice("Back"),
      choice("Back"),
      choice("Back"),
      choice("Back"),
      choice("Manage skills"),
      choice(`sample · Manual only (reload pending) · Project (Pi) · ${join(path, "SKILL.md")}`),
      choice("Remove…"),
      choice("Apply changes"),
      choice("Close without reload"),
    ]);
    const notify = vi.fn();
    const ctx = {
      cwd: env.cwd,
      mode: "rpc",
      hasUI: true,
      getSystemPromptOptions: () => ({ skills: native }),
      ui: { ...rpc.ui, notify },
    } as unknown as ExtensionCommandContext;
    expect(await showSkillsMenu(ctx, { kind: "main" }, env, guard)).toBe(false);
    rpc.assertConsumed();
    expect(notify).not.toHaveBeenCalled();
    expect(JSON.stringify(native)).toBe(before);
    expect(rpc.dialogs.some((dialog) => dialog.title.includes("Source changed since inventory"))).toBe(false);
    await expect(readFile(join(path, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["project-pi", "user-pi", "project-shared", "user-shared", "custom-project", "custom-user", "custom-copy"])(
    "installs only checked complete bundles into %s",
    async (target) => {
      const defaults: Record<string, [string, string]> = {
        "project-pi": ["Project (Pi)", join(env.cwd, ".pi", "skills")],
        "user-pi": ["User (Pi)", join(env.agentDir, "skills")],
        "project-shared": ["Project (Shared)", join(env.cwd, ".agents", "skills")],
        "user-shared": ["User (Shared)", join(env.homeDir, ".agents", "skills")],
      };
      const custom = target.startsWith("custom-");
      const destination = custom ? join(env.cwd, "custom-skills") : defaults[target][1];
      const steps = [choice("[ ] sample · skills/group/sample"), choice("Continue")];
      if (custom)
        steps.push(
          choice("Custom directory"),
          { kind: "input", response: destination },
          choice(
            target === "custom-project"
              ? "Register for project"
              : target === "custom-user"
                ? "Register for user"
                : "Copy only",
          ),
        );
      else steps.push(choice(`${defaults[target][0]} · ${destination}`));
      steps.push(choice("Prepare review"), choice("Apply changes"), choice("Close without reload"));
      const rpc = createRpcHarness(steps);
      const notify = vi.fn();
      const ctx = {
        cwd: env.cwd,
        mode: "rpc",
        hasUI: true,
        ui: { ...rpc.ui, notify },
      } as unknown as ExtensionCommandContext;
      const services = {
        ...defaultServices,
        discoverRepository: vi.fn(async () => snapshot),
        downloadBundles: vi.fn(async () => [bundle]),
      };
      expect(await showSkillsMenu(ctx, { kind: "add", repository: "a/b" }, env, guard, services)).toBe(false);
      rpc.assertConsumed();
      expect(notify).not.toHaveBeenCalled();
      expect(services.downloadBundles).toHaveBeenCalledWith(snapshot, ["selected"], expect.any(AbortSignal));
      expect(await readdir(destination)).toEqual(["sample"]);
      for (const file of bundle.files)
        expect(await readFile(join(destination, "sample", file.path))).toEqual(Buffer.from(file.content));
      if (process.platform !== "win32")
        expect((await stat(join(destination, "sample/scripts/helper.sh"))).mode & 0o111).not.toBe(0);
      const settings =
        target === "custom-project"
          ? join(env.cwd, ".pi/settings.json")
          : target === "custom-user"
            ? join(env.agentDir, "settings.json")
            : undefined;
      if (settings)
        expect(JSON.parse(await readFile(settings, "utf8")).skills).toContain(
          target === "custom-project" ? "./../custom-skills" : destination,
        );
      else {
        await expect(readFile(join(env.cwd, ".pi/settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(env.agentDir, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await readdir(env.cwd)).some((name) => name.startsWith(".pi-skills-stage-"))).toBe(false);
    },
  );
});
