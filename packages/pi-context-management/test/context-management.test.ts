import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  DefaultResourceLoader,
  type ExtensionAPI,
  ExtensionRunner,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  SettingsManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { CONTEXT_MANAGEMENT_TOOL_NAMES } from "../src/context-tools.js";
import {
  CONTEXT_CONTRACT_MESSAGE_TYPE,
  CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  CONTEXT_STATE_ENTRY_TYPE,
  contextContract,
  createContextManagementDetails,
  createInitialContextState,
} from "../src/context-window.js";
import { createContextManagementExtension } from "../src/pi-context-management.js";
import type { ContextManagementSettingsRuntime, ContextManagementSettingsState } from "../src/settings.js";
import { DEFAULT_CONTEXT_MANAGEMENT_SETTINGS } from "../src/settings.js";

const GENERIC_CONTEXT_TOOL_NAMES = [
  "start_new_context",
  "get_context_remaining",
  "recall_context",
  "update_notes",
] as const;

function registerGenericContextTools(pi: ExtensionAPI): void {
  for (const name of GENERIC_CONTEXT_TOOL_NAMES) {
    pi.registerTool({
      name,
      label: `Foreign ${name}`,
      description: `Foreign tool named ${name}`,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return { content: [{ type: "text", text: "foreign" }], details: {} };
      },
    });
  }
}

function settingsRuntime(enabled = true): ContextManagementSettingsRuntime {
  let state: ContextManagementSettingsState = {
    kind: "loaded",
    path: "/tmp/pi-context-management.json",
    settings: {
      ...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
      enabled: enabled,
    },
    document: {},
  };
  return {
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async update(patch) {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    async flush() {},
  };
}

function messageEntry(): SessionEntry {
  return {
    type: "message",
    id: "user",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
  };
}

function assistantMessage(stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"): AgentMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
  };
}

function abortedAssistantMessage(): AgentMessage {
  return assistantMessage("aborted");
}

function setup(enabled = true, fetch?: typeof globalThis.fetch, contextOverrides: Record<string, unknown> = {}) {
  const mock = createMockPi({ activeTools: ["read"] });
  const runtime = settingsRuntime(enabled);
  let activeEntries: SessionEntry[] = [messageEntry()];
  mock.rawPi.appendEntry = (customType, data) => {
    mock.entries.push({ customType, data });
    activeEntries.push({
      type: "custom",
      customType,
      data,
      id: `custom-${activeEntries.length}`,
      parentId: activeEntries.at(-1)?.id ?? null,
      timestamp: new Date(activeEntries.length).toISOString(),
    });
  };
  let compactOptions:
    | {
        onComplete?: (result: unknown) => void;
        onError?: (error: Error) => void;
      }
    | undefined;
  const current = createMockContext({
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "context-session",
      getSessionName: () => undefined,
      getBranch: () => activeEntries,
      getEntries: () => activeEntries,
    },
    getContextUsage: () => ({ tokens: 25, contextWindow: 100, percent: 25 }),
    compact: (options: typeof compactOptions) => {
      compactOptions = options;
    },
    ...contextOverrides,
  });
  void fetch;
  createContextManagementExtension({ settingsRuntime: runtime })(mock.pi);
  mock.rawPi.getAllTools = () =>
    mock.tools.map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      promptGuidelines: definition.promptGuidelines,
      sourceInfo: {
        path: resolve("packages/pi-context-management/src/index.ts"),
        source: "test",
        scope: "temporary",
        origin: "top-level",
      },
    }));
  return {
    mock,
    runtime,
    get entries() {
      return activeEntries;
    },
    setBranch(entries: SessionEntry[]) {
      activeEntries = entries;
    },
    current,
    get compactOptions() {
      return compactOptions;
    },
  };
}

async function start(setupResult: ReturnType<typeof setup>) {
  const handler = setupResult.mock.events.get("session_start")?.[0];
  assert.ok(handler);
  await handler({ type: "session_start", reason: "startup" }, setupResult.current.ctx);
}

function persistSentCustomMessage(entries: SessionEntry[], sentMessage: unknown) {
  const message = sentMessage as
    | {
        customType?: string;
        content?: string;
        display?: boolean;
        details?: unknown;
      }
    | undefined;
  if (!message || typeof message.customType !== "string" || typeof message.content !== "string") {
    assert.fail("Expected a sent custom message");
  }
  entries.push({
    type: "message",
    id: `sent-${entries.length}`,
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date(entries.length).toISOString(),
    message: {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display ?? false,
      details: message.details,
      timestamp: entries.length,
    },
  });
}

function persistLastSentCustomMessage(setupResult: ReturnType<typeof setup>) {
  persistSentCustomMessage(setupResult.entries, setupResult.mock.sentMessages.at(-1)?.message);
}

function persistToolResult(
  setupResult: ReturnType<typeof setup>,
  id: string,
  result: { content: unknown; details?: unknown },
) {
  setupResult.entries.push({
    type: "message",
    id,
    parentId: setupResult.entries.at(-1)?.id ?? null,
    timestamp: new Date(setupResult.entries.length).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "context_management_start_new_context",
      content: result.content as never,
      details: result.details === undefined ? undefined : toJsonValue(result.details),
      isError: false,
      timestamp: setupResult.entries.length,
    },
  });
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toJsonValue(item);
    }
    return result;
  }
  throw new TypeError("Context-management test fixture must be JSON-compatible");
}

function tool(setupResult: ReturnType<typeof setup>, name: string) {
  const found = setupResult.mock.tools.find((candidate) => candidate.name === name);
  assert.ok(found);
  return found as {
    execute: (...args: unknown[]) => Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
      terminate?: boolean;
    }>;
    promptSnippet?: string;
    promptGuidelines?: string[];
  };
}

async function emitAutomaticCompaction(
  current: ReturnType<typeof setup>,
  overrideDetails?: unknown | ((details: unknown) => unknown),
) {
  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const result = (await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  )) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: unknown;
    };
  };
  const compactEntry = {
    type: "compaction",
    id: `automatic-helper-${current.entries.length}`,
    parentId: current.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:03.000Z",
    ...result.compaction,
    ...(overrideDetails === undefined
      ? {}
      : {
          details: typeof overrideDetails === "function" ? overrideDetails(result.compaction.details) : overrideDetails,
        }),
  };
  current.entries.push(compactEntry as SessionEntry);
  await current.mock.events.get("session_compact")?.[0](
    {
      type: "session_compact",
      compactionEntry: compactEntry,
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    },
    current.current.ctx,
  );
  return { result, compactEntry };
}

async function completeRequestedCompaction(current: ReturnType<typeof setup>) {
  const { result } = await emitAutomaticCompaction(current);
  current.compactOptions?.onComplete?.(result.compaction);
}

test("opt-in activates exactly four context tools after unrelated tools", async () => {
  const current = setup();
  await start(current);
  assert.deepEqual(
    current.mock.tools.map((candidate) => candidate.name),
    CONTEXT_MANAGEMENT_TOOL_NAMES,
  );
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);
  for (const name of CONTEXT_MANAGEMENT_TOOL_NAMES) {
    assert.equal(tool(current, name).promptSnippet, undefined);
    assert.equal(tool(current, name).promptGuidelines, undefined);
  }
  assert.match(current.current.notifications[0]?.message ?? "", /Experimental context management/);
});

test("tool reconciliation preserves unrelated active-tool order", async () => {
  const current = setup();
  await start(current);
  const orderedTools = ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES, "write"];
  current.mock.rawPi.setActiveTools(orderedTools);
  const tree = current.mock.events.get("session_tree")?.[0];
  assert.ok(tree);

  await tree({ type: "session_tree", oldLeafId: "user", newLeafId: "user" }, current.current.ctx);

  assert.deepEqual(current.mock.rawPi.getActiveTools(), orderedTools);
});

test("startup activation fails closed when initial lineage persistence fails", async () => {
  const current = setup();
  current.mock.rawPi.appendEntry = () => {
    throw new Error("initial lineage write failed");
  };

  await assert.rejects(() => start(current), /initial lineage write failed/);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  assert.equal(current.mock.sentMessages.length, 0);
  await assert.rejects(
    tool(current, "context_management_get_context_remaining").execute(
      "call-after-failure",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
    /disabled/,
  );
});

test("a failed initial lineage write does not disable a healthy concurrent session", async () => {
  const current = setup();
  await start(current);
  persistLastSentCustomMessage(current);

  const secondEntries: SessionEntry[] = [messageEntry()];
  const second = createMockContext({
    mode: "print",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "second-context-session",
      getSessionName: () => undefined,
      getBranch: () => secondEntries,
      getEntries: () => secondEntries,
    },
  });
  const appendEntry = current.mock.rawPi.appendEntry;
  current.mock.rawPi.appendEntry = (customType, data) => {
    if (customType === CONTEXT_STATE_ENTRY_TYPE) throw new Error("second lineage write failed");
    appendEntry(customType, data);
  };
  const sessionStart = current.mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);

  await assert.rejects(async () => {
    await sessionStart({ type: "session_start", reason: "startup" }, second.ctx);
  }, /second lineage write failed/);

  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);
  await assert.doesNotReject(() =>
    tool(current, "context_management_get_context_remaining").execute(
      "healthy-call",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
  );
  await assert.rejects(
    tool(current, "context_management_get_context_remaining").execute(
      "failed-session-call",
      {},
      undefined,
      undefined,
      second.ctx,
    ),
    /disabled/,
  );
});

