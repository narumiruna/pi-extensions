import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));
let root: string;
let cwd: string;
let agentDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-runtime-"));
  cwd = join(root, "workspace");
  agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function resources(discovered: boolean, trusted = true) {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  if (discovered) {
    const path = join(cwd, ".pi", "extensions", "skills");
    await mkdir(dirname(path), { recursive: true });
    await symlink(dirname(entrypoint), path, "dir");
  }
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: !discovered,
    additionalExtensionPaths: discovered ? [] : [entrypoint],
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  return { loader, settingsManager };
}

async function seed(path: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: sample\ndescription: A sample skill\n---\nInstructions\n");
}

describe("real Pi Jiti resource loader", () => {
  it.each([false, true])(
    "loads the local entrypoint (auto-discovery=%s) and exercises the lazy menu boundary",
    async (discovered) => {
      const skill = join(cwd, ".pi", "skills", "sample");
      await seed(skill);
      const { loader } = await resources(discovered);
      const extension = loader.getExtensions().extensions.find((item) => item.commands.has("skills"));
      expect(extension).toBeDefined();
      const command = extension?.commands.get("skills");
      if (!command) throw new Error("Skills command did not load");
      const rpc = createRpcHarness([
        { kind: "select", response: "Manage skills" },
        { kind: "select", response: `sample · Automatic · Project (Pi) · ${join(skill, "SKILL.md")}` },
        { kind: "select", response: "Remove…" },
        { kind: "select", response: "Apply changes" },
        { kind: "select", response: "Close without reload" },
      ]);
      const notify = vi.fn();
      const ctx = {
        cwd,
        mode: "rpc",
        hasUI: true,
        sessionManager: {},
        isProjectTrusted: () => true,
        getSystemPromptOptions: () => ({ skills: loader.getSkills().skills }),
        ui: { ...rpc.ui, notify },
        reload: vi.fn(),
      } as unknown as ExtensionCommandContext;
      await command.handler("", ctx);
      rpc.assertConsumed();
      expect(notify).not.toHaveBeenCalled();
      await expect(readFile(join(skill, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
      // Resource state stays unchanged until an explicit reload.
      expect(loader.getSkills().skills.some((item) => item.name === "sample")).toBe(true);
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions.filter((item) => item.commands.has("skills"))).toHaveLength(1);
      expect(loader.getSkills().skills.some((item) => item.name === "sample")).toBe(false);
    },
  );
  it.each([false, true].flatMap((discovered) => [false, true].map((nativeOnly) => ({ discovered, nativeOnly }))))(
    "configures a linked skill without changing the catalog before reload (auto-discovery=$discovered, native-only=$nativeOnly)",
    async ({ discovered, nativeOnly }) => {
      const target = join(root, "source", "sample");
      const linked = nativeOnly ? join(root, "registered", "sample") : join(agentDir, "skills", "sample");
      await seed(target);
      await mkdir(dirname(linked), { recursive: true });
      await symlink(target, linked, "dir");
      if (nativeOnly)
        await writeFile(join(agentDir, "settings.json"), JSON.stringify({ skills: [join(linked, "SKILL.md")] }));
      const original = await readFile(join(target, "SKILL.md"), "utf8");
      const { loader } = await resources(discovered);
      const native = loader.getSkills().skills;
      const before = JSON.stringify(native);
      const { formatSkillsForPrompt } = await import("@earendil-works/pi-coding-agent");
      const promptBefore = formatSkillsForPrompt(native);
      const command = loader
        .getExtensions()
        .extensions.find((item) => item.commands.has("skills"))
        ?.commands.get("skills");
      if (!command) throw new Error("Skills command did not load");
      const scope = nativeOnly ? "User" : "User (Pi)";
      const blocked = nativeOnly
        ? "Bundle actions require a scanned inventory entry"
        : "Symbolic link directory is read-only";
      const rpc = createRpcHarness([
        { kind: "select", response: "Manage skills" },
        { kind: "select", response: `sample · Automatic · ${scope} · ${join(linked, "SKILL.md")}` },
        { kind: "select", response: `[-] Move… (unavailable: ${blocked})` },
        { kind: "select", response: `[-] Remove… (unavailable: ${blocked})` },
        { kind: "select", response: "Model invocation" },
        { kind: "select", response: "Open invocation setting" },
        { kind: "select", response: "Model invocation (automatic)" },
        { kind: "select", response: "Back" },
        { kind: "select", response: "Back" },
        { kind: "select", response: "Back" },
        { kind: "select", response: "Back" },
        { kind: "select", response: "Close without reload" },
      ]);
      const notify = vi.fn();
      const ctx = {
        cwd,
        mode: "rpc",
        hasUI: true,
        sessionManager: {},
        isProjectTrusted: () => true,
        getSystemPromptOptions: () => ({ skills: native }),
        ui: { ...rpc.ui, notify },
        reload: vi.fn(),
      } as unknown as ExtensionCommandContext;
      await command.handler("", ctx);
      rpc.assertConsumed();
      expect(notify).not.toHaveBeenCalled();
      const actions = rpc.dialogs.find((dialog) => dialog.title.startsWith(`sample · ${scope}`));
      expect(actions?.options).toEqual([
        "Model invocation",
        `[-] Move… (unavailable: ${blocked})`,
        `[-] Remove… (unavailable: ${blocked})`,
        "[-] Copy directory path (unavailable: Clipboard copy requires Pi TUI)",
        "Back",
      ]);
      expect(rpc.dialogs.some((dialog) => dialog.title.includes(`Writes target: ${join(target, "SKILL.md")}`))).toBe(
        true,
      );
      expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(
        original.replace("---\nInstructions", "disable-model-invocation: true\n---\nInstructions"),
      );
      expect(JSON.stringify(loader.getSkills().skills)).toBe(before);
      expect(formatSkillsForPrompt(loader.getSkills().skills)).toBe(promptBefore);
      expect(ctx.reload).not.toHaveBeenCalled();
      await loader.reload();
      const reloaded = loader.getSkills().skills;
      expect(reloaded.find((skill) => skill.name === "sample")?.disableModelInvocation).toBe(true);
      expect(formatSkillsForPrompt(reloaded)).not.toContain("<name>sample</name>");
      expect(reloaded.some((skill) => skill.name === "sample")).toBe(true);
    },
  );
  it("does not auto-discover this project extension without project trust", async () => {
    const { loader } = await resources(true, false);
    expect(loader.getExtensions().extensions.some((item) => item.commands.has("skills"))).toBe(false);
  });
  it("discovers a registered custom directory only after explicit reload", async () => {
    const { loader } = await resources(false);
    const location = join(cwd, "custom-skills");
    await seed(join(location, "sample"));
    const { previewRegistration, applyRegistration } = await import("../locations.ts");
    const controller = new AbortController();
    const guard = {
      signal: controller.signal,
      check() {
        controller.signal.throwIfAborted();
      },
      isProjectTrusted: () => true,
    };
    const env = { cwd, agentDir, homeDir: join(root, "home"), isProjectTrusted: () => true };
    const plan = await previewRegistration(location, "project", env, guard);
    expect(plan).toBeDefined();
    if (!plan) throw new Error("Custom registration was not prepared");
    await applyRegistration(plan, env, guard);
    expect(loader.getSkills().skills.some((item) => item.name === "sample")).toBe(false);
    await loader.reload();
    expect(loader.getSkills().skills.some((item) => item.name === "sample")).toBe(true);
  });
});
