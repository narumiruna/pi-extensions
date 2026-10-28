import { resolve } from "node:path";
import type { ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { InvocationSnapshot } from "../invocation.ts";
import { createSkillsMenu, defaultServices, type Services } from "../menu.ts";
import type { Environment, Guard } from "../types.ts";

beforeAll(() => initTheme("dark"));
const env: Environment = { cwd: "/workspace", homeDir: "/home", agentDir: "/agent", isProjectTrusted: () => true };
const header = "Select a skill to manage it. Loaded and detected skills are listed.";
function native(name = "Alpha", manual = false, scope: "user" | "project" = "user"): Skill {
  return {
    name,
    description: `MODEL_ROUTING_DESCRIPTION ${name}: use only for the rare-routing-phrase-${name}; do not use for unrelated work.`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    disableModelInvocation: manual,
    sourceInfo: { path: `/skills/${name}`, source: "npm:example-skills", origin: "package", scope },
  };
}
function fixture(loaded = [native()], mode: "tui" | "rpc" = "tui", ui: object = {}) {
  const controller = new AbortController();
  const guard: Guard = {
    signal: controller.signal,
    check: () => controller.signal.throwIfAborted(),
    isProjectTrusted: () => true,
  };
  const state: Parameters<typeof createSkillsMenu>[0] = {
    mode: "add",
    source: "",
    selected: new Set(),
    locations: [],
    inventory: { skills: [], warnings: [] },
    warnings: [],
    registrationScope: "none",
    confirmed: false,
    afterScan: "manage",
    loadedSkills: loaded.map((skill) => ({ ...skill, sourceInfo: { ...skill.sourceInfo } })),
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
          canonicalPath: `/canonical/${skill.name}/SKILL.md`,
          enabled: !skill.disableModelInvocation,
        },
    ),
    updateInvocation: vi.fn<Services["updateInvocation"]>(async (snapshot, enabled) => {
      const next = { ...snapshot, enabled };
      disk.set(next.filePath, next);
      return { snapshot: next, changed: snapshot.enabled !== enabled };
    }),
    scanInventory: vi.fn<Services["scanInventory"]>(async () => ({ skills: [], warnings: [] })),
  };
  const ctx = {
    cwd: env.cwd,
    mode,
    hasUI: true,
    isProjectTrusted: () => true,
    getSystemPromptOptions: () => ({ skills: loaded }),
    ui: { ...ui, notify: vi.fn() },
  } as unknown as ExtensionCommandContext;
  const menu = createSkillsMenu(state, "manage", env, guard, services, mode);
  const list = () => {
    const screen = menu.screens.manage({ state });
    if (screen.kind !== "choice") throw new Error("Expected managed skill choices");
    return screen;
  };
  const main = () => {
    const screen = menu.screens.main({ state });
    if (screen.kind !== "actions") throw new Error("Expected main menu");
    return screen;
  };
  const invoke = (action: keyof typeof menu.actions, values: { itemId?: string; value?: string } = {}) =>
    menu.actions[action]({
      ctx,
      state,
      signal: guard.signal,
      itemId: resolve(loaded[0]?.filePath ?? "/missing/SKILL.md"),
      ...values,
    });
  const open = async () => {
    await invoke("manage-skill");
    await invoke("select-invocation", { itemId: "model-invocation" });
    await invoke("review-invocation");
  };
  return { loaded, controller, guard, state, disk, services, ctx, menu, list, main, invoke, open };
}
async function waitFrame(tui: ReturnType<typeof createTuiHarness>, expected: string | RegExp) {
  await vi.waitFor(() => expect(tui.render().join("\n")).toMatch(expected));
}