test("a failed initial lineage write is retried after menu rollback", async () => {
  let selection = 0;
  const current = setup(false, undefined, {
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === "On");
      return undefined;
    },
  });
  const appendEntry = current.mock.rawPi.appendEntry;
  const attemptedWindowIds: string[] = [];
  current.mock.rawPi.appendEntry = (customType, data) => {
    if (customType === CONTEXT_STATE_ENTRY_TYPE) {
      attemptedWindowIds.push((data as { currentWindowId: string }).currentWindowId);
    }
    if (attemptedWindowIds.length === 1) throw new Error("transient lineage write failure");
    appendEntry(customType, data);
  };
  await start(current);
  const command = current.mock.commands.get("context-management");
  assert.ok(command);

  await command.handler("", current.current.ctx);
  assert.equal(current.runtime.get().settings.enabled, false);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  assert.equal(
    current.entries.filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE).length,
    0,
  );

  selection = 0;
  await command.handler("", current.current.ctx);
  assert.equal(attemptedWindowIds.length, 2);
  assert.notEqual(attemptedWindowIds[0], attemptedWindowIds[1]);
  assert.equal(current.runtime.get().settings.enabled, true);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);
  assert.equal(
    current.entries.filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE).length,
    1,
  );
  await assert.doesNotReject(() =>
    tool(current, "context_management_get_context_remaining").execute(
      "call-after-retry",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
  );
});

test("a synthesized context contract stays at the durable conversation tail", async () => {
  const current = setup();
  current.setBranch([
    {
      type: "branch_summary",
      id: "branch-summary",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      fromId: "old-leaf",
      summary: "Earlier branch summary",
    },
    messageEntry(),
  ]);
  await start(current);
  const contextHandler = current.mock.events.get("context")?.[0];
  assert.ok(contextHandler);
  const initialMessages = current.entries.flatMap(sessionEntryToContextMessages);
  const synthetic = (await contextHandler({ type: "context", messages: initialMessages }, current.current.ctx)) as
    | { messages: AgentMessage[] }
    | undefined;
  assert.ok(synthetic);
  assert.equal(synthetic.messages.at(-1)?.role, "custom");
  assert.equal(
    (synthetic.messages.at(-1) as { customType?: string } | undefined)?.customType,
    CONTEXT_CONTRACT_MESSAGE_TYPE,
  );

  persistLastSentCustomMessage(current);
  const durableMessages = current.entries.flatMap(sessionEntryToContextMessages);
  assert.deepEqual(durableMessages.slice(0, -1), synthetic.messages.slice(0, -1));
  assert.equal(durableMessages.at(-1)?.role, "custom");
  assert.equal(
    (durableMessages.at(-1) as { content?: unknown } | undefined)?.content,
    (synthetic.messages.at(-1) as { content?: unknown } | undefined)?.content,
  );
  assert.equal(await contextHandler({ type: "context", messages: durableMessages }, current.current.ctx), undefined);
});

test("default-off removes context tools and stale calls fail", async () => {
  const current = setup(false);
  await start(current);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  await assert.rejects(
    tool(current, "context_management_get_context_remaining").execute(
      "call",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
    /disabled/,
  );
});

test("disabled mode preserves active generic context tools", async () => {
  const current = setup(false);
  current.mock.rawPi.setActiveTools(["read", ...GENERIC_CONTEXT_TOOL_NAMES]);
  await start(current);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...GENERIC_CONTEXT_TOOL_NAMES]);
});

test.each(["context-first", "generic-first"] as const)(
  "package-scoped context tools preserve a generic tool owner when loaded %s",
  async (order) => {
    const contextFactory = createContextManagementExtension({ settingsRuntime: settingsRuntime(false) });
    const genericFactory = (pi: ExtensionAPI) => registerGenericContextTools(pi);
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories:
        order === "context-first" ? [contextFactory, genericFactory] : [genericFactory, contextFactory],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 2);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), {} as never, {} as never);
    const resolved = runner.getAllRegisteredTools();
    assert.deepEqual(
      resolved.map((tool) => tool.definition.name).sort(),
      [...GENERIC_CONTEXT_TOOL_NAMES, ...CONTEXT_MANAGEMENT_TOOL_NAMES].sort(),
    );
    for (const name of GENERIC_CONTEXT_TOOL_NAMES) {
      assert.equal(resolved.find((tool) => tool.definition.name === name)?.definition.label, `Foreign ${name}`);
    }
    loaded.runtime.invalidate("context tool load-order test completed");
  },
);

test("disabling during an active run publishes deactivation only when tools are removed", async () => {
  let selection = 0;
  const current = setup(true, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === "Off");
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  const sentBeforeOptOut = current.mock.sentMessages.length;
  await command.handler("", current.current.ctx);

  assert.equal(current.runtime.get().settings.enabled, false);
  assert.equal(current.mock.sentMessages.length, sentBeforeOptOut);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);
  const contextHandler = current.mock.events.get("context")?.[0];
  assert.ok(contextHandler);
  assert.equal(
    await contextHandler(
      { type: "context", messages: current.entries.flatMap(sessionEntryToContextMessages) },
      current.current.ctx,
    ),
    undefined,
  );
  await assert.doesNotReject(() =>
    tool(current, "context_management_get_context_remaining").execute(
      "call-before-settlement",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
  );

  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.equal(
    (current.mock.sentMessages.at(-1)?.message as { customType?: string } | undefined)?.customType,
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  await assert.rejects(
    tool(current, "context_management_get_context_remaining").execute(
      "call-after-settlement",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
    /disabled/,
  );
});

test("deferred opt-out publishes deactivation after an intervening compaction", async () => {
  let selection = 0;
  const current = setup(true, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === "Off");
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  const sentBeforeOptOut = current.mock.sentMessages.length;
  await command.handler("", current.current.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeOptOut);

  const laterEntry: SessionEntry = {
    type: "message",
    id: "after-deactivation",
    parentId: current.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "user", content: [{ type: "text", text: "large later turn" }], timestamp: 3 },
  };
  current.entries.push(laterEntry);
  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const prepared = (await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: laterEntry.id,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  )) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: unknown;
    };
  };
  const compactEntry = {
    type: "compaction",
    id: "drops-deactivation",
    parentId: laterEntry.id,
    timestamp: "2026-01-01T00:00:04.000Z",
    ...prepared.compaction,
  } as SessionEntry;
  current.entries.push(compactEntry);
  await current.mock.events.get("session_compact")?.[0](
    {
      type: "session_compact",
      compactionEntry: compactEntry,
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    },
    current.current.ctx,
  );

  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  const deactivations = current.mock.sentMessages.filter(
    (item) => (item.message as { customType?: string }).customType === CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
  assert.equal(deactivations.length, 1);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  persistLastSentCustomMessage(current);
  const modelMessages = buildContextEntries(current.entries, current.entries.at(-1)?.id ?? null).flatMap(
    sessionEntryToContextMessages,
  );
  assert.equal(
    (modelMessages.at(-1) as Extract<AgentMessage, { role: "custom" }> | undefined)?.customType,
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
});

test("deferred opt-out rejects a new rollover before settlement", async () => {
  let selection = 0;
  const current = setup(true, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === "Off");
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  await command.handler("", current.current.ctx);

  await assert.rejects(
    tool(current, "context_management_start_new_context").execute(
      "rollover-after-opt-out",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
    /deactivating/,
  );
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.equal(current.compactOptions, undefined);
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    0,
  );
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
});

test("opt-out after an accepted rollover preserves a failure continuation through settlement", async () => {
  let selection = 0;
  const current = setup(true, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === "Off");
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  await tool(current, "context_management_start_new_context").execute(
    "accepted-before-opt-out",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );

  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  await command.handler("", current.current.ctx);
  assert.equal(current.runtime.get().settings.enabled, false);
  assert.equal(current.compactOptions, undefined);
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    0,
  );

  const settled = current.mock.events.get("agent_settled")?.[0];
  assert.ok(settled);
  await settled({ type: "agent_settled" }, current.current.ctx);
  await settled({ type: "agent_settled" }, current.current.ctx);
  assert.equal(current.compactOptions, undefined);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  const continuations = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  );
  assert.equal(continuations.length, 1);
  assert.match(JSON.stringify(continuations[0]), /rollover failed.*disabled before rollover completed/is);
});

