import { existsSync, linkSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it } from "vitest";
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
} from "./smoke-fixture.ts";

const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
const sessions = new Set<AgentSession>();
async function open(...args: Parameters<typeof createNativeSession>) {
  const result = await createNativeSession(...args);
  sessions.add(result.session);
  return result;
}
afterEach(async () => {
  const outcomes = await Promise.allSettled([...sessions].map(disposeNativeSession));
  sessions.clear();
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
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
  it("loads the real entrypoint with only /scope and no replacement tools", async () => {
    const fixture = createFixture();
    const { session, loader, errors } = await open(fixture);
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    expect(realpathSync(extension.path)).toBe(realpathSync(entrypoint));
    expect([...extension.commands.keys()]).toEqual(["scope"]);
    expect([...extension.tools.keys()]).toEqual([]);
    expect([...extension.flags.keys()]).toEqual([]);
    expect([...extension.shortcuts.keys()]).toEqual([]);
    expect(extension.handlers.has("context")).toBe(false);
    expect(extension.handlers.has("context_with_system")).toBe(true);
    const command = extension.commands.get("scope");
    expect(command?.getArgumentCompletions?.("o")).toEqual([
      { value: "off", label: "off", description: "End the editing restriction" },
    ]);
    expect(command?.getArgumentCompletions?.("off ")).toEqual([]);
    expect(session.getAllTools().find(({ name }) => name === "write")?.sourceInfo).toMatchObject({
      path: "builtin:write",
      source: "builtin",
    });
    expect(errors).toEqual([]);
  });

  it.each(["rpc", "print", "json"] as const)(
    "rejects commands observably in %s mode without releasing scope",
    async (mode) => {
      const fixture = createFixture();
      const { session, errors } = await open(fixture, { mode });
      for (const route of ["/scope", "/scope off", "/scope status", "/scope off trailing"]) {
        const offset = errors.length;
        await session.prompt(route);
        expect(errors.slice(offset)).toEqual([
          expect.objectContaining({
            extensionPath: "command:scope",
            event: "command",
            error:
              route === "/scope" || route === "/scope off"
                ? "/scope requires Pi TUI mode"
                : "Usage: /scope or /scope off",
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
    },
  );

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
    const uiContext = { custom: tui.custom, notify() {}, setWidget() {} } as unknown as ExtensionUIContext;
    const { session, errors } = await open(fixture, { mode: "tui", uiContext });
    const command = session.prompt("/scope");
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
      expect(tui.render().join("\n")).toContain("Select allowed files");
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

  it("applies and ends Scope through actual Jiti TUI commands without changing native loadout", async () => {
    sdk.initTheme("dark", false);
    const fixture = createFixture();
    fixture.manager.branch(fixture.beforeScope);
    const tui = createTuiHarness();
    const uiContext = { custom: tui.custom, notify() {}, setWidget() {} } as unknown as ExtensionUIContext;
    const { session, errors } = await open(fixture, { mode: "tui", uiContext });
    const initial = loadout(session);
    const command = session.prompt("/scope");
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
      tui.press("tui.select.confirm");
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await command;
      expect(errors).toEqual([]);
      expect((await callTool(session, "write", { path: fixture.allowed, content: "actual UI apply" })).isError).toBe(
        false,
      );
      expect((await callTool(session, "write", { path: fixture.outside, content: "blocked" })).isError).toBe(true);
      expect(readFileSync(fixture.outside, "utf8")).toBe("outside original\n");
      expect(loadout(session)).toBe(initial);
      await session.prompt("/scope off");
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
    expect([...loader.getExtensions().extensions[0].commands.keys()]).toEqual(["scope"]);
    expect(loader.getExtensions().extensions[0].sourceInfo).toMatchObject({ source: "auto", scope: "project" });
    expect(loadout(session)).toEqual(initial);
    expect((await callTool(session, "write", { path: fixture.outside, content: "reload bypass" })).isError).toBe(true);
    expect((await callTool(session, "write", { path: fixture.allowed, content: "after reload\n" })).isError).toBe(
      false,
    );
    expect(errors).toEqual([]);
    await session.prompt("/scope");
    expect(errors).toEqual([
      expect.objectContaining({
        extensionPath: "command:scope",
        event: "command",
        error: "/scope requires Pi TUI mode",
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
