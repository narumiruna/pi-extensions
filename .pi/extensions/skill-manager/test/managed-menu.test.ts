import type { ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { InvocationSnapshot, InvocationUpdate } from "../invocation.ts";
import { createSkillsMenu, defaultServices, type Services } from "../menu.ts";
import type { Environment, Guard, LocalSkill } from "../types.ts";

const env: Environment = { cwd: "/workspace", agentDir: "/agent", homeDir: "/home", isProjectTrusted: () => true };
function local(name = "alpha", readOnlyReason?: string): LocalSkill {
  const path = `/workspace/.pi/skills/${name}`;
  return {
    id: path,
    path,
    directoryPath: path,
    name,
    description: `${name} disk description`,
    content: "original bytes",
    warnings: [],
    fingerprint: `${name}-fingerprint`,
    readOnlyReason,
    location: { id: "project-pi", path: "/workspace/.pi/skills", scope: "project", label: "Project (Pi)" },
  };
}
function loaded(
  filePath = "/workspace/.pi/skills/alpha/SKILL.md",
  name = "alpha",
  scope: "user" | "project" = "project",
): Skill {
  const baseDir = filePath.slice(0, filePath.lastIndexOf("/"));
  return {
    name,
    filePath,
    baseDir,
    description: `${name} native description`,
    disableModelInvocation: false,
    sourceInfo: {
      path: baseDir,
      source: scope === "user" ? "npm:example" : "local",
      scope,
      origin: scope === "user" ? "package" : "top-level",
    },
  };
}
function fixture(inventory: LocalSkill[] = [], native: Skill[] = []) {
  const controller = new AbortController();
  const guard: Guard = {
    signal: controller.signal,
    check: () => controller.signal.throwIfAborted(),
    isProjectTrusted: () => true,
  };
  const state: Parameters<typeof createSkillsMenu>[0] = {
    mode: "remove",
    source: "",
    selected: new Set(),
    locations: [],
    inventory: { skills: inventory, warnings: [] },
    warnings: [],
    registrationScope: "none",
    confirmed: false,
    afterScan: "manage",
    loadedSkills: [],
    invocationChanged: false,
    invocationValues: new Map(),
    reload: false,
  };
  const disk = new Map<string, InvocationSnapshot>();
  const services = {
    ...defaultServices,
    readInvocation: vi.fn<Services["readInvocation"]>(
      async (skill) =>
        disk.get(skill.filePath) ?? {
          filePath: skill.filePath,
          canonicalPath: skill.filePath,
          enabled: !skill.disableModelInvocation,
        },
    ),
    updateInvocation: vi.fn<Services["updateInvocation"]>(async (snapshot, enabled) => {
      const next = { ...snapshot, enabled };
      disk.set(next.filePath, next);
      return { snapshot: next, changed: snapshot.enabled !== enabled };
    }),
    scanInventory: vi.fn<Services["scanInventory"]>(async () => ({ skills: inventory, warnings: [] })),
    prepareOperation: vi.fn<Services["prepareOperation"]>(async (request) => ({
      kind: request.kind,
      summary: ["Exact original inventory"],
      apply: vi.fn(async () => []),
    })),
    copyToClipboard: vi.fn<Services["copyToClipboard"]>(async () => {}),
  };
  const ctx = {
    cwd: env.cwd,
    mode: "tui",
    hasUI: true,
    getSystemPromptOptions: vi.fn(() => ({ skills: native })),
    ui: { notify: vi.fn() },
  } as unknown as ExtensionCommandContext;
  const menu = createSkillsMenu(state, "main", env, guard, services);
  const invoke = async (action: keyof typeof menu.actions, itemId = "action", value?: string) =>
    menu.actions[action]({ ctx, state, signal: guard.signal, itemId, value });
  const actions = () => {
    const screen = menu.screens["skill-actions"]({ state });
    if (screen.kind !== "actions") throw new Error("Expected skill actions");
    return screen;
  };
  const list = () => {
    const screen = menu.screens.manage({ state });
    if (screen.kind !== "choice") throw new Error("Expected managed choices");
    return screen;
  };
  const select = async (filePath: string) => {
    await invoke("manage");
    return invoke("manage-skill", filePath);
  };
  const settings = async () => {
    await invoke("select-invocation");
    await invoke("review-invocation");
  };
  return { controller, guard, state, services, ctx, menu, invoke, actions, list, select, settings, native };
}

function action(f: ReturnType<typeof fixture>, id: string) {
  const item = f.actions().items.find((item) => item.id === id);
  if (!item) throw new Error(`Missing action ${id}`);
  return item;
}

describe("per-skill management capabilities", () => {
  it("removes the main configuration entry and reads native skills only when management starts", async () => {
    const f = fixture([local()], [loaded()]);
    const main = f.menu.screens.main({ state: f.state });
    if (main.kind !== "actions") throw new Error("Expected main menu");
    expect(main.items.map((item) => item.label)).not.toContain("Configure model invocation");
    expect(main.items.find((item) => item.id === "manage")?.label).toBe("Manage skills");
    expect(f.ctx.getSystemPromptOptions).not.toHaveBeenCalled();
    await f.select(f.native[0].filePath);
    expect(f.ctx.getSystemPromptOptions).toHaveBeenCalledTimes(1);
    expect(f.list().items).toHaveLength(1);
    expect(f.actions().items[0].id).toBe("model-invocation");
    expect(action(f, "model-invocation").disabled).toBe(false);
    expect(f.services.readInvocation).not.toHaveBeenCalled();
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
    await f.invoke("select-invocation");
    expect(f.services.readInvocation.mock.calls[0][0]).toEqual(f.native[0]);
    expect(f.state.invocationReviewed).toBe(false);
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
  });

  it.each([false, true].flatMap((isLoaded) => [false, true].map((protectedBundle) => ({ isLoaded, protectedBundle }))))(
    "separates loaded=$isLoaded from protected bundle=$protectedBundle permissions",
    async ({ isLoaded, protectedBundle }) => {
      const source = local("alpha", protectedBundle ? "Linked bundle is read-only" : undefined);
      const f = fixture([source], isLoaded ? [loaded()] : []);
      await f.select(`${source.path}/SKILL.md`);
      expect(action(f, "model-invocation").disabled).toBe(!isLoaded);
      expect(action(f, "move-one").disabled).toBe(protectedBundle);
      expect(action(f, "remove-one").disabled).toBe(protectedBundle);
      expect(f.actions().items[0].id).toBe(isLoaded ? "model-invocation" : "move-one");
      if (protectedBundle) {
        await expect(f.invoke("move-one")).rejects.toThrow("Linked bundle is read-only");
        await expect(f.invoke("remove-one")).rejects.toThrow("Linked bundle is read-only");
        expect(f.services.prepareOperation).not.toHaveBeenCalled();
      }
      if (isLoaded) {
        await f.settings();
        await f.invoke("save-invocation", "model-invocation", "manual only");
        expect(f.state.invocationValues.get(f.native[0].filePath)).toBe(false);
        expect(f.native[0].disableModelInvocation).toBe(false);
      } else {
        await expect(f.invoke("select-invocation")).rejects.toThrow("currently loaded Pi skill");
        expect(f.services.readInvocation).not.toHaveBeenCalled();
        expect(f.services.updateInvocation).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["package", "/agent/npm/node_modules/example/skills/skill/SKILL.md", "user"],
    ["ancestor", "/ancestor/.pi/skills/skill/SKILL.md", "project"],
    ["linked", "/outside/linked/skill/SKILL.md", "user"],
    ["standalone", "/outside/standalone.md", "project"],
  ] as const)("keeps loaded-only %s configurable without inventing bundle permissions", async (name, path, scope) => {
    const native = loaded(path, name, scope);
    const before = structuredClone(native);
    const f = fixture([], [native]);
    await f.select(path);
    expect(action(f, "model-invocation").disabled).toBe(false);
    expect(action(f, "move-one").disabled).toBe(true);
    expect(action(f, "remove-one").disabled).toBe(true);
    await expect(f.invoke("move-one")).rejects.toThrow();
    await expect(f.invoke("remove-one")).rejects.toThrow();
    expect(f.services.prepareOperation).not.toHaveBeenCalled();
    await f.invoke("copy-directory");
    expect(f.services.copyToClipboard).toHaveBeenCalledWith(native.baseDir);
    await f.settings();
    await f.invoke("save-invocation", "model-invocation", "manual only");
    expect(f.state.invocation?.filePath).toBe(path);
    expect(f.state.invocationValues.get(path)).toBe(false);
    expect(native).toEqual(before);
    expect(f.state.loadedSkills[0]).toEqual(before);
    expect(action(f, "move-one").disabled).toBe(true);
  });

  it("passes only the selected original inventory entry and its bundle ID to removal", async () => {
    const first = local("alpha");
    const second = local("beta");
    const f = fixture([first, second], [loaded()]);
    f.state.selected.add(second.id);
    await f.select(`${first.path}/SKILL.md`);
    await f.invoke("remove-one");
    expect(f.state.selected).toEqual(new Set([first.id]));
    expect(f.state.selected.has(`${first.path}/SKILL.md`)).toBe(false);
    expect(f.services.prepareOperation.mock.calls[0][0]).toEqual({ kind: "remove", skills: [first] });
    expect(f.services.prepareOperation.mock.calls[0][0].kind).toBe("remove");
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
  });

  it.each(["remove", "move"] as const)("uses only the first overlapping-root entry for per-skill %s", async (kind) => {
    const first = local();
    const duplicate = { ...first, fingerprint: "later-fingerprint", location: { ...first.location, label: "Custom" } };
    const f = fixture([first, duplicate], [loaded()]);
    f.services.previewRegistration = vi.fn(async () => undefined);
    await f.select(`${first.path}/SKILL.md`);
    expect(f.list().items).toHaveLength(1);
    await f.invoke(kind === "remove" ? "remove-one" : "move-one");
    if (kind === "move") {
      f.state.target = { ...first.location, path: "/destination" };
      await f.invoke("prepare");
    }
    const request = f.services.prepareOperation.mock.calls[0][0];
    expect(request).toMatchObject({ kind, skills: [first] });
    if (request.kind === "add") throw new Error("Expected local operation");
    expect(request.skills).toHaveLength(1);
    expect(request.skills[0]).toBe(first);
  });

  it.each(["remove", "move"].flatMap((kind) => [false, true].map((protectedFirst) => ({ kind, protectedFirst }))))(
    "preserves first-entry authorization in bulk $kind with protected=$protectedFirst",
    async ({ kind, protectedFirst }) => {
      const first = local("alpha", protectedFirst ? "First scan is protected" : undefined);
      const duplicate = { ...first, readOnlyReason: undefined, content: "later content" };
      const other = local("beta");
      const f = fixture([first, duplicate, other]);
      f.services.previewRegistration = vi.fn(async () => undefined);
      await f.invoke("begin", kind);
      f.state.selected = new Set([first.id, other.id]);
      const selection = f.menu.screens.select({ state: f.state });
      const preview = f.menu.screens.preview({ state: f.state });
      if (selection.kind !== "multiSelect" || preview.kind !== "browse") throw new Error("Expected local selection");
      expect(selection.items).toHaveLength(2);
      expect(selection.items[0]).toMatchObject({
        id: first.id,
        disabled: protectedFirst,
        disabledReason: first.readOnlyReason,
      });
      expect(preview.items).toHaveLength(2);
      expect(preview.items[0]).toMatchObject({
        id: first.id,
        statusText: first.readOnlyReason ?? "Detected on disk",
        detailDocument: { content: expect.stringContaining(first.content) },
      });
      expect(preview.items[0].detailDocument?.content).not.toContain(duplicate.content);
      await f.invoke("continue");
      if (kind === "move") {
        f.state.target = { ...other.location, path: "/destination" };
        await f.invoke("prepare");
      }
      const request = f.services.prepareOperation.mock.calls[0][0];
      const expected = protectedFirst ? [other] : [first, other];
      expect(request).toMatchObject({ kind, skills: expected });
      if (request.kind === "add") throw new Error("Expected local operation");
      expect(request.skills).toHaveLength(expected.length);
      request.skills.forEach((skill, index) => {
        expect(skill).toBe(expected[index]);
      });
      if (protectedFirst) {
        await f.select(`${first.path}/SKILL.md`);
        expect(action(f, "remove-one").disabled).toBe(true);
        expect(action(f, "move-one").disabled).toBe(true);
        await expect(f.invoke("remove-one")).rejects.toThrow("First scan is protected");
        await expect(f.invoke("move-one")).rejects.toThrow("First scan is protected");
      }
      expect(f.services.prepareOperation).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a name conflict once when overlapping roots contain the same entry", () => {
    const first = local();
    const f = fixture([first, { ...first }]);
    f.state.mode = "add";
    f.state.repository = {
      repository: "a/b",
      commit: "a".repeat(40),
      entries: [],
      skills: [
        {
          id: "incoming",
          name: first.name,
          directory: "skills/alpha",
          directoryName: "alpha",
          description: "incoming",
          content: "",
          warnings: [],
        },
      ],
    };
    f.state.selected.add("incoming");
    const review = f.menu.screens.review({ state: f.state });
    if (review.kind !== "review" || typeof review.content !== "string") throw new Error("Expected review");
    expect(review.content.match(/Name conflict:/g)).toHaveLength(1);
  });

  it("keeps malformed disk skills removable without treating them as loaded", async () => {
    const source = local();
    source.warnings = ["description is required"];
    source.description = "";
    const f = fixture([source]);
    await f.select(`${source.path}/SKILL.md`);
    expect(f.actions().lines).toContain("description is required");
    expect(action(f, "model-invocation").disabled).toBe(true);
    expect(action(f, "remove-one").disabled).toBe(false);
    await f.invoke("remove-one");
    expect(f.services.prepareOperation.mock.calls[0][0]).toEqual({ kind: "remove", skills: [source] });
  });

  it("does not attach a loaded skill by name or inferred canonical alias", async () => {
    const source = local("same", "Alias is read-only");
    const native = loaded("/canonical/same/SKILL.md", "same", "user");
    const f = fixture([source], [native]);
    await f.select(`${source.path}/SKILL.md`);
    expect(f.list().items).toHaveLength(2);
    expect(action(f, "model-invocation").disabled).toBe(true);
    await expect(f.invoke("select-invocation")).rejects.toThrow("currently loaded Pi skill");
    await f.invoke("manage-skill", native.filePath);
    expect(action(f, "model-invocation").disabled).toBe(false);
    expect(action(f, "remove-one").disabled).toBe(true);
    await f.invoke("select-invocation");
    expect(f.services.readInvocation.mock.calls[0][0].filePath).toBe(native.filePath);
  });

  it("main custom scanning also captures native loaded entries", async () => {
    const f = fixture([], [loaded("/outside/skill/SKILL.md")]);
    await f.invoke("manage-scan");
    expect(f.ctx.getSystemPromptOptions).toHaveBeenCalledTimes(1);
    expect(f.state.afterScan).toBe("manage");
    expect(f.list().items.map((item) => item.id)).toContain(f.native[0].filePath);
  });

  it("changing the selected skill clears reviewed state and rejects an old source snapshot", async () => {
    const native = [loaded(), loaded("/outside/beta/SKILL.md", "beta")];
    const f = fixture([], native);
    await f.select(native[0].filePath);
    await f.settings();
    const first = f.state.invocation;
    await f.invoke("manage-skill", native[1].filePath);
    expect(f.state.invocation).toBeUndefined();
    expect(f.state.invocationReviewed).toBe(false);
    await expect(f.invoke("review-invocation")).rejects.toThrow("currently loaded");
    f.state.invocation = first;
    f.state.invocationReviewed = true;
    await expect(f.invoke("review-invocation")).rejects.toThrow("currently loaded");
    await expect(f.invoke("save-invocation", "model-invocation", "manual only")).rejects.toThrow(
      "Review the invocation target",
    );
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
  });
});

describe("selected-resource await boundaries", () => {
  it.each(["selection", "catalog"])("does not publish target inspection after %s changes", async (change) => {
    const native = [loaded(), loaded("/outside/beta/SKILL.md", "beta")];
    const f = fixture([], native);
    await f.select(native[0].filePath);
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<InvocationSnapshot>();
    f.services.readInvocation.mockImplementationOnce(async () => {
      started.resolve();
      return finished.promise;
    });
    const inspecting = f.invoke("select-invocation");
    await started.promise;
    if (change === "selection") await f.invoke("manage-skill", native[1].filePath);
    else await f.invoke("manage");
    finished.resolve({ filePath: native[0].filePath, canonicalPath: native[0].filePath, enabled: true });
    expect(await inspecting).toEqual({ kind: "rejected" });
    expect(f.state.invocation).toBeUndefined();
    expect(f.state.invocationValues.size).toBe(0);
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
  });

  it.each(["selection", "snapshot", "catalog"])(
    "records a committed save without replacing current UI after %s changes",
    async (change) => {
      const native = [loaded(), loaded("/outside/beta/SKILL.md", "beta")];
      const f = fixture([], native);
      await f.select(native[0].filePath);
      await f.settings();
      const previous = f.state.invocation;
      if (!previous) throw new Error("Missing reviewed snapshot");
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<InvocationUpdate>();
      f.services.updateInvocation.mockImplementationOnce(async () => {
        started.resolve();
        return finished.promise;
      });
      const saving = f.invoke("save-invocation", "model-invocation", "manual only");
      await started.promise;
      if (change === "selection") await f.invoke("manage-skill", native[1].filePath);
      else if (change === "snapshot") f.state.invocation = { ...previous };
      else await f.invoke("manage");
      const current = f.state.invocation;
      finished.resolve({ snapshot: { ...previous, enabled: false }, changed: true });
      expect(await saving).toEqual({ kind: "rejected" });
      expect(f.state.invocation).toBe(current);
      expect(f.state.invocationValues.get(native[0].filePath)).toBe(false);
      expect(f.state.invocationChanged).toBe(true);
      expect(f.state.inventory.skills).toEqual([]);
      expect(f.services.scanInventory).not.toHaveBeenCalled();
      expect(f.ctx.ui.notify).not.toHaveBeenCalled();
      expect(f.native[0].disableModelInvocation).toBe(false);
    },
  );
});