test("opt-out preserves a completed rollover continuation through settlement", async () => {
  let selection = 0;
  const current = setup(true, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === "Off");
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  await tool(current, "context_management_start_new_context").execute(
    "completed-before-opt-out",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  await emitAutomaticCompaction(current);

  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  await command.handler("", current.current.ctx);
  const settled = current.mock.events.get("agent_settled")?.[0];
  assert.ok(settled);
  await settled({ type: "agent_settled" }, current.current.ctx);
  await settled({ type: "agent_settled" }, current.current.ctx);

  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  const continuations = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  );
  assert.equal(continuations.length, 1);
  assert.match(JSON.stringify(continuations[0]), /is now active.*context tools became unavailable/is);
});

test("re-enabling before settlement preserves an accepted rollover without a prefix transition", async () => {
  let selectedValue = "Off";
  let selection = 0;
  const current = setup(true, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === selectedValue);
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  await tool(current, "context_management_start_new_context").execute(
    "accepted-before-re-enable",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  const sentBeforeOptOut = current.mock.sentMessages.length;
  await command.handler("", current.current.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeOptOut);

  selectedValue = "On";
  selection = 0;
  await command.handler("", current.current.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeOptOut);
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.ok(current.compactOptions);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);
});

test("rapid mid-run enable then disable supersedes the queued activation", async () => {
  let selectedValue = "On";
  let selection = 0;
  const current = setup(false, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === selectedValue);
      return undefined;
    },
  });
  await start(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  await command.handler("", current.current.ctx);
  assert.equal(
    (current.mock.sentMessages.at(-1)?.message as { customType?: string } | undefined)?.customType,
    CONTEXT_CONTRACT_MESSAGE_TYPE,
  );
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);

  selectedValue = "Off";
  selection = 0;
  const sentBeforeOptOut = current.mock.sentMessages.length;
  await command.handler("", current.current.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeOptOut);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);

  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.equal(
    (current.mock.sentMessages.at(-1)?.message as { customType?: string } | undefined)?.customType,
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  persistLastSentCustomMessage(current);
  const modelMessages = buildContextEntries(current.entries, current.entries.at(-1)?.id ?? null).flatMap(
    sessionEntryToContextMessages,
  );
  assert.equal(
    (modelMessages.at(-1) as Extract<AgentMessage, { role: "custom" }> | undefined)?.customType,
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
});

test("re-enabling after a post-deactivation compaction restores a tail activation", async () => {
  let selectedValue = "Off";
  let selection = 0;
  const current = setup(true, undefined, {
    isIdle: () => false,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === selectedValue);
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  await current.mock.events.get("agent_end")?.[0]({ type: "agent_end", messages: [] }, current.current.ctx);

  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const prepared = (await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  )) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: unknown;
    };
  };

  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  const sentBeforeOptOut = current.mock.sentMessages.length;
  await command.handler("", current.current.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeOptOut);

  const compactEntry = {
    type: "compaction",
    id: "post-deactivation-compaction",
    parentId: current.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:03.000Z",
    ...prepared.compaction,
  };
  current.entries.push(compactEntry as SessionEntry);
  await current.mock.events.get("session_compact")?.[0](
    {
      type: "session_compact",
      compactionEntry: compactEntry,
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    },
    current.current.ctx,
  );
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.equal(
    (current.mock.sentMessages.at(-1)?.message as { customType?: string } | undefined)?.customType,
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
  persistLastSentCustomMessage(current);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);

  selectedValue = "On";
  selection = 0;
  const sentBeforeReactivation = current.mock.sentMessages.length;
  await command.handler("", current.current.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeReactivation + 1);
  const activation = current.mock.sentMessages.at(-1)?.message as { customType?: string; content?: string } | undefined;
  assert.equal(activation?.customType, CONTEXT_CONTRACT_MESSAGE_TYPE);
  assert.equal(activation?.content, prepared.compaction.summary);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);

  persistLastSentCustomMessage(current);
  const modelMessages = buildContextEntries(current.entries, current.entries.at(-1)?.id ?? null).flatMap(
    sessionEntryToContextMessages,
  );
  const contextHandler = current.mock.events.get("context")?.[0];
  assert.ok(contextHandler);
  const projected = (await contextHandler({ type: "context", messages: modelMessages }, current.current.ctx)) as
    | { messages: AgentMessage[] }
    | undefined;
  assert.deepEqual(
    projected?.messages.slice(-2).map((message) => (message.role === "custom" ? message.customType : message.role)),
    [CONTEXT_DEACTIVATION_MESSAGE_TYPE, CONTEXT_CONTRACT_MESSAGE_TYPE],
  );
});

test("mid-run opt-out keeps experimental projection and compaction routing until settlement", async () => {
  let selection = 0;
  let fetches = 0;
  const current = setup(
    true,
    async () => {
      fetches += 1;
      throw new Error("remote fetch must not run");
    },
    {
      isIdle: () => false,
      select: async (_title: string, options: string[]) => {
        selection += 1;
        if (selection === 1) return options.find((option) => option.startsWith("Settings"));
        if (selection === 2) {
          return options.find((option) => option.startsWith("Experimental context management"));
        }
        if (selection === 3) return options.find((option) => option === "Off");
        return undefined;
      },
    },
  );
  const firstWindow = createInitialContextState("11111111-1111-4111-8111-111111111111");
  const kept: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "old retained prefix" }],
    timestamp: 2,
  };
  const details = createContextManagementDetails({
    lineage: firstWindow,
    keptMessages: [kept],
    reason: "threshold",
    windowId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-01-01T00:00:03.000Z",
  });
  const compactEntry: SessionEntry = {
    type: "compaction",
    id: "existing-compaction",
    parentId: "user",
    timestamp: "2026-01-01T00:00:03.000Z",
    summary: contextContract(details),
    firstKeptEntryId: "user",
    tokensBefore: 90,
    details,
  };
  current.setBranch([messageEntry(), compactEntry]);
  await start(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  const sentBeforeOptOut = current.mock.sentMessages.length;
  await command.handler("", current.current.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeOptOut);

  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: contextContract(details),
    tokensBefore: 90,
    timestamp: 3,
  };
  const later: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "new window tail" }],
    timestamp: 4,
  };
  const contextHandler = current.mock.events.get("context")?.[0];
  assert.ok(contextHandler);
  const projected = (await contextHandler(
    { type: "context", messages: [summary, kept, later] },
    current.current.ctx,
  )) as { messages: AgentMessage[] } | undefined;
  assert.deepEqual(projected?.messages, [summary, later]);

  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const routed = (await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  )) as { compaction: { summary: string } } | undefined;
  assert.match(routed?.compaction.summary ?? "", /PI_CONTEXT_MANAGEMENT_WINDOW/);
  assert.equal(fetches, 0);

  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.equal(
    (current.mock.sentMessages.at(-1)?.message as { customType?: string } | undefined)?.customType,
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
});

test.each(["success", "failure"] as const)(
  "standalone compaction %s does not defer experimental tool removal",
  async (outcome) => {
    let selection = 0;
    const current = setup(true, undefined, {
      isIdle: () => false,
      select: async (_title: string, options: string[]) => {
        selection += 1;
        if (selection === 1) return options.find((option) => option.startsWith("Settings"));
        if (selection === 2) {
          return options.find((option) => option.startsWith("Experimental context management"));
        }
        if (selection === 3) return options.find((option) => option === "Off");
        return undefined;
      },
    });
    await start(current);
    persistLastSentCustomMessage(current);
    const before = current.mock.events.get("session_before_compact")?.[0];
    assert.ok(before);
    const result = (await before(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "user",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 90,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
        },
        branchEntries: current.entries,
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      current.current.ctx,
    )) as { compaction: { summary: string; details: unknown } };

    const command = current.mock.commands.get("context-management");
    assert.ok(command);
    await command.handler("", current.current.ctx);
    assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);

    if (outcome === "success") {
      const compactEntry = {
        type: "compaction",
        id: "standalone-compaction",
        parentId: current.entries.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:03.000Z",
        firstKeptEntryId: "user",
        tokensBefore: 90,
        ...result.compaction,
      };
      current.entries.push(compactEntry as SessionEntry);
      await current.mock.events.get("session_compact")?.[0](
        {
          type: "session_compact",
          compactionEntry: compactEntry,
          fromExtension: true,
          reason: "manual",
          willRetry: false,
        },
        current.current.ctx,
      );
    } else {
      await current.mock.events.get("session_compact_failed")?.[0](
        {
          type: "session_compact_failed",
          reason: "manual",
          aborted: false,
          willRetry: false,
          fromExtension: true,
          errorMessage: "standalone failure",
        },
        current.current.ctx,
      );
    }
    assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  },
);

