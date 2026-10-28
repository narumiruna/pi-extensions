import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness, type RpcHarnessStep } from "@narumitw/pi-tui-kit/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultServices, type Services, showSkillsMenu } from "../menu.ts";
import type { Environment, Guard, LocalSkill, Location, PreparedBatch, RepositorySnapshot } from "../types.ts";

beforeAll(() => {
  initTheme("dark");
});
const project: Location = { id: "project-pi", label: "Project (Pi)", path: "/workspace/.pi/skills", scope: "project" };
const user: Location = { id: "user-pi", label: "User (Pi)", path: "/agent/skills", scope: "user" };
const env: Environment = { cwd: "/workspace", agentDir: "/agent", homeDir: "/home", isProjectTrusted: () => true };
const snapshot: RepositorySnapshot = {
  repository: "a/b",
  commit: "a".repeat(40),
  entries: [],
  skills: ["Alpha", "Beta"].map((name, index) => ({
    id: `remote-${index}`,
    name,
    description: `${name} description`,
    directory: `skills/group/${name.toLowerCase()}`,
    directoryName: name.toLowerCase(),
    content: `---\nname: ${name.toLowerCase()}\ndescription: ${name}\n---\nExact instructions\n`,
    warnings: [],
  })),
};
const local: LocalSkill = {
  id: "/workspace/.pi/skills/alpha",
  path: "/workspace/.pi/skills/alpha",
  directoryPath: "/workspace/.pi/skills/alpha",
  name: "Alpha",
  description: "Alpha description",
  location: project,
  content: snapshot.skills[0].content,
  fingerprint: "fingerprint",
  warnings: [],
};
function fixture() {
  const controller = new AbortController();
  const guard: Guard = {
    signal: controller.signal,
    check() {
      controller.signal.throwIfAborted();
    },
    isProjectTrusted: () => true,
  };
  const apply = vi.fn<PreparedBatch["apply"]>(async (_guard, register) => {
    await register?.();
    return [{ status: "installed", destination: `${project.path}/alpha`, message: "Installed", changed: true }];
  });
  const services = {
    ...defaultServices,
    loadLocations: vi.fn(async () => ({ locations: [project, user], warnings: [] })),
    scanInventory: vi.fn(async () => ({ skills: [local], warnings: [] })),
    discoverRepository: vi.fn<Services["discoverRepository"]>(async () => snapshot),
    downloadBundles: vi.fn(async () => [
      { id: "remote-0", directoryName: "alpha", name: "Alpha", files: [], warnings: [] },
    ]),
    prepareOperation: vi.fn<Services["prepareOperation"]>(async () => ({
      kind: "add" as const,
      summary: ["Install /workspace/.pi/skills/alpha"],
      apply,
    })),
    previewRegistration: vi.fn(async () => undefined),
    applyRegistration: vi.fn(async () => {}),
    copyToClipboard: vi.fn<Services["copyToClipboard"]>(async () => {}),
  };
  return { controller, guard, services, apply };
}
function context(ui: object, mode: "tui" | "rpc") {
  return {
    cwd: env.cwd,
    mode,
    hasUI: true,
    ui: { ...ui, notify: vi.fn() },
    sessionManager: {},
    getSystemPromptOptions: () => ({ skills: [] }),
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
}
function select(response: string | undefined): RpcHarnessStep {
  const labels: Record<string, string> = {
    "[ ] Alpha": "[ ] Alpha · skills/group/alpha",
    "[ ] Alpha · Project (Pi)": `[ ] Alpha · Project (Pi) · ${local.path}`,
    "Project (Pi)": `Project (Pi) · ${project.path}`,
    "User (Pi)": `User (Pi) · ${user.path}`,
  };
  return { kind: "select", response: response === undefined ? undefined : (labels[response] ?? response) };
}

async function waitTitle(tui: ReturnType<typeof createTuiHarness>, title: string) {
  await vi.waitFor(() => {
    expect(tui.isOpen && tui.render().join("\n")).toContain(title);
  });
}

describe("declarative skills workflow", () => {
  it("adds through RPC without custom UI, preserving raw IDs and exact confirmation paths", async () => {
    const f = fixture();
    const rpc = createRpcHarness([
      select("[ ] Alpha"),
      select("Continue"),
      select("Project (Pi)"),
      select("Prepare review"),
      select("Apply changes"),
      select("Close without reload"),
    ]);
    expect(
      await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "add", repository: "a/b" }, env, f.guard, f.services),
    ).toBe(false);
    rpc.assertConsumed();
    expect(f.services.downloadBundles).toHaveBeenCalledWith(snapshot, ["remote-0"], expect.any(AbortSignal));
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(rpc.dialogs.some((dialog) => dialog.title.includes("Install /workspace/.pi/skills/alpha"))).toBe(true);
    expect(rpc.dialogs.some((dialog) => dialog.title.includes("Name conflict: Alpha"))).toBe(true);
  });
  it("the Add menu route uses the same repository discovery and selection screens", async () => {
    const f = fixture();
    const rpc = createRpcHarness([
      { kind: "input", response: "https://github.com/a/b" },
      select("Find skills"),
      select("Back"),
      select(undefined),
      { kind: "input", response: undefined },
    ]);
    const ctx = context(rpc.ui, "rpc");
    await showSkillsMenu(ctx, { kind: "add" }, env, f.guard, f.services);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    rpc.assertConsumed();
    expect(f.services.discoverRepository).toHaveBeenCalledWith("a/b", expect.any(AbortSignal));
    expect(f.apply).not.toHaveBeenCalled();
  });
  it.each(["remove", "move"] as const)(
    "%s identifies local paths, then offers explicit reload after application",
    async (kind) => {
      const f = fixture();
      const steps = [select("[ ] Alpha · Project (Pi)"), select("Continue")];
      if (kind === "move") steps.push(select("User (Pi)"), select("Prepare review"));
      steps.push(select("Apply changes"), select("Reload now"));
      const rpc = createRpcHarness(steps);
      expect(await showSkillsMenu(context(rpc.ui, "rpc"), { kind }, env, f.guard, f.services)).toBe(true);
      rpc.assertConsumed();
      expect(f.services.prepareOperation.mock.calls[0]?.[0]).toMatchObject({ kind, skills: [local] });
    },
  );
  it("cancelling selected entries before confirmation performs no mutations", async () => {
    const f = fixture();
    const rpc = createRpcHarness([select("[ ] Alpha · Project (Pi)"), select("Back")]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "remove" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.services.prepareOperation).not.toHaveBeenCalled();
  });
  it("shows source-retained partial results without claiming a move succeeded", async () => {
    const f = fixture();
    f.apply.mockResolvedValue([
      {
        status: "source-retained",
        source: local.path,
        destination: `${user.path}/alpha`,
        message: "Copied; source retained",
        changed: true,
      },
    ]);
    const rpc = createRpcHarness([
      select("[ ] Alpha · Project (Pi)"),
      select("Continue"),
      select("User (Pi)"),
      select("Prepare review"),
      select("Apply changes"),
      select("View results"),
      select("Back"),
      select("Close without reload"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "move" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(rpc.dialogs.some((dialog) => dialog.title.includes("Copied; source retained"))).toBe(true);
  });
  it("refuses an empty selection and allows a safe retry", async () => {
    const f = fixture();
    const rpc = createRpcHarness([select("Continue"), select("Back")]);
    const ctx = context(rpc.ui, "rpc");
    await showSkillsMenu(ctx, { kind: "remove" }, env, f.guard, f.services);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Select at least one skill", "error");
    expect(f.apply).not.toHaveBeenCalled();
    rpc.assertConsumed();
  });
  it("RPC exposes exact paths for same-name skills in one scope", async () => {
    const f = fixture();
    const second = { ...local, id: `${project.path}/second`, path: `${project.path}/second` };
    f.services.scanInventory.mockResolvedValue({ skills: [local, second], warnings: [] });
    const rpc = createRpcHarness([
      select(`[ ] Alpha · Project (Pi) · ${second.path}`),
      select("Continue"),
      select("Back"),
      select("Back"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "remove" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.services.prepareOperation.mock.calls[0]?.[0]).toMatchObject({ kind: "remove", skills: [second] });
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("custom Copy only never writes native settings", async () => {
    const f = fixture();
    const rpc = createRpcHarness([
      select("[ ] Alpha"),
      select("Continue"),
      select("Custom directory"),
      { kind: "input", response: "/custom/skills" },
      select("Copy only"),
      select("Prepare review"),
      select("Apply changes"),
      select("Close without reload"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "add", repository: "a/b" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.services.previewRegistration).toHaveBeenCalledWith("/custom/skills", "none", env, expect.any(Object));
    expect(f.services.applyRegistration).not.toHaveBeenCalled();
  });
});

describe("single-skill management actions", () => {
  const label = `Alpha · Not loaded · Project (Pi) · ${local.path}/SKILL.md`;
  it("opens actions instead of a SKILL.md detail page and returns without mutation", async () => {
    const f = fixture();
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(label),
      select("Back"),
      select("Back"),
      select("Close"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    const actions = rpc.dialogs.find((dialog) => dialog.title.startsWith("Alpha · Project (Pi)"));
    expect(actions?.options).toEqual([
      "Move…",
      "Remove…",
      "[-] Copy directory path (unavailable: Clipboard copy requires Pi TUI)",
      "[-] Model invocation (unavailable: Model invocation settings require a currently loaded Pi skill)",
      "Back",
    ]);
    expect(actions?.title).toContain(local.path);
    expect(rpc.dialogs.some((dialog) => dialog.title.includes("Exact instructions"))).toBe(false);
    expect(f.services.prepareOperation).not.toHaveBeenCalled();
    expect(f.services.copyToClipboard).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("opens management after a main-menu custom scan even after returning from a batch", async () => {
    const f = fixture();
    const rpc = createRpcHarness([
      select("Remove skills"),
      select("Back"),
      select("Scan custom directory"),
      { kind: "input", response: "/custom/scan" },
      select("Scan directory"),
      select(label),
      select("Back"),
      select("Back"),
      select(undefined),
      { kind: "input", response: undefined },
      select("Close"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(rpc.dialogs.some((dialog) => dialog.title.startsWith("Manage skills"))).toBe(true);
    expect(f.services.scanInventory).toHaveBeenCalledTimes(2);
    expect(f.services.prepareOperation).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("removes only the chosen path through the existing final confirmation", async () => {
    const f = fixture();
    const second = {
      ...local,
      id: `${project.path}/second`,
      path: `${project.path}/second`,
      directoryPath: `${project.path}/second`,
    };
    f.services.scanInventory.mockResolvedValue({ skills: [local, second], warnings: [] });
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(`Alpha · Not loaded · Project (Pi) · ${second.path}/SKILL.md`),
      select("Remove…"),
      select("Apply changes"),
      select("Close without reload"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.services.prepareOperation).toHaveBeenCalledWith({ kind: "remove", skills: [second] }, expect.any(Object));
    const request = f.services.prepareOperation.mock.calls[0][0];
    if (request.kind !== "remove") throw new Error("Expected removal");
    expect(request.skills[0]).toBe(second);
    expect(request.skills[0].id).toBe(second.id);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("moves one chosen skill without carrying a previous batch selection", async () => {
    const f = fixture();
    const second = {
      ...local,
      id: `${project.path}/beta`,
      path: `${project.path}/beta`,
      directoryPath: `${project.path}/beta`,
      name: "Beta",
    };
    f.services.scanInventory.mockResolvedValue({ skills: [local, second], warnings: [] });
    const rpc = createRpcHarness([
      select("Remove skills"),
      select("[ ] Alpha · Project (Pi)"),
      select("Back"),
      select("Manage skills"),
      select(`Beta · Not loaded · Project (Pi) · ${second.path}/SKILL.md`),
      select("Move…"),
      select("User (Pi)"),
      select("Prepare review"),
      select("Apply changes"),
      select("Close without reload"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.services.prepareOperation).toHaveBeenCalledWith(
      { kind: "move", target: user, skills: [second] },
      expect.any(Object),
    );
    const request = f.services.prepareOperation.mock.calls[0][0];
    if (request.kind !== "move") throw new Error("Expected move");
    expect(request.skills[0]).toBe(second);
    expect(request.skills[0].id).toBe(second.id);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });
  it("cancels single-skill removal at the review without applying it", async () => {
    const f = fixture();
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(label),
      select("Remove…"),
      select("Back"),
      select("Back"),
      select("Back"),
      select("Close"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.services.prepareOperation).toHaveBeenCalledTimes(1);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("keeps protected skills selectable but disables mutations and never copies from RPC", async () => {
    const f = fixture();
    const readOnlyReason = "Linked skill is read-only";
    f.services.scanInventory.mockResolvedValue({ skills: [{ ...local, readOnlyReason }], warnings: [] });
    const rpc = createRpcHarness([
      select("Manage skills"),
      select(label),
      select(`[-] Move… (unavailable: ${readOnlyReason})`),
      select(`[-] Remove… (unavailable: ${readOnlyReason})`),
      select("[-] Copy directory path (unavailable: Clipboard copy requires Pi TUI)"),
      select("[-] Model invocation (unavailable: Model invocation settings require a currently loaded Pi skill)"),
      select("Back"),
      select("Back"),
      select("Close"),
    ]);
    await showSkillsMenu(context(rpc.ui, "rpc"), { kind: "main" }, env, f.guard, f.services);
    rpc.assertConsumed();
    expect(f.services.prepareOperation).not.toHaveBeenCalled();
    expect(f.services.copyToClipboard).not.toHaveBeenCalled();
  });

  async function openActions(tui: ReturnType<typeof createTuiHarness>) {
    await waitTitle(tui, "Skills");
    tui.press("tui.select.confirm");
    await waitTitle(tui, "Manage skills");
    tui.press("tui.select.confirm");
    await waitTitle(tui, "Alpha · Project (Pi)");
  }
  function activateCopy(tui: ReturnType<typeof createTuiHarness>) {
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
  }
  it("copies the exact raw directory path, not display text or SKILL.md contents", async () => {
    const f = fixture();
    const raw = "/workspace/.pi/skills/alpha\u001b[31m\nraw";
    f.services.scanInventory.mockResolvedValue({ skills: [{ ...local, path: raw, directoryPath: raw }], warnings: [] });
    const tui = createTuiHarness();
    const ctx = context({ custom: tui.custom }, "tui");
    const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    await openActions(tui);
    activateCopy(tui);
    await vi.waitFor(() => expect(f.services.copyToClipboard).toHaveBeenCalledWith(raw));
    await waitTitle(tui, "Directory path sent to clipboard");
    expect(tui.render().join("\n")).not.toContain("\u001b[31m");
    tui.press("ctrl+c");
    await work;
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("copies the enclosing directory for a read-only standalone Markdown skill", async () => {
    const f = fixture();
    f.services.scanInventory.mockResolvedValue({
      skills: [
        {
          ...local,
          path: `${project.path}/standalone.md`,
          directoryPath: project.path,
          readOnlyReason: "Standalone Markdown skills are read-only",
        },
      ],
      warnings: [],
    });
    const tui = createTuiHarness();
    const work = showSkillsMenu(context({ custom: tui.custom }, "tui"), { kind: "main" }, env, f.guard, f.services);
    await openActions(tui);
    activateCopy(tui);
    await waitTitle(tui, "Directory path sent to clipboard");
    expect(f.services.copyToClipboard).toHaveBeenCalledWith(project.path);
    tui.press("ctrl+c");
    await work;
  });
  it("keeps clipboard failures retryable without executing a file mutation", async () => {
    const f = fixture();
    f.services.copyToClipboard.mockRejectedValueOnce(new Error("Clipboard unavailable\u001b[31m"));
    const tui = createTuiHarness();
    const ctx = context({ custom: tui.custom }, "tui");
    const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services);
    await openActions(tui);
    activateCopy(tui);
    await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith("Clipboard unavailable", "error"));
    await waitTitle(tui, "Alpha · Project (Pi)");
    tui.press("tui.select.confirm");
    await waitTitle(tui, "Directory path sent to clipboard");
    expect(f.services.copyToClipboard).toHaveBeenCalledTimes(2);
    tui.press("ctrl+c");
    await work;
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("returns to the previously selected skill using non-default navigation keys", async () => {
    const f = fixture();
    const second = {
      ...local,
      id: `${project.path}/beta`,
      path: `${project.path}/beta`,
      directoryPath: `${project.path}/beta`,
      name: "Beta",
    };
    f.services.scanInventory.mockResolvedValue({ skills: [local, second], warnings: [] });
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "ctrl+y",
      "tui.select.cancel": "ctrl+g",
      "tui.select.down": "ctrl+n",
    });
    const tui = createTuiHarness({ keybindings: keys });
    const work = showSkillsMenu(context({ custom: tui.custom }, "tui"), { kind: "main" }, env, f.guard, f.services);
    await waitTitle(tui, "Skills");
    tui.send("\x19");
    await waitTitle(tui, "Manage skills");
    tui.send("\x0e");
    tui.send("\x19");
    await waitTitle(tui, "Beta · Project (Pi)");
    tui.send("\x07");
    await waitTitle(tui, "Manage skills");
    const frame = tui.render().join("\n");
    expect(frame).toMatch(/→.*Beta/);
    tui.press("ctrl+c");
    await work;
  });
  it.each(["cancel", "dispose", "owner-abort"] as const)(
    "drains accepted clipboard work on %s and does not publish stale feedback",
    async (action) => {
      const f = fixture();
      let finish!: () => void;
      f.services.copyToClipboard.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const tui = createTuiHarness();
      const ctx = context({ custom: tui.custom }, "tui");
      let settled = false;
      const work = showSkillsMenu(ctx, { kind: "main" }, env, f.guard, f.services).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          if (action !== "owner-abort") throw error;
          return false;
        },
      );
      await openActions(tui);
      activateCopy(tui);
      await vi.waitFor(() => expect(f.services.copyToClipboard).toHaveBeenCalledTimes(1));
      if (action === "cancel") tui.press("ctrl+c");
      else if (action === "dispose") tui.dispose();
      else f.controller.abort();
      expect(settled).toBe(false);
      finish();
      if (action === "cancel") {
        await waitTitle(tui, "Alpha · Project (Pi)");
        expect(tui.render().join("\n")).not.toContain("Directory path sent to clipboard");
        tui.press("ctrl+c");
      }
      await work;
      expect(f.apply).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    },
  );
});

describe("Kit TUI rendering and interaction ownership", () => {
  it("keeps checked IDs through filtering and preview with non-default bindings", async () => {
    const f = fixture();
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.confirm": "ctrl+y",
      "tui.select.cancel": "ctrl+g",
      "tui.select.down": "ctrl+n",
      "tui.select.up": "ctrl+p",
    });
    const tui = createTuiHarness({ width: 90, rows: 24, keybindings: keys });
    const work = showSkillsMenu(
      context({ custom: tui.custom }, "tui"),
      { kind: "add", repository: "a/b" },
      env,
      f.guard,
      f.services,
    );
    await waitTitle(tui, "Add skills");
    tui.send("\x19");
    await tui.waitForPending();
    await waitTitle(tui, "Add skills");
    tui.type("Beta");
    expect(tui.render().join("\n")).not.toContain("Alpha description");
    for (let index = 0; index < 4; index++) tui.send("\x7f");
    expect(tui.render().join("\n")).toContain("[x]");
    for (let index = 0; index < 3; index++) tui.send("\x0e");
    tui.send("\x19");
    await waitTitle(tui, "Selected skill contents");
    tui.send("\x07");
    await waitTitle(tui, "Add skills");
    expect(tui.render().join("\n")).toContain("[x]");
    tui.press("ctrl+c");
    await work;
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("uses bounded standard frames during narrow resize", async () => {
    const f = fixture();
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const work = showSkillsMenu(context({ custom: tui.custom }, "tui"), { kind: "main" }, env, f.guard, f.services);
    await waitTitle(tui, "Skills");
    for (const width of [1, 12, 80])
      for (const rows of [1, 4, 8, 24]) {
        const frame = tui.resize({ width, rows });
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    tui.press("ctrl+c");
    await work;
  });
  it.each(["cancel", "dispose"] as const)("%s aborts and drains a pending discovery", async (action) => {
    const f = fixture();
    let aborted = false;
    f.services.discoverRepository.mockImplementation(async (_source, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      signal.throwIfAborted();
      return snapshot;
    });
    const tui = createTuiHarness();
    const work = showSkillsMenu(
      context({ custom: tui.custom }, "tui"),
      { kind: "add", repository: "a/b" },
      env,
      f.guard,
      f.services,
    );
    await vi.waitFor(() => expect(f.services.discoverRepository).toHaveBeenCalledTimes(1));
    if (action === "cancel") tui.press("ctrl+c");
    else tui.dispose();
    await work;
    expect(aborted).toBe(true);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("retains native input editing and bracketed paste behavior", async () => {
    const f = fixture();
    const tui = createTuiHarness();
    const work = showSkillsMenu(context({ custom: tui.custom }, "tui"), { kind: "add" }, env, f.guard, f.services);
    await waitTitle(tui, "GitHub repository");
    tui.type("a/x");
    tui.send("\x7f");
    tui.send("\x1b[200~b\x1b[201~");
    tui.press("tui.input.submit");
    await waitTitle(tui, "Add from GitHub");
    expect(tui.render().join("\n")).toContain("Repository: a/b");
    tui.press("ctrl+c");
    await work;
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("reports a source failure safely and does not open mutation screens", async () => {
    const f = fixture();
    f.services.discoverRepository.mockRejectedValue(new Error("Rate limited\x1b[31m"));
    const rpc = createRpcHarness([]);
    const ctx = context(rpc.ui, "rpc");
    await showSkillsMenu(ctx, { kind: "add", repository: "a/b" }, env, f.guard, f.services);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Rate limited", "error");
    expect(f.apply).not.toHaveBeenCalled();
    rpc.assertConsumed();
  });
});
