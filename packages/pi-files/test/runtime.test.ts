import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayFilePath } from "../src/scope/display.js";
import {
  assistant,
  callTool,
  cleanupSmokeRoot,
  createFixture,
  createNativeSession,
  disposeNativeSession,
  entrypoint,
  resultText,
  sdk,
} from "./smoke-fixture.js";

const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
// This harness tests components; native placement and ownership use the real host in ui.test.ts.
function componentCustom(tui: ReturnType<typeof createTuiHarness>): ExtensionUIContext["custom"] {
  return (factory) => tui.custom(factory);
}
const sessions = new Set<AgentSession>();
async function open(...args: Parameters<typeof createNativeSession>) {
  const result = await createNativeSession(...args);
  sessions.add(result.session);
  return result;
}
beforeEach(() => vi.unstubAllEnvs());
afterEach(async () => {
  try {
    const outcomes = await Promise.allSettled([...sessions].map(disposeNativeSession));
    sessions.clear();
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  } finally {
    vi.unstubAllEnvs();
  }
});
afterAll(cleanupSmokeRoot);

function loadout(session: AgentSession) {
  // Compare serialized provider-visible fields, not live schema references or wrappers.
  return JSON.stringify({
    prompt: session.systemPrompt,
    active: session.getActiveToolNames(),
    tools: session.agent.state.tools.map(({ name, description, parameters, constrainedSampling }) => ({
      name,
      description,
      parameters,
      constrainedSampling,
    })),
  });
}