test.each(["context", "compaction"] as const)(
  "an incomplete active tool unit deactivates and falls back at the %s boundary",
  async (boundary) => {
    const current = setup();
    await start(current);
    persistLastSentCustomMessage(current);
    current.mock.rawPi.setActiveTools(["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES.slice(0, -1)]);

    if (boundary === "context") {
      const handler = current.mock.events.get("context")?.[0];
      assert.ok(handler);
      const messages = current.entries.flatMap(sessionEntryToContextMessages);
      const result = (await handler({ type: "context", messages }, current.current.ctx)) as
        | { messages?: Array<{ role?: string; customType?: string }> }
        | undefined;
      assert.equal(result?.messages?.at(-1)?.role, "custom");
      assert.equal(result?.messages?.at(-1)?.customType, CONTEXT_DEACTIVATION_MESSAGE_TYPE);
    } else {
      const handler = current.mock.events.get("session_before_compact")?.[0];
      assert.ok(handler);
      const result = await handler(
        {
          type: "session_before_compact",
          preparation: {
            firstKeptEntryId: "user",
            messagesToSummarize: [],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 90,
            fileOps: { read: new Set(), written: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
          },
          branchEntries: current.entries,
          reason: "threshold",
          willRetry: false,
          signal: new AbortController().signal,
        },
        current.current.ctx,
      );
      assert.equal(result, undefined);
    }

    const deactivations = current.mock.sentMessages.filter(
      (item) => (item.message as { customType?: string }).customType === CONTEXT_DEACTIVATION_MESSAGE_TYPE,
    );
    assert.equal(deactivations.length, 1);
    assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
    assert.match(current.current.notifications.at(-1)?.message ?? "", /inactive/);
    await assert.rejects(
      tool(current, "context_management_get_context_remaining").execute(
        "stale-call",
        {},
        undefined,
        undefined,
        current.current.ctx,
      ),
      /disabled/,
    );
  },
);

test.each(["context", "compaction"] as const)(
  "an incomplete tool unit preserves a pending rollover failure at the %s boundary",
  async (boundary) => {
    const current = setup();
    await start(current);
    persistLastSentCustomMessage(current);
    await tool(current, "context_management_start_new_context").execute(
      "pending-rollover",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    current.mock.rawPi.setActiveTools(["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES.slice(0, -1)]);

    if (boundary === "context") {
      const handler = current.mock.events.get("context")?.[0];
      assert.ok(handler);
      await handler(
        { type: "context", messages: current.entries.flatMap(sessionEntryToContextMessages) },
        current.current.ctx,
      );
    } else {
      const handler = current.mock.events.get("session_before_compact")?.[0];
      assert.ok(handler);
      assert.equal(
        await handler(
          {
            type: "session_before_compact",
            preparation: {
              firstKeptEntryId: "user",
              messagesToSummarize: [],
              turnPrefixMessages: [],
              isSplitTurn: false,
              tokensBefore: 90,
              fileOps: { read: new Set(), written: new Set(), edited: new Set() },
              settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
            },
            branchEntries: current.entries,
            reason: "threshold",
            willRetry: false,
            signal: new AbortController().signal,
          },
          current.current.ctx,
        ),
        undefined,
      );
    }

    const settled = current.mock.events.get("agent_settled")?.[0];
    assert.ok(settled);
    await settled({ type: "agent_settled" }, current.current.ctx);
    await settled({ type: "agent_settled" }, current.current.ctx);
    const continuations = current.mock.sentMessages.filter(
      (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
    );
    assert.equal(continuations.length, 1);
    assert.match(JSON.stringify(continuations[0]), /rollover failed.*tool unit/is);
  },
);

test("tool-unit loss after compaction preserves an accurate successful continuation", async () => {
  const current = setup();
  await start(current);
  persistLastSentCustomMessage(current);
  await tool(current, "context_management_start_new_context").execute(
    "pending-rollover",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  await emitAutomaticCompaction(current);
  current.mock.rawPi.setActiveTools(["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES.slice(0, -1)]);
  const context = current.mock.events.get("context")?.[0];
  assert.ok(context);
  await context(
    { type: "context", messages: current.entries.flatMap(sessionEntryToContextMessages) },
    current.current.ctx,
  );

  const settled = current.mock.events.get("agent_settled")?.[0];
  assert.ok(settled);
  await settled({ type: "agent_settled" }, current.current.ctx);
  const continuations = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  );
  assert.equal(continuations.length, 1);
  assert.match(JSON.stringify(continuations[0]), /is now active.*tools became unavailable/is);
  assert.doesNotMatch(JSON.stringify(continuations[0]), /Use context_management_recall_context/);
});

test.each(["different description", "matching description"] as const)(
  "a foreign-source collision with a %s prevents activation without disabling it",
  async (description) => {
    const current = setup();
    const getAllTools = current.mock.rawPi.getAllTools.bind(current.mock.rawPi);
    current.mock.rawPi.getAllTools = () =>
      getAllTools().map((toolInfo) => {
        const tool = toolInfo as {
          name?: string;
          description?: string;
          sourceInfo: { path: string };
        };
        if (tool.name !== "context_management_start_new_context") return tool;
        return {
          ...tool,
          ...(description === "different description" ? { description: "Another extension owns this tool." } : {}),
          sourceInfo: {
            ...tool.sourceInfo,
            path: resolve("packages/pi-context-management/src/context-tools.ts"),
          },
        };
      });
    current.mock.rawPi.setActiveTools(["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);
    await start(current);
    assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", "context_management_start_new_context"]);
    assert.equal(current.mock.sentMessages.length, 0);
    assert.match(current.current.notifications[0]?.message ?? "", /could not activate/);
  },
);

test("resumed active contracts deactivate when the complete tool unit cannot activate", async () => {
  const current = setup();
  const lineage = createInitialContextState("11111111-1111-4111-8111-111111111111");
  current.entries.push(
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: lineage,
      id: "persisted-state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "message",
      id: "persisted-contract",
      parentId: "persisted-state",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "custom",
        customType: CONTEXT_CONTRACT_MESSAGE_TYPE,
        content: contextContract(lineage),
        display: false,
        timestamp: 2,
      },
    },
  );
  const getAllTools = current.mock.rawPi.getAllTools.bind(current.mock.rawPi);
  current.mock.rawPi.getAllTools = () =>
    getAllTools().map((toolInfo) => {
      const tool = toolInfo as { name?: string; sourceInfo: { path: string } };
      if (tool.name !== "context_management_start_new_context") return tool;
      return {
        ...tool,
        sourceInfo: {
          ...tool.sourceInfo,
          path: resolve("packages/pi-context-management/src/context-tools.ts"),
        },
      };
    });
  current.mock.rawPi.setActiveTools(["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);

  await start(current);
  assert.equal(
    (current.mock.sentMessages.at(-1)?.message as { customType?: string } | undefined)?.customType,
    CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  );
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", "context_management_start_new_context"]);
});

test("tree navigation reloads branch lineage and releases old-branch rollover state", async () => {
  const current = setup();
  const oldLineage = createInitialContextState("11111111-1111-4111-8111-111111111111");
  current.entries.push({
    type: "custom",
    customType: CONTEXT_STATE_ENTRY_TYPE,
    data: oldLineage,
    id: "old-state",
    parentId: "user",
    timestamp: "2026-01-01T00:00:01.000Z",
  });
  await start(current);
  await tool(current, "context_management_start_new_context").execute(
    "old-request",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.ok(current.compactOptions);

  const newLineage = createInitialContextState("22222222-2222-4222-8222-222222222222");
  current.setBranch([
    messageEntry(),
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: newLineage,
      id: "new-state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:02.000Z",
    },
  ]);
  const tree = current.mock.events.get("session_tree")?.[0];
  assert.ok(tree);
  await tree({ type: "session_tree", oldLeafId: "old-state", newLeafId: "new-state" }, current.current.ctx);
  const sentAfterNavigation = current.mock.sentMessages.length;
  current.compactOptions.onError?.(new Error("stale old-branch failure"));
  assert.equal(current.mock.sentMessages.length, sentAfterNavigation);

  const retried = await tool(current, "context_management_start_new_context").execute(
    "new-request",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  assert.equal(retried.content[0].text.includes(newLineage.currentWindowId), true);
  assert.equal(retried.content[0].text.includes(oldLineage.currentWindowId), false);
  assert.equal(
    (current.mock.sentMessages.at(-1)?.message as { details?: { currentWindowId?: string } } | undefined)?.details
      ?.currentWindowId,
    newLineage.currentWindowId,
  );
});

test.each(["message", "compaction"] as const)(
  "disabled mode appends a deactivation transition after an experimental %s marker",
  async (marker) => {
    const current = setup(false);
    const lineage = createInitialContextState("11111111-1111-4111-8111-111111111111");
    if (marker === "message") {
      current.entries.push({
        type: "message",
        id: "contract",
        parentId: "user",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "custom",
          customType: CONTEXT_CONTRACT_MESSAGE_TYPE,
          content: contextContract(lineage),
          display: false,
          timestamp: 2,
        },
      });
    } else {
      const details = createContextManagementDetails({
        lineage,
        keptMessages: [],
        reason: "manual",
        windowId: "22222222-2222-4222-8222-222222222222",
      });
      current.entries.push({
        type: "compaction",
        id: "compaction",
        parentId: "user",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: contextContract(details),
        firstKeptEntryId: "user",
        tokensBefore: 10,
        details,
      });
    }
    await start(current);
    const transition = current.mock.sentMessages.at(-1)?.message as { customType?: string } | undefined;
    assert.equal(transition?.customType, CONTEXT_DEACTIVATION_MESSAGE_TYPE);
    assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
  },
);

test("usage and notes tools remain observational and branch-persistent", async () => {
  const current = setup();
  await start(current);
  const usage = await tool(current, "context_management_get_context_remaining").execute(
    "usage",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  assert.match(usage.content[0].text, /"remainingTokens": 75/);
  const lineage = current.entries.find(
    (entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE,
  );
  assert.ok(lineage?.type === "custom");
  const history = await tool(current, "context_management_recall_context").execute(
    "history",
    { source: "history", action: "list" },
    undefined,
    undefined,
    current.current.ctx,
  );
  assert.match(history.content[0].text, new RegExp((lineage.data as { firstWindowId: string }).firstWindowId));
  await tool(current, "context_management_update_notes").execute(
    "note",
    { action: "write", note: "decision", content: "Use OAuth" },
    undefined,
    undefined,
    current.current.ctx,
  );
  const recalled = await tool(current, "context_management_recall_context").execute(
    "recall",
    { source: "notes", action: "read", id: "decision" },
    undefined,
    undefined,
    current.current.ctx,
  );
  assert.match(recalled.content[0].text, /Use OAuth/);
});

test("history search excludes the assistant message executing the active recall batch", async () => {
  const current = setup();
  await start(current);
  const query = "unique current recall query";
  current.setBranch([
    ...current.entries,
    {
      type: "message",
      id: "active-recall-batch",
      parentId: current.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "active-recall",
            name: "context_management_recall_context",
            arguments: { source: "history", action: "search", query },
          },
          {
            type: "toolCall",
            id: "parallel-recall",
            name: "context_management_recall_context",
            arguments: { source: "history", action: "search", query },
          },
        ],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 3,
      },
    },
  ]);

  const recalled = await tool(current, "context_management_recall_context").execute(
    "active-recall",
    { source: "history", action: "search", query },
    undefined,
    undefined,
    current.current.ctx,
  );
  assert.deepEqual((recalled.details as { items?: unknown[] } | undefined)?.items, []);
  assert.doesNotMatch(recalled.content[0].text, /active-recall-batch/);
});

test("cancelled note updates publish no session mutation", async () => {
  const current = setup();
  await start(current);
  const controller = new AbortController();
  controller.abort();
  const before = current.mock.entries.length;
  await assert.rejects(
    tool(current, "context_management_update_notes").execute(
      "note",
      { action: "write", note: "cancelled", content: "not stored" },
      controller.signal,
      undefined,
      current.current.ctx,
    ),
    /aborted/i,
  );
  assert.equal(current.mock.entries.length, before);
});

test.each(["signal", "assistant response"] as const)(
  "an aborted agent run detected from its $source cancels the requested rollover",
  async (source) => {
    const runController = new AbortController();
    const current = setup(true, undefined, source === "signal" ? { signal: runController.signal } : {});
    await start(current);
    await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);
    const accepted = await tool(current, "context_management_start_new_context").execute(
      "start",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    persistToolResult(current, "start", accepted);
    if (source === "signal") runController.abort();
    const agentEnd = current.mock.events.get("agent_end")?.[0];
    assert.ok(agentEnd);
    await agentEnd(
      {
        type: "agent_end",
        messages: source === "assistant response" ? [abortedAssistantMessage()] : [],
      },
      current.current.ctx,
    );
    (current.current.ctx as unknown as { signal?: AbortSignal }).signal = undefined;
    await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
    assert.equal(current.compactOptions, undefined);
    assert.equal(
      current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
        .length,
      0,
    );
    assert.equal(
      current.entries.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-context-management-rollover" &&
          (entry.data as { status?: string }).status === "cancelled",
      ),
      true,
    );
    await current.mock.events.get("session_shutdown")?.[0](
      { type: "session_shutdown", reason: "reload" },
      current.current.ctx,
    );
    await start(current);
    assert.equal(current.compactOptions, undefined);
    await tool(current, "context_management_start_new_context").execute(
      "retry",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
  },
);

test("context_management_start_new_context compacts after settlement and continues exactly once", async () => {
  const current = setup();
  await start(current);
  const started = await tool(current, "context_management_start_new_context").execute(
    "start",
    { reason: "fresh budget" },
    undefined,
    undefined,
    current.current.ctx,
  );
  assert.equal(started.terminate, true);
  assert.match(started.content[0].text, /unless a later successful turn already continued the work/);
  const settled = current.mock.events.get("agent_settled")?.[0];
  assert.ok(settled);
  await settled({ type: "agent_settled" }, current.current.ctx);
  assert.ok(current.compactOptions);

  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "user",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 90,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
    },
    branchEntries: current.entries,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
  const result = (await before(event, current.current.ctx)) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: unknown;
    };
  };
  assert.match(result.compaction.summary, /PI_CONTEXT_MANAGEMENT_WINDOW/);
  const compactEntry = {
    type: "compaction",
    id: "compact",
    parentId: current.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:02.000Z",
    ...result.compaction,
  };
  current.entries.push(compactEntry as SessionEntry);
  const compacted = current.mock.events.get("session_compact")?.[0];
  assert.ok(compacted);
  await compacted(
    {
      type: "session_compact",
      compactionEntry: compactEntry,
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    },
    current.current.ctx,
  );
  current.compactOptions?.onComplete?.(result.compaction);
  current.compactOptions?.onComplete?.(result.compaction);
  const continuations = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  );
  assert.equal(continuations.length, 1);
  assert.equal((continuations[0].options as { deliverAs?: string } | undefined)?.deliverAs, undefined);
  assert.match(JSON.stringify(continuations[0]), /fresh budget/);
});

test("a cancelled manual compaction releases the rollover without continuing", async () => {
  const current = setup();
  await start(current);
  const accepted = await tool(current, "context_management_start_new_context").execute(
    "start",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  persistToolResult(current, "start", accepted);
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.ok(current.compactOptions);
  const notificationCount = current.current.notifications.length;
  await current.mock.events.get("session_compact_failed")?.[0](
    {
      type: "session_compact_failed",
      reason: "manual",
      aborted: true,
      willRetry: false,
      fromExtension: true,
    },
    current.current.ctx,
  );
  current.compactOptions.onError?.(new Error("Compaction cancelled"));
  assert.equal(
    current.entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-context-management-rollover" &&
        (entry.data as { status?: string }).status === "cancelled",
    ),
    true,
  );
  assert.equal(current.current.notifications.length, notificationCount);
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    0,
  );
  await tool(current, "context_management_start_new_context").execute(
    "retry",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
});

test.each([
  { scenario: "the persisted summary is replaced", emitCompact: true },
  { scenario: "the session_compact event is missing", emitCompact: false },
])("a manual rollover fails when $scenario", async ({ emitCompact }) => {
  const current = setup();
  await start(current);
  const state = current.entries.find(
    (entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE,
  );
  assert.ok(state?.type === "custom");
  const oldWindowId = (state.data as { currentWindowId: string }).currentWindowId;
  await tool(current, "context_management_start_new_context").execute(
    "start",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.ok(current.compactOptions);

  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const result = (await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  )) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: unknown;
    };
  };
  const persisted = { ...result.compaction, summary: "Replacement summary" };
  if (emitCompact) {
    const compactEntry = {
      type: "compaction",
      id: "replaced-manual",
      parentId: current.entries.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:02.000Z",
      ...persisted,
    };
    current.entries.push(compactEntry as SessionEntry);
    await current.mock.events.get("session_compact")?.[0](
      {
        type: "session_compact",
        compactionEntry: compactEntry,
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      },
      current.current.ctx,
    );
  }
  current.compactOptions.onComplete?.(emitCompact ? persisted : result.compaction);

  const continuations = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  );
  assert.equal(continuations.length, 1);
  assert.match(JSON.stringify(continuations[0]), /rollover failed/);
  assert.doesNotMatch(JSON.stringify(continuations[0]), /is now active/);
  const retried = await tool(current, "context_management_start_new_context").execute(
    "retry",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  assert.match(retried.content[0].text, new RegExp(oldWindowId));
});

test("context-management compaction takes precedence without a remote request", async () => {
  let fetches = 0;
  const current = setup(true, async () => {
    fetches += 1;
    throw new Error("remote fetch must not run");
  });
  await start(current);
  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const result = (await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "overflow",
      willRetry: true,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  )) as { compaction: { summary: string; details: { reason: string } } };
  assert.equal(fetches, 0);
  assert.equal(result.compaction.details.reason, "overflow");
  assert.doesNotMatch(result.compaction.summary, /hello/);
});

test("automatic compaction consumes a pending request before settlement", async () => {
  const current = setup();
  await start(current);
  await tool(current, "context_management_start_new_context").execute(
    "start",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "user",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 90,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
    },
    branchEntries: current.entries,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  };
  const result = (await before(event, current.current.ctx)) as {
    compaction: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: unknown;
    };
  };
  const compactEntry = {
    type: "compaction",
    id: "automatic",
    parentId: current.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:03.000Z",
    ...result.compaction,
  };
  current.entries.push(compactEntry as SessionEntry);
  await current.mock.events.get("session_compact")?.[0](
    {
      type: "session_compact",
      compactionEntry: compactEntry,
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    },
    current.current.ctx,
  );
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.equal(current.compactOptions, undefined);
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    1,
  );
});

test.each([
  { stopReason: "stop" as const, expectedContinuations: 0 },
  { stopReason: "toolUse" as const, expectedContinuations: 0 },
  { stopReason: "length" as const, expectedContinuations: 1 },
  { stopReason: "error" as const, expectedContinuations: 1 },
])(
  "a completed rollover survives a later compaction after a $stopReason turn",
  async ({ stopReason, expectedContinuations }) => {
    const current = setup();
    await start(current);
    await tool(current, "context_management_start_new_context").execute(
      "start",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    const first = await emitAutomaticCompaction(current);
    const firstDetails = first.result.compaction.details as {
      requestId?: string;
      currentWindowId: string;
    };
    assert.ok(firstDetails.requestId);

    await current.mock.events.get("turn_start")?.[0](
      { type: "turn_start", turnIndex: 1, timestamp: Date.now() },
      current.current.ctx,
    );
    await current.mock.events.get("agent_end")?.[0](
      { type: "agent_end", messages: [assistantMessage(stopReason)] },
      current.current.ctx,
    );

    const second = await emitAutomaticCompaction(current);
    const secondDetails = second.result.compaction.details as {
      requestId?: string;
      previousWindowId: string;
      currentWindowId: string;
    };
    assert.equal(secondDetails.requestId, undefined);
    assert.equal(secondDetails.previousWindowId, firstDetails.currentWindowId);
    assert.notEqual(secondDetails.currentWindowId, secondDetails.previousWindowId);

    await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
    const continuations = current.mock.sentMessages.filter(
      (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
    );
    assert.equal(continuations.length, expectedContinuations);
    if (expectedContinuations > 0) {
      const continuation = continuations[0];
      assert.ok(continuation);
      assert.equal(
        (continuation.message as { details?: { currentWindowId?: string } }).details?.currentWindowId,
        secondDetails.currentWindowId,
      );
    }
  },
);

test("a failed rollover survives a later compaction until settlement", async () => {
  const current = setup();
  await start(current);
  await tool(current, "context_management_start_new_context").execute(
    "start",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  await emitAutomaticCompaction(current, null);

  const later = await emitAutomaticCompaction(current);
  assert.equal((later.result.compaction.details as { requestId?: string }).requestId, undefined);
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);

  const continuations = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  );
  assert.equal(continuations.length, 1);
  assert.match(JSON.stringify(continuations[0]), /rollover failed/);
});

test.each([
  { stopReason: "stop" as const, expectedContinuations: 0 },
  { stopReason: "toolUse" as const, expectedContinuations: 0 },
  { stopReason: "length" as const, expectedContinuations: 1 },
  { stopReason: "error" as const, expectedContinuations: 1 },
  { stopReason: "aborted" as const, expectedContinuations: 0 },
])(
  "a post-compaction Pi turn ending with $stopReason sends $expectedContinuations fallback continuations",
  async ({ stopReason, expectedContinuations }) => {
    const current = setup();
    await start(current);
    await tool(current, "context_management_start_new_context").execute(
      "start",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    await emitAutomaticCompaction(current);
    await current.mock.events.get("turn_start")?.[0](
      { type: "turn_start", turnIndex: 1, timestamp: Date.now() },
      current.current.ctx,
    );
    await current.mock.events.get("agent_end")?.[0](
      { type: "agent_end", messages: [assistantMessage(stopReason)] },
      current.current.ctx,
    );
    await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
    assert.equal(
      current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
        .length,
      expectedContinuations,
    );
  },
);

test.each(["success", "failure"] as const)(
  "a successful turn after a rollover request suppresses the %s fallback continuation",
  async (outcome) => {
    const current = setup();
    await start(current);
    await tool(current, "context_management_start_new_context").execute(
      "start",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    await current.mock.events.get("turn_start")?.[0](
      { type: "turn_start", turnIndex: 1, timestamp: Date.now() },
      current.current.ctx,
    );
    await current.mock.events.get("agent_end")?.[0](
      { type: "agent_end", messages: [assistantMessage("stop")] },
      current.current.ctx,
    );
    await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
    assert.ok(current.compactOptions);
    if (outcome === "failure") {
      current.compactOptions.onError?.(new Error("mixed batch compaction failed"));
    } else {
      await completeRequestedCompaction(current);
    }
    assert.equal(
      current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
        .length,
      0,
    );
    await tool(current, "context_management_start_new_context").execute(
      "retry",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
  },
);

test.each([
  { stopReason: "error" as const, compactionOutcome: "success" as const },
  { stopReason: "error" as const, compactionOutcome: "failure" as const },
  { stopReason: "length" as const, compactionOutcome: "success" as const },
  { stopReason: "length" as const, compactionOutcome: "failure" as const },
])(
  "an unsuccessful $stopReason turn sends a continuation after compaction $compactionOutcome",
  async ({ stopReason, compactionOutcome }) => {
    const current = setup();
    await start(current);
    await tool(current, "context_management_start_new_context").execute(
      "start",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    await current.mock.events.get("turn_start")?.[0](
      { type: "turn_start", turnIndex: 1, timestamp: Date.now() },
      current.current.ctx,
    );
    await current.mock.events.get("agent_end")?.[0](
      { type: "agent_end", messages: [assistantMessage(stopReason)] },
      current.current.ctx,
    );
    await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
    assert.ok(current.compactOptions);
    if (compactionOutcome === "failure") {
      current.compactOptions.onError?.(new Error("mixed batch compaction failed"));
    } else {
      await completeRequestedCompaction(current);
    }
    const continuations = current.mock.sentMessages.filter(
      (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
    );
    assert.equal(continuations.length, 1);
    assert.match(
      JSON.stringify(continuations[0]),
      compactionOutcome === "success" ? /is now active/ : /rollover failed/,
    );
  },
);

test.each(["missing", "mismatched"] as const)(
  "a replaced compaction result with %s details fails and releases the pending rollover",
  async (replacement) => {
    const current = setup();
    await start(current);
    await tool(current, "context_management_start_new_context").execute(
      "start",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    await emitAutomaticCompaction(
      current,
      replacement === "missing"
        ? null
        : (details: unknown) => ({
            ...(details as Record<string, unknown>),
            requestId: "different-request-id",
          }),
    );
    await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
    assert.match(JSON.stringify(current.mock.sentMessages.at(-1)), /without the requested context marker/);
    await tool(current, "context_management_start_new_context").execute(
      "retry",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
  },
);

test("a cancelled automatic rollover releases the request without continuing", async () => {
  const current = setup();
  await start(current);
  const notificationCount = current.current.notifications.length;
  await tool(current, "context_management_start_new_context").execute(
    "start",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  );
  await current.mock.events.get("session_compact_failed")?.[0](
    {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: true,
      willRetry: false,
      fromExtension: true,
    },
    current.current.ctx,
  );
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    0,
  );
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.equal(current.current.notifications.length, notificationCount);
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    0,
  );
  await tool(current, "context_management_start_new_context").execute(
    "retry",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
});

test("concurrent headless session managers keep independent rollover ownership", async () => {
  const current = setup();
  await start(current);
  await tool(current, "context_management_start_new_context").execute(
    "first-rollover",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );

  const secondLineage = createInitialContextState("22222222-2222-4222-8222-222222222222");
  const secondEntries: SessionEntry[] = [
    messageEntry(),
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: secondLineage,
      id: "second-state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
  ];
  const second = createMockContext({
    mode: "print",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "second-context-session",
      getSessionName: () => undefined,
      getBranch: () => secondEntries,
      getEntries: () => secondEntries,
    },
    compact: () => assert.fail("The second session must not receive the first session's rollover"),
  });
  const sessionStart = current.mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, second.ctx);

  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.ok(current.compactOptions);
  await current.mock.events.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "quit" }, second.ctx);
  const context = current.mock.events.get("context")?.[0];
  assert.ok(context);
  const projected = await context(
    { type: "context", messages: current.entries.flatMap(sessionEntryToContextMessages) },
    current.current.ctx,
  );
  assert.ok(projected);
});

test("idle non-initiating sessions persist deactivation before later turns", async () => {
  let selection = 0;
  const current = setup(true, undefined, {
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (selection === 3) return options.find((option) => option === "Off");
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);

  const secondLineage = createInitialContextState("22222222-2222-4222-8222-222222222222");
  const secondEntries: SessionEntry[] = [
    messageEntry(),
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: secondLineage,
      id: "second-state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
  ];
  const second = createMockContext({
    mode: "print",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "second-context-session",
      getSessionName: () => undefined,
      getBranch: () => secondEntries,
      getEntries: () => secondEntries,
    },
  });
  const sessionStart = current.mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, second.ctx);
  persistSentCustomMessage(secondEntries, current.mock.sentMessages.at(-1)?.message);

  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  await command.handler("", current.current.ctx);
  const sentBeforeSecondInput = current.mock.sentMessages.length;
  const input = current.mock.events.get("input")?.[0];
  assert.ok(input);
  await input({ source: "interactive", text: "later" }, second.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeSecondInput + 1);
  persistSentCustomMessage(secondEntries, current.mock.sentMessages.at(-1)?.message);
  secondEntries.push({
    type: "message",
    id: "second-later-turn",
    parentId: secondEntries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "user", content: [{ type: "text", text: "later" }], timestamp: 3 },
  });
  await input({ source: "interactive", text: "another turn" }, second.ctx);
  assert.equal(current.mock.sentMessages.length, sentBeforeSecondInput + 1);

  const context = current.mock.events.get("context")?.[0];
  assert.ok(context);
  assert.equal(
    await context({ type: "context", messages: secondEntries.flatMap(sessionEntryToContextMessages) }, second.ctx),
    undefined,
  );
  assert.equal(current.mock.sentMessages.length, sentBeforeSecondInput + 1);
  const durableDeactivation = secondEntries.at(-2);
  assert.ok(durableDeactivation?.type === "message" && durableDeactivation.message.role === "custom");
  assert.equal(durableDeactivation.message.customType, CONTEXT_DEACTIVATION_MESSAGE_TYPE);
});

test("global tool removal waits for every active session to settle", async () => {
  const current = setup();
  await start(current);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("agent_start")?.[0]({ type: "agent_start" }, current.current.ctx);

  let selection = 0;
  const secondLineage = createInitialContextState("22222222-2222-4222-8222-222222222222");
  const secondEntries: SessionEntry[] = [
    messageEntry(),
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: secondLineage,
      id: "second-state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
  ];
  const second = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) return options.find((option) => option.startsWith("Experimental context management"));
      if (selection === 3) return options.find((option) => option === "Off");
      return undefined;
    },
    sessionManager: {
      getSessionId: () => "second-context-session",
      getSessionName: () => undefined,
      getBranch: () => secondEntries,
      getEntries: () => secondEntries,
    },
  });
  const sessionStart = current.mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, second.ctx);
  const command = current.mock.commands.get("context-management");
  assert.ok(command);

  await command.handler("", second.ctx);

  assert.equal(current.runtime.get().settings.enabled, false);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);
  await assert.doesNotReject(() =>
    tool(current, "context_management_get_context_remaining").execute(
      "active-session-call",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
  );
  await assert.rejects(
    tool(current, "context_management_get_context_remaining").execute(
      "idle-session-call",
      {},
      undefined,
      undefined,
      second.ctx,
    ),
    /disabled/,
  );

  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
});