describe("compact invocation list", () => {
  it.each(["manage", "manage-scan"] as const)("reads and clones the native catalog lazily for %s", async (action) => {
    const f = fixture();
    const read = vi.spyOn(f.ctx, "getSystemPromptOptions");
    f.state.loadedSkills = [];
    expect(f.main().items.find((item) => item.id === "manage")).toMatchObject({
      label: "Manage skills",
      action: "manage",
    });
    expect(f.main().items.some((item) => item.label === "Configure model invocation")).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const result = await f.invoke(action);
    expect(result).toEqual({ kind: "to", screen: action === "manage" ? "manage" : "inventory-path" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.state.loadedSkills).toEqual(f.loaded);
    expect(f.state.loadedSkills).not.toBe(f.loaded);
    expect(f.state.loadedSkills[0]).not.toBe(f.loaded[0]);
    expect(f.state.loadedSkills[0].sourceInfo).not.toBe(f.loaded[0].sourceInfo);
    expect(f.services.readInvocation).not.toHaveBeenCalled();
  });

  it.each(["native-only", "loaded-local", "protected-local", "inventory-only"] as const)(
    "keeps per-skill action order and protection for %s",
    async (kind) => {
      const selected = native();
      selected.filePath = "/skills/Alpha/../Alpha/SKILL.md";
      const loaded = kind !== "inventory-only";
      const f = fixture(loaded ? [selected] : []);
      if (kind !== "native-only")
        f.state.inventory.skills = [
          {
            id: "inventory-alpha",
            name: selected.name,
            description: selected.description,
            path: selected.baseDir,
            directoryPath: selected.baseDir,
            location: { id: "project-pi", label: "Project (Pi)", path: "/skills", scope: "project" },
            content: "instructions",
            fingerprint: "before",
            warnings: [],
            ...(kind === "protected-local" ? { readOnlyReason: "Linked skill is read-only" } : {}),
          },
        ];
      f.state.invocation = { filePath: "/previous/SKILL.md", canonicalPath: "/old-target/SKILL.md", enabled: true };
      f.state.invocationReviewed = true;
      const id = resolve(selected.filePath);
      expect(f.list().items).toHaveLength(1);
      expect(f.list().items[0].id).toBe(id);
      expect(f.list().items[0].description).toBe(
        `${loaded ? "Automatic" : "Not loaded"} · ${kind === "native-only" ? "User" : "Project (Pi)"}`,
      );
      expect(await f.invoke("manage-skill", { itemId: id })).toEqual({ kind: "to", screen: "skill-actions" });
      expect(f.state.managedId).toBe(id);
      expect(f.state.invocation).toBeUndefined();
      expect(f.state.invocationReviewed).toBe(false);
      const actions = f.menu.screens["skill-actions"]({ state: f.state });
      if (actions.kind !== "actions") throw new Error("Expected per-skill actions");
      const model = actions.items.find((item) => item.id === "model-invocation");
      expect(model).toMatchObject({
        action: "select-invocation",
        busyLabel: "Inspecting invocation target…",
        disabled: !loaded,
      });
      expect(actions.items.map((item) => item.id)).toEqual(
        loaded
          ? ["model-invocation", "move-one", "remove-one", "copy-directory", "back"]
          : ["move-one", "remove-one", "copy-directory", "model-invocation", "back"],
      );
      for (const action of ["move-one", "remove-one"]) {
        expect(actions.items.find((item) => item.id === action)?.disabled).toBe(
          kind === "native-only" || kind === "protected-local",
        );
      }
      if (loaded) {
        await f.invoke("select-invocation", { itemId: "model-invocation" });
        expect(f.services.readInvocation).toHaveBeenCalledWith(f.state.loadedSkills[0], expect.any(Object));
        expect(f.services.readInvocation.mock.calls[0][0].filePath).toBe(selected.filePath);
      } else {
        await expect(f.invoke("select-invocation", { itemId: "model-invocation" })).rejects.toThrow(
          "currently loaded Pi skill",
        );
        expect(f.services.readInvocation).not.toHaveBeenCalled();
        expect(f.list().items[0].details).toContain("Not currently loaded by Pi.");
      }
      expect(f.services.updateInvocation).not.toHaveBeenCalled();
      expect(selected.disableModelInvocation).toBe(false);
    },
  );

  it("keeps names in labels and puts modes, scopes, and complete selected identities in their own fields", () => {
    const first = native("configure-pi-starship");
    const second = native("a-very-long-name-that-must-remain-readable-in-the-selected-details", true, "project");
    const f = fixture([first, second]);
    const screen = f.list();
    expect(screen.lines).toEqual([header]);
    expect(screen.items.map((item) => item.label)).toEqual([second.name, first.name]);
    expect(screen.items.map((item) => item.description)).toEqual(["Manual only · Project", "Automatic · User"]);
    expect(screen.items[0].details).toEqual([
      `Skill: ${second.name}`,
      `File: ${second.filePath}`,
      "Source: Project · npm:example-skills",
      "Active: Manual only",
    ]);
    expect(screen.items[0].id).toBe(resolve(second.filePath));
    expect(screen.items[0].searchText).toContain(second.description);
    expect(JSON.stringify(screen.items.map(({ searchText: _hidden, ...display }) => display))).not.toContain(
      "MODEL_ROUTING_DESCRIPTION",
    );
    expect(f.services.readInvocation).not.toHaveBeenCalled();
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
  });

  it.each([false, true].flatMap((manual) => [undefined, false, true].map((saved) => ({ manual, saved }))))(
    "distinguishes native manual=$manual from observed saved=$saved without mutating the catalog",
    ({ manual, saved }) => {
      const skill = native("Alpha", manual);
      const before = structuredClone(skill);
      const f = fixture([skill]);
      if (saved !== undefined) f.state.invocationValues.set(skill.filePath, saved);
      const item = f.list().items[0];
      const active = !manual;
      const mode = (saved ?? active) ? "Automatic" : "Manual only";
      const pending = saved !== undefined && saved !== active;
      expect(item.description).toBe(`${mode} · User${pending ? " · Reload pending" : ""}`);
      expect(item.details).toContain(
        `Active: ${active ? "Automatic" : "Manual only"}${saved !== undefined ? ` · Saved: ${mode}${pending ? " (reload pending)" : ""}` : ""}`,
      );
      expect(f.main().items.some((item) => item.id === "reload")).toBe(pending);
      expect(f.state.invocationChanged).toBe(false);
      expect(skill).toEqual(before);
      expect(f.state.loadedSkills[0]).toEqual(before);
    },
  );

  it("sanitizes all display and search fields while retaining the exact raw path ID", () => {
    const skill = native("Al\u001b[31mpha\u202e");
    skill.filePath = "/skills/unique\npath/\u001b]0;hidden\u0007SKILL.md";
    skill.sourceInfo.source = "npm:example\u001b[31m";
    const before = structuredClone(skill);
    const f = fixture([skill]);
    const item = f.list().items[0];
    expect(item.id).toBe(skill.filePath);
    expect(item.label).toBe("Alpha");
    expect(item.details).toContain("File: /skills/unique path/SKILL.md");
    for (const text of [item.label, item.description ?? "", ...(item.details ?? []), item.searchText ?? ""]) {
      for (const control of ["\u001b", "\u202e", "\n", "\u0007"]) expect(text).not.toContain(control);
    }
    expect(skill).toEqual(before);
  });

  it.each(["", "\u001b[31m\u202e", " \t\r\n ", "\u2003\ufeff\u2028"])(
    "does not expose the raw path when a name becomes empty: %j",
    async (name) => {
      const skill = native(name);
      skill.filePath = "/skills/\u001b]0;unsafe-label\u0007bad\npath/SKILL.md";
      const tui = createTuiHarness({ width: 200, rows: 30 });
      const f = fixture([skill], "tui", { custom: tui.custom });
      const work = runMenu(f.ctx, f.menu, { getState: () => f.state, signal: f.guard.signal });
      try {
        await waitFrame(tui, header);
        const frame = tui.render().join("\n");
        expect(frame).not.toContain("\u001b]0;unsafe-label");
        expect(frame).toContain("Unnamed skill");
        expect(f.list().items[0].label).toBe("Unnamed skill");
        expect(fixture([skill], "rpc").list().items[0].label).toBe(
          "Unnamed skill · Automatic · User · /skills/bad path/SKILL.md",
        );
        expect(f.list().items[0].id).toBe(skill.filePath);
        expect(f.list().items[0].details).toContain("File: /skills/bad path/SKILL.md");
        tui.press("tui.select.confirm");
        await waitFrame(tui, /→.*Model invocation/);
        expect(f.state.managedId).toBe(resolve(skill.filePath));
        expect(f.services.readInvocation).not.toHaveBeenCalled();
        tui.press("tui.select.confirm");
        await waitFrame(tui, "Review invocation target");
        expect(f.services.readInvocation.mock.calls[0][0].filePath).toBe(skill.filePath);
        expect(skill.name).toBe(name);
        expect(f.services.updateInvocation).not.toHaveBeenCalled();
      } finally {
        tui.dispose();
        await work;
      }
    },
  );

  it("renders the screenshot-shaped list without routing prose and preserves searchable hidden descriptions", async () => {
    const skills = [
      "configure-pi-starship",
      "configure-pi-sync",
      "create-agent-skills",
      "herdr",
      "prompt-gpt",
      "typesafe-ai",
      "write-agents-md",
      "write-plans",
    ].map((name, index) => native(name, index === 1));
    skills[3].description += " zzzzz";
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+g" });
    const tui = createTuiHarness({ width: 200, rows: 30, keybindings: keys });
    const f = fixture(skills, "tui", { custom: tui.custom });
    const work = runMenu(f.ctx, f.menu, { getState: () => f.state, signal: f.guard.signal });
    try {
      await waitFrame(tui, header);
      const frame = tui.render().join("\n");
      for (const skill of skills) expect(frame).toContain(skill.name);
      expect(frame).toContain("Automatic · User");
      expect(frame).toContain("Manual only · User");
      expect(frame).toContain(`File: ${skills[0].filePath}`);
      expect(frame).toContain("Source: User · npm:example-skills");
      expect(frame).not.toContain("MODEL_ROUTING_DESCRIPTION");
      expect(frame).not.toContain("This is not the disk inventory");
      tui.type("zzzzz");
      const filtered = tui.render().join("\n");
      expect(filtered).toContain("herdr");
      expect(filtered).not.toContain("configure-pi-starship");
      expect(filtered).not.toContain("MODEL_ROUTING_DESCRIPTION");
      expect(f.services.readInvocation).not.toHaveBeenCalled();
      tui.send("\x07");
      await work;
    } finally {
      tui.dispose();
      await work;
    }
  });

  it("keeps the focused name, standard framing and width bounds when the list is constrained", async () => {
    const tui = createTuiHarness({ width: 200, rows: 30 });
    const f = fixture([native(), native("Beta", true)], "tui", { custom: tui.custom });
    const work = runMenu(f.ctx, f.menu, { getState: () => f.state, signal: f.guard.signal });
    try {
      await waitFrame(tui, header);
      tui.press("tui.select.down");
      for (const width of [1, 12, 80, 200]) {
        for (const rows of [1, 4, 8, 30]) {
          const frame = tui.resize({ width, rows });
          expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
          if (width >= 80) expect(frame.join("\n")).toMatch(/→.*Beta/);
          if (width > 0 && rows >= 8) expect(frame.filter((line) => /^─+$/.test(line))).toHaveLength(2);
        }
      }
      tui.press("ctrl+c");
      await work;
    } finally {
      tui.dispose();
      await work;
    }
  });

  it("keeps mode and complete distinguishing paths in actual RPC labels", async () => {
    const first = native("Same");
    const second = { ...native("Same", true), filePath: "/other/SKILL.md" };
    const f = fixture([first, second], "rpc");
    const rpc = createRpcHarness([
      {
        kind: "select",
        options: [
          "Same · Automatic · User · /skills/Same/SKILL.md",
          "Same · Manual only · User · /other/SKILL.md",
          "Back",
        ],
        response: "Same · Manual only · User · /other/SKILL.md",
      },
      { kind: "select", response: "Model invocation" },
      { kind: "select", response: "Back" },
      { kind: "select", response: "Back" },
      { kind: "select", response: "Back" },
    ]);
    Object.assign(f.ctx.ui, rpc.ui);
    await runMenu(f.ctx, f.menu, { getState: () => f.state, signal: f.guard.signal });
    rpc.assertConsumed();
    expect(f.services.readInvocation.mock.calls[0][0].filePath).toBe(second.filePath);
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
    expect(rpc.dialogs[0].title).toContain(header);
    expect(rpc.dialogs[0].title).not.toContain("MODEL_ROUTING_DESCRIPTION");
  });
});

describe("saved invocation list state", () => {
  it("records an observed disk difference without claiming a write or changing active flags", async () => {
    const f = fixture();
    const before = structuredClone(f.loaded);
    f.disk.set(f.loaded[0].filePath, {
      filePath: f.loaded[0].filePath,
      canonicalPath: "/canonical/Alpha/SKILL.md",
      enabled: false,
    });
    await f.invoke("manage");
    await f.open();
    expect(f.list().items[0].description).toBe("Manual only · User · Reload pending");
    expect(f.list().items[0].details).toContain("Active: Automatic · Saved: Manual only (reload pending)");
    expect(f.main().items.some((item) => item.id === "reload")).toBe(true);
    expect(f.state.invocationChanged).toBe(false);
    expect(f.services.updateInvocation).not.toHaveBeenCalled();
    expect(f.loaded).toEqual(before);
    expect(f.state.loadedSkills).toEqual(before);
  });

  it("keeps saved observations on reopening, and clears the row marker when toggled back to the active value", async () => {
    const f = fixture();
    const before = structuredClone(f.loaded);
    await f.open();
    await f.invoke("save-invocation", { value: "manual only" });
    expect(f.list().items[0].description).toBe("Manual only · User · Reload pending");
    await f.invoke("manage");
    expect(f.list().items[0].description).toBe("Manual only · User · Reload pending");
    await f.open();
    await f.invoke("save-invocation", { value: "automatic" });
    expect(f.list().items[0].description).toBe("Automatic · User");
    expect(f.list().items[0].details).toContain("Active: Automatic · Saved: Automatic");
    expect(f.list().items[0].description).not.toContain("Reload pending");
    expect(f.services.updateInvocation).toHaveBeenCalledTimes(2);
    expect(f.loaded).toEqual(before);
    expect(f.state.loadedSkills).toEqual(before);
  });

  it.each([false, true])("retains the last saved value after failure (initial manual=%s)", async (manual) => {
    const f = fixture([native("Alpha", manual)]);
    await f.open();
    const firstValue = manual ? "automatic" : "manual only";
    const secondValue = manual ? "manual only" : "automatic";
    await f.invoke("save-invocation", { value: firstValue });
    const before = f.list().items[0];
    f.services.updateInvocation.mockRejectedValueOnce(new Error("Write failed"));
    await expect(f.invoke("save-invocation", { value: secondValue })).rejects.toThrow("Write failed");
    expect(f.list().items[0]).toEqual(before);
    expect(f.state.invocationValues.get(f.loaded[0].filePath)).toBe(manual);
    expect(f.loaded[0].disableModelInvocation).toBe(manual);
  });

  it.each([false, true])("keeps observed saved=%s after a no-op save", async (saved) => {
    const f = fixture();
    f.disk.set(f.loaded[0].filePath, {
      filePath: f.loaded[0].filePath,
      canonicalPath: "/canonical/Alpha/SKILL.md",
      enabled: saved,
    });
    await f.open();
    await f.invoke("save-invocation", { value: saved ? "automatic" : "manual only" });
    expect(f.state.invocationChanged).toBe(false);
    expect(f.state.invocationValues.get(f.loaded[0].filePath)).toBe(saved);
    expect(f.main().items.some((item) => item.id === "reload")).toBe(!saved);
    expect(f.services.scanInventory).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps only completed saves when cancellation follows an await (committed=%s)",
    async (committed) => {
      const f = fixture();
      await f.open();
      f.services.updateInvocation.mockImplementationOnce(async (snapshot, enabled, guard) => {
        f.controller.abort();
        if (!committed) guard.check();
        return { snapshot: { ...snapshot, enabled }, changed: true };
      });
      expect(await f.invoke("save-invocation", { value: "manual only" })).toEqual({ kind: "rejected" });
      expect(f.state.invocationValues.get(f.loaded[0].filePath)).toBe(!committed);
      expect(f.state.invocationChanged).toBe(committed);
      expect(f.services.scanInventory).not.toHaveBeenCalled();
      expect(f.ctx.ui.notify).not.toHaveBeenCalled();
      expect(f.loaded[0].disableModelInvocation).toBe(false);
    },
  );

  it("does not publish a stale observed value after read cancellation", async () => {
    const f = fixture();
    f.services.readInvocation.mockImplementationOnce(async (skill) => {
      f.controller.abort();
      return { filePath: skill.filePath, canonicalPath: "/canonical/Alpha/SKILL.md", enabled: false };
    });
    await f.invoke("manage-skill");
    await expect(f.invoke("select-invocation", { itemId: "model-invocation" })).rejects.toThrow();
    expect(f.state.invocationValues.size).toBe(0);
    expect(f.state.invocationChanged).toBe(false);
    expect(f.loaded[0].disableModelInvocation).toBe(false);
  });
});
