import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeMenuOptions, ScopeView } from "../menu.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(tmpdir(), "scope-lifecycle-"));
process.env.PI_CODING_AGENT_DIR = join(root, "initial-agent");
const sdk = await import("@earendil-works/pi-coding-agent");
const { createScopeExtension } = await import("../scope-extension.ts");
const { resolveScopeTarget } = await import("../paths.ts");
const { createSnapshot, STATE_TYPE } = await import("../state.ts");
const { ANCHOR_TYPE, NOTICE_TYPE } = await import("../contracts.ts");

type Hook = (event: Record<string, unknown>, ctx: ExtensionCommandContext) => unknown | Promise<unknown>;
const pendingFixtures: Array<{ close(): Promise<void>; root: string }> = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function harness(start = true) {
  const directory = await mkdtemp(join(root, "fixture-"));
  const cwd = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(cwd);
  const allowed = join(cwd, "allowed.txt");
  const other = join(cwd, "other.txt");
  await writeFile(allowed, "original");
  await writeFile(other, "other");
  const target = await resolveScopeTarget(pathToFileURL(allowed).href, cwd, "existing");
  const manager = sdk.SessionManager.inMemory(cwd);
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, RegisteredCommand>();
  const controls = {
    busy: false,
    pending: false,
    signal: undefined as AbortSignal | undefined,
    mode: "tui",
    publication: "immediate",
  };
  const surface = {
    active: ["read", "write", "edit", "bash"],
    mode: "on" as "on" | "only",
    tools: ["read", "write", "edit", "bash", "ls", "find", "grep", "codemode"].map(
      (name): ToolInfo => ({
        name,
        description: name,
        parameters: { type: "object" } as ToolInfo["parameters"],
        exposure: "direct",
        sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
      }),
    ),
  };
  const queued: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
  const ui = { notify: vi.fn(), setWidget: vi.fn() };
  const context = {
    cwd,
    sessionManager: manager,
    ui,
    get mode() {
      return controls.mode;
    },
    get hasUI() {
      return controls.mode === "tui" || controls.mode === "rpc";
    },
    get signal() {
      return controls.signal;
    },
    isIdle: () => !controls.busy,
    hasPendingMessages: () => controls.pending,
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext;
  let action = async (_options: ScopeMenuOptions): Promise<void> => {};
  const api = {
    on: vi.fn((name: string, handler: Hook) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => {};
    }),
    registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    }),
    appendEntry: vi.fn((type: string, data: unknown) => {
      manager.appendCustomEntry(type, data);
    }),
    sendMessage: vi.fn((message: { customType: string; content: string; display: boolean; details?: unknown }) => {
      if (controls.publication === "defer") queued.push(message);
      else if (controls.publication !== "missing")
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    }),
    getAllTools: vi.fn(() => surface.tools),
    getActiveTools: vi.fn(() => [...surface.active]),
    getSettings: vi.fn(() => ({ codemode: { mode: surface.mode } })),
    setActiveTools: vi.fn(),
    getThinkingLevel: vi.fn(() => {
      throw new Error("Factory action call");
    }),
  };
  createScopeExtension(async (_ctx, options) => action(options))(api as unknown as ExtensionAPI);
  async function emit(name: string, fields: Record<string, unknown> = {}, ctx = context) {
    let result: unknown;
    for (const handler of hooks.get(name) ?? []) result = await handler({ type: name, ...fields }, ctx);
    return result;
  }
  const scope = commands.get("scope");
  if (!scope) throw new Error("Scope command missing");
  async function menu(next: (options: ScopeMenuOptions) => Promise<void>) {
    action = next;
    return scope?.handler("", context);
  }
  const fixture = {
    root: directory,
    cwd,
    agentDir,
    allowed,
    other,
    target,
    manager,
    api,
    controls,
    surface,
    context,
    ui,
    emit,
    menu,
    scope,
    async close() {
      await emit("session_shutdown", { reason: "quit" });
    },
    async apply(targets = [target]) {
      await menu((options) => options.apply(targets));
    },
    async off() {
      await scope.handler("off", context);
    },
    async view(): Promise<ScopeView> {
      let result: ScopeView | undefined;
      await menu(async (options) => {
        result = options.getView();
      });
      if (!result) throw new Error("Scope view missing");
      return result;
    },
    async gate(name: string, input: Record<string, unknown>, parentToolCallId?: string) {
      return (await emit("tool_call", {
        toolName: name,
        input,
        toolCallId: "unit",
        ...(parentToolCallId ? { parentToolCallId } : {}),
      })) as { block?: boolean; reason?: string } | undefined;
    },
    async modelContext(messages = manager.buildSessionContext().messages) {
      const result = (await emit("context_with_system", { messages })) as { messages: AgentMessage[] } | undefined;
      return result?.messages ?? messages;
    },
    flushNotices() {
      for (const message of queued.splice(0))
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
  pendingFixtures.push(fixture);
  if (start) await emit("session_start", { reason: "startup" });
  return fixture;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of pendingFixtures.splice(0).reverse()) {
    await fixture.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

describe("scope lifecycle and command ownership", () => {
  it("does not query actions or create settings during factory load; fails closed before start", async () => {
    const h = await harness(false);
    expect(h.api.getAllTools).not.toHaveBeenCalled();
    expect(h.api.getSettings).not.toHaveBeenCalled();
    expect(h.api.getThinkingLevel).not.toHaveBeenCalled();
    expect((await h.gate("write", { path: h.allowed }))?.block).toBe(true);
    expect(await h.gate("read", { path: h.other })).toBeUndefined();
    await h.emit("session_start", { reason: "startup" });
    expect(await h.gate("bash", { command: "echo normal" })).toBeUndefined();
    await expect(readFile(join(h.agentDir, "pi-scope.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("registers only exact routes and completions and rejects all non-TUI command modes", async () => {
    const h = await harness();
    expect(h.api.registerCommand.mock.calls.map(([name]) => name)).toEqual(["scope"]);
    expect(h.scope.getArgumentCompletions?.("o")).toEqual([
      { value: "off", label: "off", description: "End the editing restriction" },
    ]);
    expect(h.scope.getArgumentCompletions?.("off x")).toEqual([]);
    for (const args of ["help", "off extra", "settings"])
      await expect(h.scope.handler(args, h.context)).rejects.toThrow("Usage");
    for (const mode of ["rpc", "print", "json"]) {
      h.controls.mode = mode;
      await expect(h.scope.handler("", h.context)).rejects.toThrow("TUI");
      await expect(h.scope.handler("off", h.context)).rejects.toThrow("TUI");
    }
    expect(h.api.appendEntry).not.toHaveBeenCalled();
  });
  it("applies once, leaves reads available, blocks direct/nested bypasses, and releases only explicitly", async () => {
    const h = await harness();
    const definitions = JSON.stringify(h.surface.tools);
    await h.apply();
    expect((await h.view()).state).toBe("active");
    expect(await h.gate("write", { path: h.allowed })).toBeUndefined();
    expect(await h.gate("edit", { path: h.allowed }, "parent")).toBeUndefined();
    expect((await h.gate("write", { path: h.other }, "parent"))?.block).toBe(true);
    expect((await h.gate("bash", { command: `touch ${h.other}` }))?.block).toBe(true);
    expect((await h.gate("opaque", {}))?.block).toBe(true);
    expect(await h.gate("read", { path: h.other })).toBeUndefined();
    for (const event of ["agent_end", "agent_settled"]) await h.emit(event);
    await h.menu(async () => {});
    expect((await h.gate("write", { path: h.other }))?.block).toBe(true);
    const stateEntries = h.manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE);
    await h.apply();
    expect(h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)).toEqual(
      stateEntries,
    );
    expect(JSON.stringify(h.surface.tools)).toBe(definitions);
    expect(h.api.setActiveTools).not.toHaveBeenCalled();
    await h.off();
    expect(await h.gate("write", { path: h.other })).toBeUndefined();
    expect((await h.view()).state).toBe("inactive");
    expect(h.ui.setWidget).toHaveBeenLastCalledWith("scope", undefined);
  });
  it.each(["removed", "retargeted"] as const)(
    "repairs a %s selected alias by committing the real path, not a canonical-only no-op",
    async (change) => {
      const h = await harness();
      const alias = join(h.cwd, "alias.txt");
      await fs.symlink(h.allowed, alias);
      const target = await resolveScopeTarget(pathToFileURL(alias).href, h.cwd, "existing");
      await h.apply([target]);
      expect(await h.gate("write", { path: h.allowed })).toBeUndefined();
      await fs.unlink(alias);
      if (change === "retargeted") await fs.symlink(h.other, alias);
      expect((await h.gate("write", { path: h.allowed }))?.block).toBe(true);
      await h.apply();
      expect((await h.view()).targets[0].path).toBe(h.allowed);
      expect(
        h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE),
      ).toHaveLength(2);
      expect(await h.gate("write", { path: h.allowed })).toBeUndefined();
    },
  );
  it("rejects empty and oversized results without changing the live scope", async () => {
    const h = await harness();
    await h.apply();
    await expect(h.menu((options) => options.apply([]))).rejects.toThrow("Select between");
    expect((await h.view()).targets).toEqual([{ path: h.target.path, canonical: h.target.canonical }]);
    await expect(h.menu((options) => options.apply(Array.from({ length: 101 }, () => h.target)))).rejects.toThrow(
      "Select between",
    );
    expect((await h.view()).state).toBe("active");
  });
  it("reserves a new target without creating directories and rejects appearance during review", async () => {
    const h = await harness();
    const path = join(h.cwd, "new", "one.txt");
    const target = await resolveScopeTarget(pathToFileURL(path).href, h.cwd, "new");
    await h.menu((options) => options.apply([target], true));
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await h.gate("write", { path })).toBeUndefined();
    const otherNew = join(h.cwd, "appeared.txt");
    const appeared = await resolveScopeTarget(pathToFileURL(otherNew).href, h.cwd, "new");
    await writeFile(otherNew, "external file");
    await expect(h.menu((options) => options.apply([appeared], true))).rejects.toThrow("already exists");
    expect((await h.view()).targets[0].path).toBe(path);
    expect(await readFile(otherNew, "utf8")).toBe("external file");
  });
  it("does not accept disposed menu callbacks or overlapping commands", async () => {
    const h = await harness();
    let stale: ScopeMenuOptions | undefined;
    await h.menu(async (options) => {
      stale = options;
    });
    expect(stale?.isCurrent()).toBe(false);
    await expect(stale?.apply([h.target])).rejects.toMatchObject({ name: "AbortError" });
    const opened = deferred();
    const closed = deferred();
    const running = h.menu(async () => {
      opened.resolve();
      await closed.promise;
    });
    await opened.promise;
    await expect(h.scope.handler("off", h.context)).rejects.toThrow("already open");
    closed.resolve();
    await running;
    expect((await h.view()).state).toBe("inactive");
  });
  it("checks idle/pending state again after filesystem awaits", async () => {
    const h = await harness();
    const entered = deferred();
    const released = deferred();
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await released.promise;
      return original(...args);
    });
    const running = h.menu((options) => options.apply([h.target]));
    await entered.promise;
    h.controls.pending = true;
    released.resolve();
    await expect(running).rejects.toThrow("pending messages");
    h.controls.pending = false;
    expect((await h.view()).state).toBe("inactive");
    h.controls.busy = true;
    await expect(h.off()).rejects.toThrow("Stop the current run");
    h.controls.busy = false;
  });
  it("aborts final validation on user cancellation and leaves the previous scope intact", async () => {
    const h = await harness();
    const entered = deferred();
    const released = deferred();
    const controller = new AbortController();
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await released.promise;
      return original(...args);
    });
    const running = h.menu((options) => options.apply([h.target], false, controller.signal));
    await entered.promise;
    controller.abort(new DOMException("User cancelled", "AbortError"));
    released.resolve();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect((await h.view()).state).toBe("inactive");
  });
  it("drains an in-flight tool check on shutdown and cannot allow it from a stale context", async () => {
    const h = await harness();
    await h.apply();
    const entered = deferred();
    const released = deferred();
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await released.promise;
      return original(...args);
    });
    const call = h.gate("write", { path: h.allowed });
    await entered.promise;
    let finished = false;
    const shutdown = h.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    released.resolve();
    expect((await call)?.block).toBe(true);
    await shutdown;
    expect((await h.gate("write", { path: h.allowed }))?.block).toBe(true);
  });
  it("restores active branch state on tree/reload, not abandoned snapshots, and fails closed on bad state", async () => {
    const h = await harness();
    await h.apply();
    const activeId = h.manager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)?.id;
    if (!activeId) throw new Error("Active entry missing");
    await h.off();
    h.manager.branch(activeId);
    await h.emit("session_tree");
    expect((await h.gate("write", { path: h.other }))?.block).toBe(true);
    await h.emit("session_start", { reason: "reload" });
    expect((await h.view()).state).toBe("active");
    h.manager.appendCustomEntry(STATE_TYPE, { version: 9 });
    await h.emit("session_tree");
    expect((await h.view()).state).toBe("blocked");
    expect((await h.gate("write", { path: h.allowed }))?.block).toBe(true);
    expect(await h.gate("read", { path: h.other })).toBeUndefined();
    await h.off();
    expect((await h.view()).state).toBe("inactive");
  });
  it("uses sessionManager identity rather than shared headless UI identity", async () => {
    const h = await harness();
    await h.apply();
    const otherManager = sdk.SessionManager.inMemory(h.cwd);
    const otherContext = {
      ...h.context,
      mode: "json",
      hasUI: false,
      sessionManager: otherManager,
    } as ExtensionCommandContext;
    await h.emit("session_start", { reason: "new" }, otherContext);
    expect(await h.emit("tool_call", { toolName: "write", input: { path: h.other } }, otherContext)).toBeUndefined();
    expect((await h.gate("write", { path: h.other }))?.block).toBe(true);
    await h.emit("session_shutdown", { reason: "quit" }, otherContext);
  });
  it("retains the restriction when settings are malformed or publication fails", async () => {
    const h = await harness();
    await h.apply();
    await mkdir(h.agentDir, { recursive: true });
    const settingsPath = join(h.agentDir, "pi-scope.json");
    await writeFile(settingsPath, "invalid JSON");
    await expect(h.menu((options) => options.saveShowHiddenFiles(true))).rejects.toThrow("JSON");
    expect(await readFile(settingsPath, "utf8")).toBe("invalid JSON");
    expect((await h.view()).state).toBe("active");
    h.api.appendEntry.mockImplementationOnce((type, data) => {
      h.manager.appendCustomEntry(type, data);
      throw new Error("Disk failed after in-memory append");
    });
    await expect(h.off()).rejects.toThrow("Disk failed");
    expect((await h.view()).state).toBe("blocked");
    expect((await h.gate("write", { path: h.other }))?.block).toBe(true);
    await h.off();
    expect((await h.view()).state).toBe("inactive");
  });
  it("restores missing/deferred notices once at a fixed boundary and keeps metadata/tools stable", async () => {
    const h = await harness();
    h.controls.publication = "defer";
    h.manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
    await h.apply();
    const first = await h.modelContext();
    expect(first.filter((message) => message.role === "custom" && message.customType === NOTICE_TYPE)).toHaveLength(1);
    expect(
      h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ANCHOR_TYPE),
    ).toHaveLength(1);
    h.manager.appendMessage({ role: "user", content: "newer output", timestamp: 100 });
    h.flushNotices();
    const next = await h.modelContext();
    const serialized = (messages: AgentMessage[]) =>
      sdk.convertToLlm(messages).map(({ timestamp: _timestamp, ...message }) => message);
    expect(serialized(next).slice(0, first.length)).toEqual(serialized(first));
    expect(next.filter((message) => message.role === "custom" && message.customType === NOTICE_TYPE)).toHaveLength(1);
    await h.modelContext();
    expect(
      h.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === ANCHOR_TYPE),
    ).toHaveLength(1);
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.setActiveTools).not.toHaveBeenCalled();
  });
  it("blocks edits if context-anchor persistence fails, without releasing on abort", async () => {
    const h = await harness();
    h.controls.publication = "missing";
    await h.apply();
    const aborted = new AbortController();
    aborted.abort();
    h.controls.signal = aborted.signal;
    await h.modelContext();
    h.controls.signal = undefined;
    expect((await h.view()).state).toBe("active");
    h.api.appendEntry.mockImplementationOnce(() => {
      throw new Error("Anchor failed");
    });
    await expect(h.modelContext()).rejects.toThrow("Anchor failed");
    expect((await h.gate("write", { path: h.allowed }))?.block).toBe(true);
    await h.off();
    expect((await h.view()).state).toBe("inactive");
  });
  it("rejects a router-only restored or changed loadout clearly instead of stranding editing", async () => {
    const h = await harness(false);
    h.manager.appendCustomEntry(STATE_TYPE, createSnapshot(h.cwd, [h.target]));
    h.surface.active.push("codemode");
    h.surface.mode = "only";
    await h.emit("session_start", { reason: "resume" });
    expect((await h.view()).state).toBe("blocked");
    expect((await h.view()).error).toContain("codemode.mode=only");
    expect((await h.gate("write", { path: h.allowed }))?.block).toBe(true);
    await h.off();
    h.surface.mode = "on";
    await h.apply();
    h.surface.mode = "only";
    await h.modelContext();
    expect((await h.view()).state).toBe("blocked");
    expect((await h.view()).targets).toHaveLength(1);
    expect((await h.view()).error).toContain("codemode.mode=only");
  });
  it("keeps widget rows within widths and escapes untrusted paths", async () => {
    const h = await harness();
    const untrusted = join(h.cwd, "\u001b[31mfile\n\u202e.txt");
    await writeFile(untrusted, "content");
    const target = await resolveScopeTarget(pathToFileURL(untrusted).href, h.cwd, "existing");
    await h.apply([target, h.target]);
    const factory = h.ui.setWidget.mock.calls.find(
      ([key, component]) => key === "scope" && typeof component === "function",
    )?.[1] as ((tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void }) | undefined;
    if (!factory) throw new Error("Widget factory missing");
    const fg = vi.fn((_role: string, text: string) => text);
    const component = factory({}, { fg });
    for (const width of [0, 1, 12, 80])
      for (const row of component.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    const rendered = component.render(400).join("\n");
    expect(rendered).not.toContain("\u001b[31m");
    expect(rendered).toContain("\\u001b");
    expect(rendered).toContain("\\u202e");
    component.invalidate();
    expect(fg.mock.calls.some(([role]) => role === "borderMuted")).toBe(true);
  });
});