test("an incomplete global tool unit deactivates every active session contract", async () => {
  const current = setup();
  await start(current);
  persistLastSentCustomMessage(current);

  const secondLineage = createInitialContextState("22222222-2222-4222-8222-222222222222");
  const secondEntries: SessionEntry[] = [
    messageEntry(),
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: secondLineage,
      id: "second-state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
  ];
  const second = createMockContext({
    mode: "print",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "second-context-session",
      getSessionName: () => undefined,
      getBranch: () => secondEntries,
      getEntries: () => secondEntries,
    },
  });
  const sessionStart = current.mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, second.ctx);
  persistSentCustomMessage(secondEntries, current.mock.sentMessages.at(-1)?.message);

  current.mock.rawPi.setActiveTools(["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES.slice(0, -1)]);
  const context = current.mock.events.get("context")?.[0];
  assert.ok(context);
  const firstProjection = (await context(
    { type: "context", messages: current.entries.flatMap(sessionEntryToContextMessages) },
    current.current.ctx,
  )) as { messages: AgentMessage[] } | undefined;
  const secondProjection = (await context(
    { type: "context", messages: secondEntries.flatMap(sessionEntryToContextMessages) },
    second.ctx,
  )) as { messages: AgentMessage[] } | undefined;

  const firstDeactivation = firstProjection?.messages.at(-1);
  assert.ok(firstDeactivation?.role === "custom");
  assert.equal(firstDeactivation.customType, CONTEXT_DEACTIVATION_MESSAGE_TYPE);
  const secondDeactivation = secondProjection?.messages.at(-1);
  assert.ok(secondDeactivation?.role === "custom");
  assert.equal(secondDeactivation.customType, CONTEXT_DEACTIVATION_MESSAGE_TYPE);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
});