describe("native Jiti runtime", () => {
  it("loads the package entrypoint with /edit-scope and its compatibility alias, without replacement tools", async () => {
    const fixture = createFixture();
    const { session, loader, errors } = await open(fixture);
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    expect(realpathSync(extension.path)).toBe(realpathSync(entrypoint));
    expect([...extension.commands.keys()]).toEqual(expect.arrayContaining(["edit-scope", "scope"]));
    expect([...extension.tools.keys()]).toEqual([]);
    expect([...extension.flags.keys()]).toEqual([]);
    expect([...extension.shortcuts.keys()]).toEqual(["ctrl+shift+x"]);
    expect(extension.handlers.has("context")).toBe(false);
    expect(extension.handlers.has("context_with_system")).toBe(true);
    for (const name of ["edit-scope", "scope"]) {
      const command = extension.commands.get(name);
      expect(command?.getArgumentCompletions?.("o")).toEqual([
        { value: "off", label: "off", description: "End the editing restriction" },
      ]);
      expect(command?.getArgumentCompletions?.("off ")).toEqual([]);
    }
    expect(session.getAllTools().find(({ name }) => name === "write")?.sourceInfo).toMatchObject({
      path: "builtin:write",
      source: "builtin",
    });
    expect(errors).toEqual([]);
  });

  it.each(
    (["rpc", "print", "json"] as const).flatMap((mode) => ["edit-scope", "scope"].map((name) => ({ mode, name }))),
  )("rejects /$name observably in $mode mode without releasing scope", async ({ mode, name }) => {
    const fixture = createFixture();
    const { session, errors } = await open(fixture, { mode });
    for (const args of ["", " off", " status", " off trailing"]) {
      const offset = errors.length;
      await session.prompt(`/${name}${args}`);
      expect(errors.slice(offset)).toEqual([
        expect.objectContaining({
          extensionPath: `command:${name}`,
          event: "command",
          error: args === "" || args === " off" ? `/${name} requires Pi TUI mode` : `Usage: /${name} or /${name} off`,
        }),
      ]);
    }
    expect((await callTool(session, "write", { path: fixture.outside, content: "not allowed" })).isError).toBe(true);
    expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "scope-state"),
    ).toHaveLength(1);
  });

  it("allows stock write/edit/read and reserves a new path until its first write", async () => {
    const fixture = createFixture();
    const { session, errors } = await open(fixture);
    const initial = loadout(session);
    expect(existsSync(fixture.reserved)).toBe(false);
    expect((await callTool(session, "write", { path: "./allowed.txt", content: "allowed updated\n" })).isError).toBe(
      false,
    );
    expect(
      (
        await callTool(session, "edit", {
          path: fixture.allowed,
          edits: [{ oldText: "allowed updated", newText: "allowed edited" }],
        })
      ).isError,
    ).toBe(false);
    expect(readFileSync(fixture.allowed, "utf8")).toBe("allowed edited\n");
    const read = await callTool(session, "read", { path: fixture.outside });
    expect(read.isError).toBe(false);
    expect(resultText(read)).toContain("outside original");
    expect((await callTool(session, "ls", { path: fixture.cwd })).isError).toBe(false);
    expect(
      (await callTool(session, "write", { path: fixture.reserved, content: "created by stock write\n" })).isError,
    ).toBe(false);
    expect(readFileSync(fixture.reserved, "utf8")).toBe("created by stock write\n");
    expect(loadout(session)).toEqual(initial);
    expect(errors).toEqual([]);
  });

  it("blocks unselected mutation, shell, and opaque tools before side effects", async () => {
    const fixture = createFixture();
    let opaqueCalls = 0;
    const opaque: ToolDefinition = {
      name: "opaque",
      label: "Opaque smoke fixture",
      description: "Untrusted model-callable smoke fixture",
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      async execute() {
        opaqueCalls += 1;
        return { content: [{ type: "text", text: "unexpected" }], details: undefined };
      },
    };
    const { session } = await open(fixture, { customTools: [opaque] });
    const initial = loadout(session);
    for (const [name, args] of [
      ["write", { path: fixture.outside, content: "blocked" }],
      ["edit", { path: fixture.outside, edits: [{ oldText: "outside", newText: "blocked" }] }],
      ["write", { path: join(fixture.cwd, "unselected-parent", "new.txt"), content: "blocked" }],
      ["bash", { command: `printf bypass > '${fixture.shellMarker}'` }],
      ["opaque", {}],
    ] as const) {
      const outcome = await callTool(session, name, args);
      expect(outcome.isError, `${name}: ${resultText(outcome)}`).toBe(true);
      expect(resultText(outcome)).toMatch(/Scope|scope/);
    }
    expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
    expect(existsSync(join(fixture.cwd, "unselected-parent"))).toBe(false);
    expect(existsSync(fixture.shellMarker)).toBe(false);
    expect(opaqueCalls).toBe(0);
    expect(loadout(session)).toEqual(initial);
  });

  it.each(["on", "only"] as const)("blocks native codemode in %s mode before any script executes", async (codemode) => {
    const fixture = createFixture();
    const { session, errors } = await open(fixture, { codemode });
    expect(session.getAllTools().find(({ name }) => name === "codemode")?.sourceInfo).toMatchObject({
      path: "builtin:codemode",
      source: "builtin",
    });
    const initial = loadout(session);
    const outcome = await callTool(session, "codemode", {
      code: `await tools.write({path:${JSON.stringify(fixture.outside)},content:"codemode bypass"});`,
    });
    expect(outcome.isError).toBe(true);
    expect(resultText(outcome)).toContain(codemode === "only" ? "codemode.mode=only" : "blocked while Scope is active");
    expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
    expect(loadout(session)).toEqual(initial);
    expect(errors).toEqual([]);
  });

  it("honors native cancellation without mutating an allowed target", async () => {
    const fixture = createFixture();
    const { session } = await open(fixture);
    const controller = new AbortController();
    controller.abort();
    expect(
      (await callTool(session, "write", { path: fixture.allowed, content: "cancelled" }, controller.signal)).isError,
    ).toBe(true);
    expect(readFileSync(fixture.allowed, "utf8")).toBe("allowed original\n");
  });

  it("rechecks a retargeted symlink and hard-link aliases in the native mutation path", async () => {
    const fixture = createFixture();
    const alias = join(fixture.cwd, "selected-link.txt");
    symlinkSync(fixture.allowed, alias);
    fixture.manager.appendCustomEntry("scope-state", {
      ...fixture.snapshot,
      targets: [{ path: alias, canonical: fixture.allowed }],
    });
    const { session } = await open(fixture);
    expect((await callTool(session, "write", { path: alias, content: "selected link\n" })).isError).toBe(false);
    unlinkSync(alias);
    symlinkSync(fixture.outside, alias);
    const retargeted = await callTool(session, "write", { path: alias, content: "bypass" });
    expect(retargeted.isError).toBe(true);
    expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
    linkSync(fixture.allowed, join(fixture.cwd, "hard-alias.txt"));
    expect((await callTool(session, "write", { path: fixture.allowed, content: "bypass" })).isError).toBe(true);
    expect(readFileSync(fixture.allowed, "utf8")).toBe("selected link\n");
  });

  it("keeps invalid restored state fail-closed while stock readers remain available", async () => {
    const fixture = createFixture();
    fixture.manager.appendCustomEntry("scope-state", { version: 999, cwd: fixture.cwd, targets: null });
    const { session } = await open(fixture);
    expect((await callTool(session, "read", { path: fixture.outside })).isError).toBe(false);
    const outcome = await callTool(session, "write", { path: fixture.allowed, content: "bypass" });
    expect(outcome.isError).toBe(true);
    expect(resultText(outcome)).toMatch(/unsupported|invalid/i);
    expect(readFileSync(fixture.allowed, "utf8")).toBe("allowed original\n");
  });

  it("does not trust an SDK tool replacement merely because it is named write", async () => {
    const fixture = createFixture();
    let replacements = 0;
    const replacement: ToolDefinition = {
      name: "write",
      label: "SDK replacement fixture",
      description: "Not the stock native write implementation",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        replacements += 1;
        return { content: [{ type: "text", text: "unexpected" }], details: undefined };
      },
    };
    const { session } = await open(fixture, { customTools: [replacement] });
    expect(session.getAllTools().find(({ name }) => name === "write")?.sourceInfo.source).toBe("sdk");
    expect((await callTool(session, "write", { path: fixture.allowed, content: "bypass" })).isError).toBe(true);
    expect(replacements).toBe(0);
    expect(readFileSync(fixture.allowed, "utf8")).toBe("allowed original\n");
  });

  it("guards nested ctx.executeTool without admitting the host parent to model calls", async () => {
    const fixture = createFixture();
    let parentCalls = 0;
    const parent: ToolDefinition = {
      name: "host_parent",
      label: "Trusted host fixture",
      description: "Only the test host invokes this wrapper directly",
      parameters: Type.Object({ name: Type.String(), args: Type.Unknown() }),
      async execute(_id, args, signal, _update, ctx) {
        parentCalls += 1;
        const params = args as { name: string; args: unknown };
        const nested = await ctx.executeTool(params.name, params.args, { signal });
        return { ...nested.result, isError: nested.isError };
      },
    };
    fixture.manager.appendMessage(
      assistant([{ type: "toolCall", id: "trusted-host", name: parent.name, arguments: {} }]),
    );
    const { session, errors } = await open(fixture, { customTools: [parent] });
    expect(
      (await callTool(session, parent.name, { name: "write", args: { path: fixture.allowed, content: "not run" } }))
        .isError,
    ).toBe(true);
    expect(parentCalls).toBe(0);

    const events: AgentSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    const wrapper = session.agent.state.tools.find(({ name }) => name === parent.name);
    expect(wrapper).toBeDefined();
    // Deliberate trusted-host invocation bypasses only the parent guard. Production has no
    // parent allowlist. Each ctx.executeTool child still runs Pi's native nested pipeline.
    const invoke = (name: string, args: unknown) => wrapper?.execute("trusted-host", { name, args }, undefined);
    try {
      expect((await invoke("write", { path: fixture.allowed, content: "nested write\n" }))?.isError).toBe(false);
      expect(
        (
          await invoke("edit", {
            path: fixture.allowed,
            edits: [{ oldText: "nested write", newText: "nested edit" }],
          })
        )?.isError,
      ).toBe(false);
      expect((await invoke("read", { path: fixture.outside }))?.isError).toBe(false);
      expect((await invoke("write", { path: fixture.outside, content: "bypass" }))?.isError).toBe(true);
      expect(
        (
          await invoke("edit", {
            path: fixture.outside,
            edits: [{ oldText: "outside", newText: "bypass" }],
          })
        )?.isError,
      ).toBe(true);
      expect((await invoke("bash", { command: `printf bypass > '${fixture.shellMarker}'` }))?.isError).toBe(true);
    } finally {
      unsubscribe();
    }
    const starts = events.filter((event) => event.type === "tool_execution_start");
    const ends = events.filter((event) => event.type === "tool_execution_end");
    expect(starts.map(({ toolCallId, parentToolCallId }) => ({ toolCallId, parentToolCallId }))).toEqual(
      Array.from({ length: 6 }, (_, index) => ({
        toolCallId: `trusted-host/${index + 1}`,
        parentToolCallId: "trusted-host",
      })),
    );
    expect(ends.map(({ isError }) => isError)).toEqual([false, false, false, true, true, true]);
    expect(readFileSync(fixture.allowed, "utf8")).toBe("nested edit\n");
    expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
    expect(existsSync(fixture.shellMarker)).toBe(false);
    expect(errors).toEqual([]);
  });

  it("opens the lazy manager and selector through Jiti with a native SDK TUI context", async () => {
    sdk.initTheme("dark", false);
    const fixture = createFixture();
    const tui = createTuiHarness();
    const uiContext = { custom: componentCustom(tui), notify() {}, setWidget() {} } as unknown as ExtensionUIContext;
    const { session, errors } = await open(fixture, { mode: "tui", uiContext });
    const command = session.prompt("/edit-scope");
    try {
      await Promise.race([
        tui.waitForOpen(),
        command.then(() => {
          throw new Error(`Scope did not open: ${JSON.stringify(errors)}`);
        }),
      ]);
      expect(tui.render().join("\n")).toContain("Change allowed files");
      const managerClosed = tui.resultPromise;
      tui.press("tui.select.confirm");
      await managerClosed;
      await tui.waitForOpen();
      await tui.waitForPending();
      expect(tui.render().join("\n")).toContain("Select files");
      const pickerClosed = tui.resultPromise;
      tui.press("tui.select.cancel");
      await pickerClosed;
      await tui.waitForOpen();
      tui.press("tui.select.cancel");
      await command;
      expect((await callTool(session, "write", { path: fixture.outside, content: "not selected" })).isError).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      tui.dispose();
    }
  });

  it.each(["edit-scope", "scope"])(
    "applies through /%s and ends through the other alias with unchanged native loadout",
    async (name) => {
      sdk.initTheme("dark", false);
      const fixture = createFixture();
      fixture.manager.branch(fixture.beforeScope);
      const tui = createTuiHarness();
      const uiContext = { custom: componentCustom(tui), notify() {}, setWidget() {} } as unknown as ExtensionUIContext;
      const { session, errors } = await open(fixture, { mode: "tui", uiContext });
      const initial = loadout(session);
      const command = session.prompt(`/${name}`);
      try {
        await Promise.race([
          tui.waitForOpen(),
          command.then(() => {
            throw new Error(`Scope did not open: ${JSON.stringify(errors)}`);
          }),
        ]);
        const managerClosed = tui.resultPromise;
        tui.press("tui.select.confirm");
        await managerClosed;
        await tui.waitForOpen();
        await tui.waitForPending();
        tui.type("allowed.txt");
        tui.press("tui.input.tab");
        tui.press("tui.select.confirm");
        await command;
        expect(errors).toEqual([]);
        expect((await callTool(session, "write", { path: fixture.allowed, content: "actual UI apply" })).isError).toBe(
          false,
        );
        expect((await callTool(session, "write", { path: fixture.outside, content: "blocked" })).isError).toBe(true);
        expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
        expect(loadout(session)).toBe(initial);
        await session.prompt(`/${name === "edit-scope" ? "scope" : "edit-scope"} off`);
        expect((await callTool(session, "write", { path: fixture.outside, content: "explicit UI exit" })).isError).toBe(
          false,
        );
        expect(loadout(session)).toBe(initial);
        expect(errors).toEqual([]);
        const notices = session.messages.filter(
          (message) => message.role === "custom" && message.customType === "scope-contract",
        );
        expect(notices).toHaveLength(2);
        expect(
          fixture.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "scope-state"),
        ).toHaveLength(2);
      } finally {
        tui.dispose();
      }
    },
  );

  it("activates real home and absolute external files through Jiti and enforces them with stock write", async () => {
    sdk.initTheme("dark", false);
    const fixture = createFixture();
    const home = mkdtempSync(join(dirname(fixture.cwd), "manual-home-"));
    const config = mkdtempSync(join(dirname(fixture.cwd), "manual-config-"));
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
    const projectFile = join(home, "src", "another_project", "AGENTS.md");
    const planFile = join(home, ".plan", "PLAN_A.md");
    const configFile = join(config, "editor settings.json");
    const unselected = join(home, ".config", "unselected.json");
    for (const path of [projectFile, planFile, configFile, unselected]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "external original\n");
    }
    const selections = [
      ["~/src/another_project/AGENTS.md", projectFile],
      ["~/.plan/PLAN_A.md", planFile],
      [configFile, configFile],
    ] as const;
    const tui = createTuiHarness({ width: 240, rows: 44 });
    const notify = vi.fn();
    const uiContext = { custom: componentCustom(tui), notify, setWidget() {} } as unknown as ExtensionUIContext;
    const { session, errors } = await open(fixture, { mode: "tui", uiContext });
    const initial = loadout(session);
    const stateEntries = () =>
      fixture.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "scope-state");
    const text = () => stripVTControlCharacters(tui.render().join("\n"));
    const command = session.prompt("/edit-scope");
    try {
      await Promise.race([
        tui.waitForOpen(),
        command.then(() => {
          throw new Error(`Scope did not open: ${JSON.stringify(errors)}`);
        }),
      ]);
      const managerClosed = tui.resultPromise;
      tui.press("tui.select.confirm");
      await managerClosed;
      await tui.waitForOpen();
      await tui.waitForPending();
      for (const [raw, path] of selections) {
        tui.send("\x0f");
        tui.type(raw);
        expect(text()).toContain("Add existing file");
        expect(text()).toContain(`Path: ${JSON.stringify(raw)}`);
        tui.press("tui.input.submit");
        await tui.waitForPending();
        const draft = text();
        expect(draft).toContain(`→ [x] (outside) ${displayFilePath(path)}`);
        expect(draft).toContain("Outside the current directory");
        expect(draft).not.toContain(`> ${raw}`);
        expect(stateEntries()).toHaveLength(1);
        expect((await callTool(session, "write", { path: raw, content: "draft must not grant writes" })).isError).toBe(
          true,
        );
        expect(readFileSync(path, "utf8")).toBe("external original\n");
        expect(loadout(session)).toBe(initial);
      }
      tui.press("tui.select.pageUp");
      expect(text()).toContain(`[x] ${displayFilePath(relative(fixture.cwd, fixture.allowed))}`);
      expect(text()).toContain(`[x] ${displayFilePath(relative(fixture.cwd, fixture.reserved))}`);
      expect(text()).toContain("5 selected");
      tui.press("tui.select.confirm");
      await command;
      expect(tui.isOpen).toBe(false);
      expect(stateEntries()).toHaveLength(2);
      expect(stateEntries().at(-1)).toMatchObject({
        data: {
          version: 1,
          cwd: fixture.cwd,
          targets: expect.arrayContaining(
            [fixture.allowed, fixture.reserved, projectFile, planFile, configFile].map((path) => ({
              path,
              canonical: path === fixture.reserved ? path : realpathSync(path),
            })),
          ),
        },
      });
      expect(session.getAllTools().find(({ name }) => name === "write")?.sourceInfo).toMatchObject({
        path: "builtin:write",
        source: "builtin",
      });
      for (const [raw, path] of selections) {
        const outcome = await callTool(session, "write", { path: raw, content: "selected external update\n" });
        expect(outcome.isError, resultText(outcome)).toBe(false);
        expect(readFileSync(path, "utf8")).toBe("selected external update\n");
      }
      for (const path of [unselected, fixture.outside]) {
        const outcome = await callTool(session, "write", { path, content: "blocked" });
        expect(outcome.isError, resultText(outcome)).toBe(true);
      }
      expect(readFileSync(unselected, "utf8")).toBe("external original\n");
      expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
      expect(existsSync(fixture.reserved)).toBe(false);
      expect(existsSync(join(sdk.getAgentDir(), "pi-scope.json"))).toBe(false);
      expect(loadout(session)).toBe(initial);
      expect(errors).toEqual([]);
      expect(notify.mock.calls.filter(([, kind]) => kind === "error")).toEqual([]);
    } finally {
      tui.dispose();
      await command;
    }
  });

  it("retains native prompt/tool deltas through the real context runner, including historical anchors after off", async () => {
    const fixture = createFixture();
    const { session, errors } = await open(fixture);
    const head: AgentMessage = {
      role: "system",
      content: "Initial native instruction",
      timestamp: 1,
      toolsAdded: [{ name: "write", description: "Native writer", parameters: Type.Object({}) }],
    };
    const request: AgentMessage = { role: "user", content: "first request", timestamp: 2 };
    const firstInput = [head, request];
    const first = await session.extensionRunner.emitContext(firstInput);
    const delta: AgentMessage = {
      role: "system",
      content: "Native tail instruction",
      timestamp: 4,
      toolsAdded: [{ name: "grep", description: "Native added reader", parameters: Type.Object({}) }],
    };
    const nextInput: AgentMessage[] = [
      ...firstInput,
      assistant([{ type: "text", text: "done" }]),
      delta,
      { role: "user", content: "second request", timestamp: 5 },
    ];
    const next = await session.extensionRunner.emitContext(nextInput);
    const normalized = (messages: AgentMessage[]) =>
      sdk
        .convertToLlm(messages)
        .map((message) =>
          Object.fromEntries(
            Object.entries(message).filter(([key]) => !["timestamp", "usage", "durationMs"].includes(key)),
          ),
        );
    expect(normalized(next).slice(0, first.length)).toEqual(normalized(first));
    expect(next[0]).toEqual(first[0]);
    expect(next.filter((message) => message.role === "system")).toHaveLength(2);
    expect(next.some((message) => message.role === "system" && message.content === "Native tail instruction")).toBe(
      true,
    );
    expect(
      fixture.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "scope-context-anchor"),
    ).toHaveLength(1);

    const oldLeafId = fixture.manager.getLeafId();
    const newLeafId = fixture.manager.appendCustomEntry("scope-state", { version: 1, cwd: fixture.cwd, targets: null });
    await session.extensionRunner.emit({ type: "session_tree", oldLeafId, newLeafId });
    const offInput = [...nextInput, assistant([{ type: "text", text: "ending" }])];
    const off = await session.extensionRunner.emitContext(offInput);
    expect(normalized(off).slice(0, next.length)).toEqual(normalized(next));
    const afterOff: AgentMessage[] = [
      ...offInput,
      { role: "system", content: "Another native delta", timestamp: 6 },
      { role: "user", content: "ordinary request after off", timestamp: 7 },
    ];
    const last = await session.extensionRunner.emitContext(afterOff);
    expect(normalized(last).slice(0, off.length)).toEqual(normalized(off));
    expect(last.filter((message) => message.role === "system")).toHaveLength(3);
    expect(last[0]).toEqual(first[0]);
    expect(errors).toEqual([]);
  });

  it("keeps a recovered off notice fixed after stale native history, ordinary requests, and reload", async () => {
    const fixture = createFixture();
    const { session, errors } = await open(fixture);
    const initial = loadout(session);
    const head: AgentMessage = {
      role: "system",
      content: "Native leading instruction",
      timestamp: 1,
      toolsAdded: [{ name: "write", description: "Native writer", parameters: Type.Object({}) }],
    };
    const first = await session.extensionRunner.emitContext([
      head,
      { role: "user", content: "old request", timestamp: 2 },
    ]);
    const retained = first.at(-1) as AgentMessage;
    expect(retained).toMatchObject({ role: "custom", customType: "scope-contract" });
    const oldLeafId = fixture.manager.getLeafId();
    const newLeafId = fixture.manager.appendCustomEntry("scope-state", { version: 1, cwd: fixture.cwd, targets: null });
    await session.extensionRunner.emit({ type: "session_tree", oldLeafId, newLeafId });
    const input: AgentMessage[] = [
      head,
      { role: "compactionSummary", summary: "Replaced old request", tokensBefore: 100, timestamp: 3 },
      retained,
    ];
    const normalized = (messages: AgentMessage[]) =>
      JSON.stringify(
        sdk
          .convertToLlm(messages)
          .map((message) =>
            Object.fromEntries(
              Object.entries(message).filter(([key]) => !["timestamp", "usage", "durationMs"].includes(key)),
            ),
          ),
      );
    const anchors = () =>
      fixture.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "scope-context-anchor");
    const recovered = await session.extensionRunner.emitContext(input);
    const offNotice = recovered.at(-1) as AgentMessage;
    expect(recovered.slice(0, input.length)).toEqual(input);
    expect(offNotice).toMatchObject({ role: "custom", content: expect.stringContaining("ended the Scope") });
    expect(anchors()).toHaveLength(2);

    const delta: AgentMessage = {
      role: "system",
      content: "Native additive tail instruction",
      timestamp: 4,
      toolsAdded: [{ name: "grep", description: "Native reader", parameters: Type.Object({}) }],
    };
    const ordinaryInput: AgentMessage[] = [
      ...input,
      assistant([{ type: "text", text: "answer after off" }]),
      delta,
      { role: "user", content: "ordinary request", timestamp: 5 },
    ];
    const ordinary = await session.extensionRunner.emitContext(ordinaryInput);
    expect(normalized(ordinary.slice(0, recovered.length))).toBe(normalized(recovered));
    expect(ordinary[0]).toEqual(head);
    expect(ordinary.filter((message) => message.role === "system")).toEqual([head, delta]);
    expect(anchors()).toHaveLength(2);

    await session.reload();
    const afterReload = await session.extensionRunner.emitContext([
      ...ordinaryInput,
      offNotice,
      { role: "user", content: "late publication after reload", timestamp: 6 },
    ]);
    expect(normalized(afterReload.slice(0, ordinary.length))).toBe(normalized(ordinary));
    expect(
      afterReload.filter((message) => message.role === "custom" && message.customType === "scope-contract"),
    ).toHaveLength(2);
    expect(afterReload.filter((message) => message.role === "system")).toEqual([head, delta]);
    expect(anchors()).toHaveLength(2);
    expect(loadout(session)).toBe(initial);
    expect(errors).toEqual([]);
  });

  it("preserves native active history through a real blocked loadout and reload to the same state", async () => {
    const fixture = createFixture();
    const { createScopeNotice } = await import("../src/scope/contracts.js");
    const notice = createScopeNotice({
      state: "active",
      entryId: fixture.scopeEntry,
      snapshot: { version: 1, cwd: fixture.cwd, targets: fixture.snapshot.targets },
    });
    if (!notice) throw new Error("Missing fixture notice");
    fixture.manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
    const { session, errors } = await open(fixture);
    const activeTools = session.getActiveToolNames();
    const head: AgentMessage = { role: "system", content: "Native instructions", timestamp: 1 };
    const input: AgentMessage[] = [head, ...session.messages];
    const normalized = (messages: AgentMessage[]) => JSON.stringify(sdk.convertToLlm(messages));
    session.setActiveToolsByName(["read"]);
    const blocked = await session.extensionRunner.emitContext(input);
    expect(blocked.at(-1)).toMatchObject({ role: "custom", content: expect.stringContaining("state is unavailable") });
    expect(blocked.slice(0, input.length)).toEqual(input);

    session.setActiveToolsByName(activeTools);
    expect((await callTool(session, "write", { path: fixture.allowed, content: "still blocked" })).isError).toBe(true);
    const answer = assistant([{ type: "text", text: "answer before reload" }]);
    fixture.manager.appendMessage(answer);
    await session.reload();
    const restored = await session.extensionRunner.emitContext([...input, answer]);
    expect(normalized(restored.slice(0, blocked.length))).toBe(normalized(blocked));
    expect(restored.at(-1)).toMatchObject({
      role: "custom",
      content: expect.stringContaining("restriction is active"),
    });
    const ordinary = await session.extensionRunner.emitContext([
      ...input,
      answer,
      { role: "user", content: "next ordinary request", timestamp: 5 },
    ]);
    expect(normalized(ordinary.slice(0, restored.length))).toBe(normalized(restored));
    expect(
      fixture.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "scope-state"),
    ).toHaveLength(1);
    expect(
      fixture.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "scope-context-anchor"),
    ).toHaveLength(2);
    expect((await callTool(session, "write", { path: fixture.allowed, content: "active after reload" })).isError).toBe(
      false,
    );
    expect((await callTool(session, "write", { path: fixture.outside, content: "not selected" })).isError).toBe(true);
    expect(errors).toEqual([]);
  });

  it("keeps normalized provider input prefixes and declarations stable across real offline agent requests", async () => {
    const fixture = createFixture();
    const { session, errors } = await open(fixture);
    const requests: Array<{ declarations: string; messages: unknown[] }> = [];
    session.agent.streamFunction = (_model, context) => {
      const effective = getCurrentSystemMessage(context.messages);
      requests.push({
        declarations: JSON.stringify({
          content: effective?.content,
          sections: effective?.sections,
          tools: effective?.toolsAdded,
        }),
        messages: context.messages.map((message) =>
          Object.fromEntries(
            Object.entries(message).filter(
              ([key]) => !["timestamp", "usage", "stopReason", "durationMs"].includes(key),
            ),
          ),
        ),
      });
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: assistant([{ type: "text", text: `offline answer ${requests.length}` }]),
      });
      return stream;
    };
    const initial = loadout(session);
    // Exercise the real SDK context transform and agent loop with a local stream only.
    // No ModelRuntime transport, credential resolution, HTTP request, or provider is used.
    await session.agent.prompt("First ordinary request");
    await session.agent.prompt("Second ordinary request");
    expect(requests).toHaveLength(2);
    expect(requests[1].declarations).toBe(requests[0].declarations);
    expect(JSON.stringify(requests[1].messages.slice(0, requests[0].messages.length))).toBe(
      JSON.stringify(requests[0].messages),
    );
    expect(loadout(session)).toBe(initial);
    expect(
      fixture.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "scope-context-anchor"),
    ).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("restores restrictions after native reload and durable resume without changing tools", async () => {
    const fixture = createFixture();
    const file = fixture.manager.getSessionFile();
    expect(file).toBeDefined();
    expect(existsSync(file ?? "")).toBe(true);
    expect(readFileSync(file ?? "", "utf8")).toContain('"customType":"scope-state"');
    const { session, loader, errors } = await open(fixture, { discovery: true });
    expect(loader.getExtensions().extensions[0].sourceInfo).toMatchObject({ source: "auto", scope: "project" });
    const initial = loadout(session);
    const oldRunner = session.extensionRunner;
    await session.reload();
    expect(session.extensionRunner).not.toBe(oldRunner);
    expect(loader.getExtensions().errors).toEqual([]);
    expect([...loader.getExtensions().extensions[0].commands.keys()]).toEqual(
      expect.arrayContaining(["edit-scope", "scope"]),
    );
    expect(loader.getExtensions().extensions[0].sourceInfo).toMatchObject({ source: "auto", scope: "project" });
    expect(loadout(session)).toEqual(initial);
    expect((await callTool(session, "write", { path: fixture.outside, content: "reload bypass" })).isError).toBe(true);
    expect((await callTool(session, "write", { path: fixture.allowed, content: "after reload\n" })).isError).toBe(
      false,
    );
    expect(errors).toEqual([]);
    await session.prompt("/edit-scope");
    expect(errors).toEqual([
      expect.objectContaining({
        extensionPath: "command:edit-scope",
        event: "command",
        error: "/edit-scope requires Pi TUI mode",
      }),
    ]);
    await disposeNativeSession(session);
    sessions.delete(session);

    const resumed = await open(fixture, { manager: sdk.SessionManager.open(file ?? "") });
    expect(
      (
        await callTool(resumed.session, "edit", {
          path: fixture.allowed,
          edits: [{ oldText: "after reload", newText: "after resume" }],
        })
      ).isError,
    ).toBe(false);
    expect(
      (await callTool(resumed.session, "write", { path: fixture.outside, content: "resume bypass" })).isError,
    ).toBe(true);
    expect(readFileSync(fixture.allowed, "utf8")).toBe("after resume\n");
    expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
  });

  it("uses active history after native tree navigation, fork extraction, and a new session", async () => {
    const fixture = createFixture();
    const { session } = await open(fixture);
    expect((await callTool(session, "write", { path: fixture.outside, content: "blocked" })).isError).toBe(true);
    const tree = await session.navigateTree(fixture.scopeEntry, { summarize: false });
    expect(tree.cancelled).toBe(false);
    expect((await callTool(session, "write", { path: fixture.outside, content: "still blocked" })).isError).toBe(true);
    const branchFile = fixture.manager.createBranchedSession(fixture.scopeEntry);
    expect(branchFile).toBeDefined();
    const fork = await open(fixture, { manager: sdk.SessionManager.open(branchFile ?? "") });
    expect((await callTool(fork.session, "write", { path: fixture.outside, content: "fork bypass" })).isError).toBe(
      true,
    );
    const before = await session.navigateTree(fixture.beforeScope, { summarize: false });
    expect(before.cancelled).toBe(false);
    expect((await callTool(session, "write", { path: fixture.outside, content: "before activation\n" })).isError).toBe(
      false,
    );
    const fresh = await open(fixture, { manager: sdk.SessionManager.inMemory(fixture.cwd) });
    expect(
      (await callTool(fresh.session, "write", { path: fixture.outside, content: "new session unrestricted\n" }))
        .isError,
    ).toBe(false);
    expect(readFileSync(fixture.outside, "utf8")).toBe("new session unrestricted\n");
  });
});
