import { resolve } from "node:path";
import type { ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import type { createTuiHarness, RpcHarnessStep } from "@narumitw/pi-tui-kit/testing";
import { expect, vi } from "vitest";
import type { InvocationSnapshot } from "../invocation.ts";
import { type createSkillsMenu, defaultServices, type Services } from "../menu.ts";
import type { Environment, Guard, LocalSkill, Location } from "../types.ts";

export const env: Environment = {
  cwd: "/workspace",
  agentDir: "/agent",
  homeDir: "/home",
  isProjectTrusted: () => true,
};
export const project: Location = {
  id: "project-pi",
  label: "Project (Pi)",
  path: "/workspace/.pi/skills",
  scope: "project",
};
export const local: LocalSkill = {
  id: "/workspace/.pi/skills/scanned",
  path: "/workspace/.pi/skills/scanned",
  directoryPath: "/workspace/.pi/skills/scanned",
  name: "Scanned only",
  description: "Not loaded by Pi",
  location: project,
  content: "Scanned instructions",
  fingerprint: "before-save",
  warnings: [],
};
export function skill(name = "Alpha", filePath = "/package/alpha/SKILL.md", manual = false): Skill {
  return {
    name,
    description: `${name} instructions`,
    filePath,
    baseDir: filePath.slice(0, filePath.lastIndexOf("/")),
    disableModelInvocation: manual,
    sourceInfo: { path: filePath, source: "npm:loaded-skills", scope: "user", origin: "package" },
  };
}
export function label(loaded: Skill) {
  const scope =
    loaded.sourceInfo.scope === "user" ? "User" : loaded.sourceInfo.scope === "project" ? "Project" : "Unknown";
  return `${loaded.name} · ${loaded.disableModelInvocation ? "Manual only" : "Automatic"} · ${scope} · ${loaded.filePath}`;
}
export function select(response: string | undefined): RpcHarnessStep {
  return { kind: "select", response };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function fixture(loaded: Skill[] = [skill()]) {
  const controller = new AbortController();
  const guard: Guard = {
    signal: controller.signal,
    check: () => controller.signal.throwIfAborted(),
    isProjectTrusted: () => true,
  };
  const saved = new Map<string, InvocationSnapshot>();
  const services = {
    ...defaultServices,
    loadLocations: vi.fn<Services["loadLocations"]>(async () => ({ locations: [project], warnings: [] })),
    scanInventory: vi.fn<Services["scanInventory"]>(async () => ({ skills: [local], warnings: [] })),
    readInvocation: vi.fn<Services["readInvocation"]>(
      async (entry) =>
        saved.get(entry.filePath) ?? {
          filePath: entry.filePath,
          canonicalPath: `/real-target/${entry.name}/SKILL.md`,
          enabled: !entry.disableModelInvocation,
        },
    ),
    updateInvocation: vi.fn<Services["updateInvocation"]>(async (snapshot, enabled) => {
      const next = { ...snapshot, enabled };
      saved.set(next.filePath, next);
      return { snapshot: next, changed: snapshot.enabled !== enabled };
    }),
    prepareOperation: vi.fn<Services["prepareOperation"]>(),
    copyToClipboard: vi.fn<Services["copyToClipboard"]>(),
  };
  function context(ui: object, mode: "tui" | "rpc") {
    return {
      cwd: env.cwd,
      mode,
      hasUI: true,
      ui: { ...ui, notify: vi.fn() },
      sessionManager: {},
      reload: vi.fn(),
      getSystemPromptOptions: vi.fn(() => ({ skills: loaded })),
      isProjectTrusted: () => true,
    } as unknown as ExtensionCommandContext;
  }
  return { controller, guard, services, context, loaded, saved };
}
type Tui = ReturnType<typeof createTuiHarness>;
export async function waitFrame(tui: Tui, text: string | RegExp) {
  await vi.waitFor(() => {
    expect(tui.isOpen).toBe(true);
    expect(tui.render().join("\n")).toMatch(text);
  });
}
export async function openManage(tui: Tui, confirm = "\r") {
  await waitFrame(tui, "Workspace:");
  tui.send(confirm);
  await waitFrame(tui, "Select a skill to manage it.");
}
export async function openInvocation(tui: Tui, confirm = "\r") {
  await openManage(tui, confirm);
  tui.send(confirm);
  await waitFrame(tui, /→.*Model invocation/);
}
export function stateFixture(f: ReturnType<typeof fixture>) {
  const state: Parameters<typeof createSkillsMenu>[0] = {
    mode: "remove",
    source: "",
    selected: new Set([local.id]),
    locations: [project],
    inventory: { skills: [local], warnings: [] },
    warnings: [],
    registrationScope: "none",
    confirmed: false,
    afterScan: "manage",
    loadedSkills: f.loaded.map((entry) => ({ ...entry, sourceInfo: { ...entry.sourceInfo } })),
    managedId: resolve(f.loaded[0].filePath),
    invocation: { filePath: f.loaded[0].filePath, canonicalPath: "/actual/linked/SKILL.md", enabled: true },
    invocationChanged: false,
    invocationValues: new Map(),
    invocationReviewed: true,
    reload: false,
    batch: { kind: "remove", summary: ["Old fingerprint"], apply: vi.fn() },
  };
  return state;
}