test("global re-enable restores activation in every deactivated session", async () => {
  let requestedValue: "Off" | "On" = "Off";
  let menuStep = 0;
  const current = setup(true, undefined, {
    select: async (_title: string, options: string[]) => {
      menuStep += 1;
      if (menuStep % 4 === 1) return options.find((option) => option.startsWith("Settings"));
      if (menuStep % 4 === 2) {
        return options.find((option) => option.startsWith("Experimental context management"));
      }
      if (menuStep % 4 === 3) return options.find((option) => option === requestedValue);
      return undefined;
    },
  });
  await start(current);
  persistLastSentCustomMessage(current);

  const secondLineage = createInitialContextState("22222222-2222-4222-8222-222222222222");
  const secondEntries: SessionEntry[] = [
    messageEntry(),
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: secondLineage,
      id: "second-state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
  ];
  const second = createMockContext({
    mode: "print",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "second-context-session",
      getSessionName: () => undefined,
      getBranch: () => secondEntries,
      getEntries: () => secondEntries,
    },
  });
  const sessionStart = current.mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, second.ctx);
  persistSentCustomMessage(secondEntries, current.mock.sentMessages.at(-1)?.message);

  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  await command.handler("", current.current.ctx);
  persistLastSentCustomMessage(current);
  const input = current.mock.events.get("input")?.[0];
  assert.ok(input);
  await input({ source: "interactive", text: "persist deactivation" }, second.ctx);
  persistSentCustomMessage(secondEntries, current.mock.sentMessages.at(-1)?.message);
  const persistedDeactivation = secondEntries.at(-1);
  assert.ok(persistedDeactivation?.type === "message" && persistedDeactivation.message.role === "custom");
  assert.equal(persistedDeactivation.message.customType, CONTEXT_DEACTIVATION_MESSAGE_TYPE);

  requestedValue = "On";
  menuStep = 0;
  await command.handler("", current.current.ctx);
  assert.equal(current.runtime.get().settings.enabled, true);
  persistLastSentCustomMessage(current);
  const context = current.mock.events.get("context")?.[0];
  assert.ok(context);
  const projection = (await context(
    { type: "context", messages: secondEntries.flatMap(sessionEntryToContextMessages) },
    second.ctx,
  )) as { messages: AgentMessage[] } | undefined;
  const projectedActivation = projection?.messages.at(-1);
  assert.ok(projectedActivation?.role === "custom");
  assert.equal(projectedActivation.customType, CONTEXT_CONTRACT_MESSAGE_TYPE);
  persistSentCustomMessage(secondEntries, current.mock.sentMessages.at(-1)?.message);
  const sentAfterActivation = current.mock.sentMessages.length;
  assert.equal(
    await context({ type: "context", messages: secondEntries.flatMap(sessionEntryToContextMessages) }, second.ctx),
    undefined,
  );
  assert.equal(current.mock.sentMessages.length, sentAfterActivation);
});

test("global re-enable leaves a foreign no-lineage session inactive without scoped persistence", async () => {
  let selection = 0;
  const current = setup(false, undefined, {
    select: async (_title: string, options: string[]) => {
      selection += 1;
      if (selection === 1) return options.find((option) => option.startsWith("Settings"));
      if (selection === 2) return options.find((option) => option.startsWith("Experimental context management"));
      if (selection === 3) return options.find((option) => option === "On");
      return undefined;
    },
  });
  await start(current);

  const secondEntries: SessionEntry[] = [messageEntry()];
  const second = createMockContext({
    mode: "print",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "second-context-session",
      getSessionName: () => undefined,
      getBranch: () => secondEntries,
      getEntries: () => secondEntries,
    },
    getContextUsage: () => ({ tokens: 25, contextWindow: 100, percent: 25 }),
  });
  const sessionStart = current.mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, second.ctx);

  const command = current.mock.commands.get("context-management");
  assert.ok(command);
  await command.handler("", current.current.ctx);
  assert.equal(current.runtime.get().settings.enabled, true);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read", ...CONTEXT_MANAGEMENT_TOOL_NAMES]);

  const context = current.mock.events.get("context")?.[0];
  assert.ok(context);
  const sentBeforeProjection = current.mock.sentMessages.length;
  const currentLineagesBeforeProjection = current.entries.filter(
    (entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE,
  ).length;
  assert.equal(
    await context({ type: "context", messages: secondEntries.flatMap(sessionEntryToContextMessages) }, second.ctx),
    undefined,
  );
  assert.equal(current.mock.sentMessages.length, sentBeforeProjection);
  assert.equal(
    current.entries.filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE).length,
    currentLineagesBeforeProjection,
  );
  assert.equal(
    secondEntries.filter((entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE).length,
    0,
  );
  await assert.rejects(
    tool(current, "context_management_get_context_remaining").execute(
      "second-session-usage",
      {},
      undefined,
      undefined,
      second.ctx,
    ),
    /disabled/,
  );
  await assert.doesNotReject(() =>
    tool(current, "context_management_get_context_remaining").execute(
      "current-session-usage",
      {},
      undefined,
      undefined,
      current.current.ctx,
    ),
  );
});

test("restores a persisted accepted rollover and resumes compaction", async () => {
  const current = setup();
  await start(current);
  const accepted = await tool(current, "context_management_start_new_context").execute(
    "persisted-request",
    { reason: "restart recovery" },
    undefined,
    undefined,
    current.current.ctx,
  );
  persistToolResult(current, "persisted-request", accepted);
  await current.mock.events.get("session_shutdown")?.[0](
    { type: "session_shutdown", reason: "reload" },
    current.current.ctx,
  );

  await start(current);
  assert.ok(current.compactOptions);
  const details = accepted.details as { nextWindowId?: string; reason?: string };
  assert.match(details.nextWindowId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(details.reason, "restart recovery");
});

test("restores a completed rollover once and recognizes its persisted continuation", async () => {
  const current = setup();
  await start(current);
  const accepted = await tool(current, "context_management_start_new_context").execute(
    "completed-request",
    { reason: "resume continuation" },
    undefined,
    undefined,
    current.current.ctx,
  );
  persistToolResult(current, "completed-request", accepted);
  const request = accepted.details as {
    requestId: string;
    nextWindowId: string;
  };
  const initial = current.entries.find(
    (entry) => entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE,
  );
  assert.ok(initial?.type === "custom");
  const details = createContextManagementDetails({
    lineage: initial.data as ReturnType<typeof createInitialContextState>,
    keptMessages: [],
    reason: "manual",
    requestId: request.requestId,
    windowId: request.nextWindowId,
  });
  current.entries.push({
    type: "compaction",
    id: "persisted-request-compaction",
    parentId: current.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:04.000Z",
    summary: contextContract(details),
    firstKeptEntryId: "user",
    tokensBefore: 90,
    details,
  });
  await current.mock.events.get("session_shutdown")?.[0](
    { type: "session_shutdown", reason: "reload" },
    current.current.ctx,
  );

  const beforeRestart = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  ).length;
  await start(current);
  const afterRestart = current.mock.sentMessages.filter(
    (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  );
  assert.equal(afterRestart.length, beforeRestart + 1);
  assert.match(JSON.stringify(afterRestart.at(-1)), /resume continuation/);
  persistLastSentCustomMessage(current);
  await current.mock.events.get("session_shutdown")?.[0](
    { type: "session_shutdown", reason: "reload" },
    current.current.ctx,
  );
  await start(current);
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    beforeRestart + 1,
  );
});

test.each(["automatic", "requested"] as const)(
  "persists a suppressed %s rollover before reload recovery",
  async (path) => {
    const current = setup();
    await start(current);
    const accepted = await tool(current, "context_management_start_new_context").execute(
      "suppressed-request",
      {},
      undefined,
      undefined,
      current.current.ctx,
    );
    persistToolResult(current, "suppressed-request", accepted);

    if (path === "automatic") await emitAutomaticCompaction(current);
    await current.mock.events.get("turn_start")?.[0](
      { type: "turn_start", turnIndex: 1, timestamp: Date.now() },
      current.current.ctx,
    );
    await current.mock.events.get("agent_end")?.[0](
      { type: "agent_end", messages: [assistantMessage("stop")] },
      current.current.ctx,
    );
    await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
    if (path === "requested") await completeRequestedCompaction(current);

    const requestId = (accepted.details as { requestId: string }).requestId;
    assert.ok(
      current.entries.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-context-management-rollover" &&
          (entry.data as { requestId?: string; status?: string }).requestId === requestId &&
          (entry.data as { status?: string }).status === "suppressed",
      ),
    );
    const continuationsBeforeReload = current.mock.sentMessages.filter(
      (item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
    ).length;
    await current.mock.events.get("session_shutdown")?.[0](
      { type: "session_shutdown", reason: "reload" },
      current.current.ctx,
    );
    await start(current);
    assert.equal(
      current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
        .length,
      continuationsBeforeReload,
    );
  },
);

test("fails rollover recovery explicitly at its branch-entry limit", async () => {
  const current = setup();
  current.setBranch(
    Array.from({ length: 100_001 }, (_, index) => ({
      ...messageEntry(),
      id: `recovery-entry-${index}`,
      parentId: index === 0 ? null : `recovery-entry-${index - 1}`,
    })),
  );

  await assert.rejects(() => start(current), /context branch traversal exceeded its entry limit/);
  assert.deepEqual(current.mock.rawPi.getActiveTools(), ["read"]);
});

test("cancels experimental compaction when fingerprint bounds are exceeded", async () => {
  const current = setup();
  await start(current);
  let nested: unknown = "deep";
  for (let index = 0; index < 20_000; index += 1) nested = [nested];
  const deepEntry: SessionEntry = {
    type: "message",
    id: "deep-tool-call",
    parentId: current.entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      ...assistantMessage("toolUse"),
      content: [{ type: "toolCall", id: "deep", name: "foreign_tool", arguments: nested }],
    } as AgentMessage,
  };
  current.entries.push(deepEntry);
  const before = current.mock.events.get("session_before_compact")?.[0];
  assert.ok(before);
  const result = await before(
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: deepEntry.id,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 90,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      branchEntries: current.entries,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    },
    current.current.ctx,
  );
  assert.deepEqual(result, { cancel: true });
  assert.match(current.current.notifications.at(-1)?.message ?? "", /fingerprint exceeded its traversal limit/);
});

test("session shutdown invalidates pending compaction callbacks", async () => {
  const current = setup();
  await start(current);
  await tool(current, "context_management_start_new_context").execute(
    "start",
    {},
    undefined,
    undefined,
    current.current.ctx,
  );
  await current.mock.events.get("agent_settled")?.[0]({ type: "agent_settled" }, current.current.ctx);
  assert.ok(current.compactOptions);
  await current.mock.events.get("session_shutdown")?.[0](
    { type: "session_shutdown", reason: "reload" },
    current.current.ctx,
  );
  current.compactOptions?.onError?.(new Error("stale"));
  assert.equal(
    current.mock.sentMessages.filter((item) => (item.options as { triggerTurn?: boolean } | undefined)?.triggerTurn)
      .length,
    0,
  );
});
