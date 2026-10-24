import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DURABLE_INTENT_TYPE,
  DURABLE_RECEIPT_KEY,
  DURABLE_REPORT_TYPE,
  type DurableFlushCallbacks,
  type DurableMainBridge,
  deriveBinding,
} from "../src/durable-main-bridge.js";
import type { DurableReport } from "../src/durable-state.js";

let root: string;
const sessions: AgentSession[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-main-bridge-"));
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  rmSync(root, { recursive: true, force: true });
});

function manager(conversation = true) {
  const value = SessionManager.create(root, join(root, "sessions"));
  if (conversation) value.appendMessage({ role: "user", content: "Existing Pi conversation", timestamp: 1 });
  return value;
}

function file(value: SessionManager) {
  const path = value.getSessionFile();
  assert.ok(path);
  return path;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function report(patch: Partial<DurableReport> = {}): DurableReport {
  return {
    id: "report-1",
    conversationId: "agent-1",
    requestId: "spawn-1",
    outcome: "completed",
    result: "Saved result",
    error: null,
    acknowledged: false,
    suppressed: false,
    ...patch,
  };
}

function fixture(value = manager()) {
  let current = true;
  let idle = true;
  const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const queued: (() => void)[] = [];
  let delivery: "append" | "queue" | "ghost" = "append";
  const api: Pick<ExtensionAPI, "appendEntry" | "sendMessage"> = {
    appendEntry: (type, data) => {
      value.appendCustomEntry(type, data);
    },
    sendMessage: (message, options) => {
      sent.push([message, options]);
      const append = () => {
        const bytes = readFileSync(file(value));
        value.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        if (delivery === "ghost") writeFileSync(file(value), bytes);
      };
      if (delivery === "queue") queued.push(append);
      else append();
    },
  };
  const ctx = { sessionManager: value, cwd: root, isIdle: () => idle };
  return {
    value,
    api,
    ctx,
    sent,
    queued,
    guard: () => {
      if (!current) throw new Error("Stale generation");
    },
    invalidate: () => {
      current = false;
    },
    busy: () => {
      idle = false;
    },
    idle: () => {
      idle = true;
    },
    deliver: (mode: typeof delivery) => {
      delivery = mode;
    },
  };
}

async function admitted(value = fixture()) {
  const bridge = await deriveBinding(value.api, value.ctx, value.guard);
  await bridge.admit("spawn-1", { kind: "spawn", task: "Task" });
  const pending = report();
  const acknowledgements: string[] = [];
  const callbacks: DurableFlushCallbacks = {
    getLatest: (id) => (id === pending.id ? pending : undefined),
    acknowledge: (id) => {
      // Every acknowledgement must already have a receipt on real disk.
      const disk = SessionManager.open(file(value.value));
      assert.ok(
        disk
          .getBranch()
          .some(
            (entry) =>
              (entry.type === "custom_message" && entry.customType === DURABLE_REPORT_TYPE) ||
              (entry.type === "message" &&
                entry.message.role === "toolResult" &&
                entry.message.toolName === "subagent_wait"),
          ),
      );
      acknowledgements.push(id);
      pending.acknowledged = true;
    },
  };
  return { ...value, bridge, pending, callbacks, acknowledgements };
}

function appendWait(
  value: SessionManager,
  bridge: DurableMainBridge,
  ids = ["report-1"],
  patch: Record<string, unknown> = {},
) {
  value.appendMessage({
    role: "toolResult",
    toolName: "subagent_wait",
    toolCallId: "wait-1",
    content: [{ type: "text", text: "Saved result" }],
    details: { [DURABLE_RECEIPT_KEY]: { storeKey: bridge.binding.storeKey, reportIds: ids } },
    isError: false,
    timestamp: 2,
    ...patch,
  });
}

async function sdkFixture(value = manager()) {
  const faux = createFauxCore({
    api: `bridge-${crypto.randomUUID()}`,
    provider: `bridge-${crypto.randomUUID()}`,
    models: [{ id: "test", contextWindow: 100_000, maxTokens: 1_000 }],
  });
  const captured: TranscriptContext[] = [];
  faux.setResponses(
    Array.from({ length: 3 }, () => (context: TranscriptContext) => {
      captured.push(structuredClone(context));
      return fauxAssistantMessage("Main reply");
    }),
  );
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const registry = new ModelRegistry(modelRuntime);
  registry.registerProvider(faux.getModel().provider, {
    api: faux.api,
    apiKey: "synthetic",
    baseUrl: "http://localhost:0",
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let api!: ExtensionAPI;
  let ctx!: ExtensionContext;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Stable main instructions.",
    extensionFactories: [
      (pi) => {
        api = pi;
        pi.on("session_start", (_event, context) => {
          ctx = context;
        });
      },
    ],
  });
  await loader.reload();
  const model = registry.find(faux.getModel().provider, "test");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader: loader,
    sessionManager: value,
    noTools: "builtin",
    thinkingLevel: "off",
  });
  sessions.push(session);
  await session.bindExtensions({});
  return { session, api, ctx, faux, value, captured };
}

describe("production durable Pi-session bridge", () => {
  it("binds deterministically to session ID, canonical file, and canonical cwd", async () => {
    const a = fixture();
    const first = await deriveBinding(a.api, a.ctx, a.guard);
    const reopened = fixture(SessionManager.open(file(a.value), undefined, root));
    const second = await deriveBinding(reopened.api, reopened.ctx, reopened.guard);
    expect(second.binding).toEqual(first.binding);
    expect(first.binding.storeKey).toMatch(/^[a-f0-9]{64}$/);
    symlinkSync(root, join(root, "alias"));
    const alias = await deriveBinding(a.api, { ...a.ctx, cwd: join(root, "alias") }, a.guard);
    expect(alias.binding).toEqual(first.binding);
    const fork = fixture(SessionManager.forkFrom(file(a.value), root, join(root, "forks")));
    const third = await deriveBinding(fork.api, fork.ctx, fork.guard);
    expect(third.binding.storeKey).not.toBe(first.binding.storeKey);
  });

  it("rejects in-memory sessions and custom-only sessions before admission", async () => {
    const memory = fixture(SessionManager.inMemory(root));
    memory.value.appendMessage({ role: "user", content: "memory", timestamp: 1 });
    await expect(deriveBinding(memory.api, memory.ctx, memory.guard)).rejects.toThrow("persisted Pi conversation");
    const custom = fixture(manager(false));
    custom.value.appendCustomEntry("test", {});
    custom.value.appendCustomMessageEntry("test", "custom", false, {});
    await expect(deriveBinding(custom.api, custom.ctx, custom.guard)).rejects.toThrow();
    expect(existsSync(file(custom.value))).toBe(false);
  });

  it("rejects an existing disk session with only custom entries", async () => {
    const f = fixture();
    const bytes = readFileSync(file(f.value), "utf8").trim().split("\n");
    writeFileSync(file(f.value), `${bytes[0]}\n`);
    const custom = fixture(SessionManager.open(file(f.value), undefined, root));
    custom.value.appendCustomEntry("only-custom", {});
    await expect(deriveBinding(custom.api, custom.ctx, custom.guard)).rejects.toThrow("persisted Pi conversation");
  });

  it("rejects a ghost user conversation even if a session file exists", async () => {
    const f = fixture();
    const bytes = readFileSync(file(f.value), "utf8").trim().split("\n");
    writeFileSync(file(f.value), `${bytes[0]}\n`);
    await expect(deriveBinding(f.api, f.ctx, f.guard)).rejects.toThrow("not present on disk");
  });

  it.each(["siblings", "second-root", "navigation"])("refuses same-file %s before opening durable", async (kind) => {
    const f = fixture();
    const first = f.value.getLeafId();
    assert.ok(first);
    f.value.appendCustomEntry("tail", {});
    if (kind === "second-root") {
      f.value.resetLeaf();
      f.value.appendCustomEntry("other", {});
    } else {
      f.value.branch(first);
      if (kind === "siblings") f.value.appendCustomEntry("other", {});
    }
    await expect(deriveBinding(f.api, f.ctx, f.guard)).rejects.toThrow(/branch|Branched/);
  });

  it("persists non-model JSON intent, recovers partial startup, and rejects conflicting retry", async () => {
    const f = fixture();
    const bridge = await deriveBinding(f.api, f.ctx, f.guard);
    const receipt = await bridge.admit("spawn-1", { task: "Task", kind: "spawn" });
    expect(receipt.toolCallId).toBe("spawn-1");
    expect(JSON.stringify(f.value.buildSessionContext().messages)).not.toContain("spawn-1");
    bridge.dispose(); // Lost tool response / backend initialization never completed.
    const g = fixture(SessionManager.open(file(f.value), undefined, root));
    const recovered = await deriveBinding(g.api, g.ctx, g.guard);
    expect(recovered.intents()).toEqual([receipt]);
    expect(await recovered.admit("spawn-1", { kind: "spawn", task: "Task" })).toEqual(receipt);
    await expect(recovered.admit("spawn-1", { task: "Different" })).rejects.toThrow("Conflicting");
    expect(g.value.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
  });

  it.each([undefined, Number.NaN, { nested: undefined }, { nested: Number.POSITIVE_INFINITY }])(
    "rejects non-JSON operation %j",
    async (operation) => {
      const f = await admitted();
      await expect(f.bridge.admit("bad", operation)).rejects.toThrow("must be JSON");
    },
  );

  it("does not trust appendEntry's void result or ghost intent", async () => {
    const f = fixture();
    const bridge = await deriveBinding({ ...f.api, appendEntry: () => undefined }, f.ctx, f.guard);
    await expect(bridge.admit("spawn-1", {})).rejects.toThrow("No persisted Pi admission");
    const bytes = readFileSync(file(f.value));
    f.value.appendCustomEntry(DURABLE_INTENT_TYPE, {
      storeKey: bridge.binding.storeKey,
      toolCallId: "spawn-1",
      operation: {},
    });
    writeFileSync(file(f.value), bytes);
    await expect(bridge.admit("spawn-1", {})).rejects.toThrow("not present on disk");
  });

  it("requires disk reopen after an actual append failure leaves a ghost intent", async () => {
    const f = fixture();
    const path = file(f.value);
    const append = f.api.appendEntry;
    f.api.appendEntry = (type, data) => {
      renameSync(path, `${path}.saved`);
      mkdirSync(path);
      try {
        append(type, data);
      } finally {
        rmSync(path, { recursive: true });
        renameSync(`${path}.saved`, path);
      }
    };
    const bridge = await deriveBinding(f.api, f.ctx, f.guard);
    await expect(bridge.admit("spawn-1", {})).rejects.toThrow();
    await expect(bridge.admit("spawn-1", {})).rejects.toThrow("not present on disk");
    expect(
      SessionManager.open(path)
        .getEntries()
        .some((entry) => entry.type === "custom"),
    ).toBe(false);
  });

  it("appends passive steer report with content and stable IDs together before acknowledgement", async () => {
    const f = await admitted();
    const before = structuredClone(f.value.buildSessionContext().messages);
    expect(await f.bridge.flush([f.pending], f.callbacks)).toEqual({ acknowledged: ["report-1"], pending: [] });
    expect(f.sent[0]?.[1]).toEqual({ deliverAs: "steer", triggerTurn: false });
    const entry = f.value.getBranch().at(-1);
    assert.equal(entry?.type, "custom_message");
    expect(entry.details).toMatchObject({
      [DURABLE_RECEIPT_KEY]: { storeKey: f.bridge.binding.storeKey, reportIds: ["report-1"] },
      requestId: "spawn-1",
    });
    expect((entry.details as { receiptId: string }).receiptId).toMatch(/^[a-f0-9]{64}$/);
    expect(f.value.buildSessionContext().messages.slice(0, before.length)).toEqual(before);
    await f.bridge.flush([f.pending], f.callbacks);
    expect(f.sent).toHaveLength(1);
    expect(f.acknowledgements).toEqual(["report-1"]);
  });

  it("serializes concurrent flushes and does not duplicate report insertion", async () => {
    const f = await admitted();
    await Promise.all([f.bridge.flush([f.pending], f.callbacks), f.bridge.flush([f.pending], f.callbacks)]);
    expect(f.sent).toHaveLength(1);
    expect(f.acknowledgements).toEqual(["report-1"]);
  });

  it("reconciles append-before-ack failure after reopen without duplicate publication", async () => {
    const f = await admitted();
    await expect(
      f.bridge.flush([f.pending], {
        ...f.callbacks,
        acknowledge: () => {
          throw new Error("durable store unavailable");
        },
      }),
    ).rejects.toThrow("durable store unavailable");
    expect(f.pending.acknowledged).toBe(false);
    const reopened = await admitted(fixture(SessionManager.open(file(f.value), undefined, root)));
    await reopened.bridge.flush([reopened.pending], reopened.callbacks);
    expect(reopened.sent).toHaveLength(0);
    expect(reopened.acknowledgements).toEqual(["report-1"]);
  });

  it("retains queued reports without resending in the same epoch, then recognizes delayed persistence", async () => {
    const f = await admitted();
    f.deliver("queue");
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("delivery may be queued");
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("reopen before resending");
    expect(f.sent).toHaveLength(1);
    expect(f.acknowledgements).toEqual([]);
    const append = f.queued[0];
    assert.ok(append);
    append();
    await f.bridge.flush([f.pending], f.callbacks);
    expect(f.acknowledgements).toEqual(["report-1"]);
    expect(f.sent).toHaveLength(1);
  });

  it("does not resend a queued message when only the bridge is recreated in the same Pi epoch", async () => {
    const f = await admitted();
    f.deliver("queue");
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("delivery may be queued");
    f.bridge.dispose();
    const replacement = await deriveBinding(f.api, f.ctx, f.guard);
    await expect(replacement.flush([f.pending], f.callbacks)).rejects.toThrow("dispose the Pi session");
    expect(f.sent).toHaveLength(1);
    expect(f.acknowledgements).toEqual([]);
  });

  it("retains ghost report results and never acknowledges in-memory evidence", async () => {
    const f = await admitted();
    f.deliver("ghost");
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("not present on disk");
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("not present on disk");
    expect(f.sent).toHaveLength(1);
    expect(f.acknowledgements).toEqual([]);
  });

  it("does not publish while busy or after getLatest makes main busy", async () => {
    const f = await admitted();
    f.busy();
    expect(await f.bridge.flush([f.pending], f.callbacks)).toEqual({ acknowledged: [], pending: ["report-1"] });
    f.idle();
    await f.bridge.flush([f.pending], {
      ...f.callbacks,
      getLatest: () => {
        f.busy();
        return f.pending;
      },
    });
    expect(f.sent).toHaveLength(0);
  });

  it("uses the latest suppression state rather than the supplied report snapshot", async () => {
    const f = await admitted();
    const snapshot = structuredClone(f.pending);
    f.pending.suppressed = true;
    await f.bridge.flush([snapshot], f.callbacks);
    expect(f.sent).toHaveLength(0);
    expect(f.acknowledgements).toEqual([]);
  });

  it("recognizes persisted explicit wait details even for a suppressed report", async () => {
    const f = await admitted();
    appendWait(f.value, f.bridge);
    f.pending.suppressed = true;
    await f.bridge.flush([f.pending], f.callbacks);
    expect(f.sent).toHaveLength(0);
    expect(f.acknowledgements).toEqual(["report-1"]);
  });

  it.each(["error", "wrong-tool", "wrong-store", "wrong-report"])("ignores %s wait markers", async (kind) => {
    const f = await admitted();
    const patch =
      kind === "error"
        ? { isError: true }
        : kind === "wrong-tool"
          ? { toolName: "unrelated" }
          : {
              details: {
                [DURABLE_RECEIPT_KEY]: {
                  storeKey: kind === "wrong-store" ? "other" : f.bridge.binding.storeKey,
                  reportIds: ["other"],
                },
              },
            };
    appendWait(f.value, f.bridge, ["report-1"], patch);
    await f.bridge.flush([f.pending], f.callbacks);
    expect(f.sent).toHaveLength(1);
  });

  it("does not acknowledge a wait tool-result ghost", async () => {
    const f = await admitted();
    const bytes = readFileSync(file(f.value));
    appendWait(f.value, f.bridge);
    writeFileSync(file(f.value), bytes);
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("not present on disk");
    expect(f.acknowledgements).toEqual([]);
    expect(f.sent).toHaveLength(0);
  });

  it.each(["auto", "wait"])("retains raw %s receipts through linear compaction", async (mode) => {
    const f = await admitted();
    if (mode === "auto") {
      await expect(
        f.bridge.flush([f.pending], {
          ...f.callbacks,
          acknowledge: () => {
            throw new Error("interrupted");
          },
        }),
      ).rejects.toThrow();
    } else appendWait(f.value, f.bridge);
    const keep = f.value.appendMessage({ role: "user", content: "After result", timestamp: 3 });
    f.value.appendCompaction("Summary without receipt", keep, 1_000);
    expect(JSON.stringify(f.value.buildSessionContext().messages)).not.toContain("Saved result");
    // The same live manager must accept compaction's undefined optional fields.
    await f.bridge.flush([f.pending], f.callbacks);
    expect(f.acknowledgements).toEqual(["report-1"]);
    const reopened = await admitted(fixture(SessionManager.open(file(f.value), undefined, root)));
    await reopened.bridge.flush([reopened.pending], reopened.callbacks);
    expect(reopened.sent).toHaveLength(0);
    expect(reopened.acknowledgements).toEqual(["report-1"]);
  });

  it.each(["dispose", "generation", "navigate", "branch", "session"])(
    "rejects stale %s after awaiting latest, before publication",
    async (kind) => {
      const f = await admitted();
      const started = deferred();
      const gate = deferred();
      const flushing = f.bridge.flush([f.pending], {
        ...f.callbacks,
        getLatest: async () => {
          started.resolve();
          await gate.promise;
          return f.pending;
        },
      });
      await started.promise;
      if (kind === "dispose") {
        f.bridge.dispose();
        f.bridge.dispose();
      }
      if (kind === "generation") f.invalidate();
      if (kind === "navigate" || kind === "branch") {
        const first = f.value.getEntries()[0];
        assert.ok(first);
        f.value.branch(first.id);
        if (kind === "branch") f.value.appendCustomEntry("other", {});
      }
      if (kind === "session") f.value.newSession();
      gate.resolve();
      await expect(flushing).rejects.toThrow();
      expect(f.sent).toHaveLength(0);
      expect(f.acknowledgements).toEqual([]);
    },
  );

  it("rejects stale generation after receipt persistence but before acknowledge", async () => {
    const f = await admitted();
    let calls = 0;
    await expect(
      f.bridge.flush([f.pending], {
        ...f.callbacks,
        getLatest: async () => {
          if (++calls === 2) f.invalidate();
          return f.pending;
        },
      }),
    ).rejects.toThrow("Stale generation");
    expect(f.sent).toHaveLength(1);
    expect(f.acknowledgements).toEqual([]);
  });

  it("revalidates disk after the second getLatest await", async () => {
    const f = await admitted();
    const original = readFileSync(file(f.value));
    let calls = 0;
    await expect(
      f.bridge.flush([f.pending], {
        ...f.callbacks,
        getLatest: async () => {
          if (++calls === 2) writeFileSync(file(f.value), original);
          return f.pending;
        },
      }),
    ).rejects.toThrow("not present on disk");
    expect(f.acknowledgements).toEqual([]);
  });

  it("does not import copied admissions or wait receipts into a new fork", async () => {
    const f = await admitted();
    appendWait(f.value, f.bridge);
    const fork = fixture(SessionManager.forkFrom(file(f.value), root, join(root, "forks")));
    const bridge = await deriveBinding(fork.api, fork.ctx, fork.guard);
    expect(bridge.intents()).toEqual([]);
    await expect(bridge.flush([f.pending], f.callbacks)).rejects.toThrow("no admission");
    expect(fork.sent).toHaveLength(0);
  });

  it("rejects a replacement manager even when it reopens the identical session", async () => {
    const f = await admitted();
    f.ctx.sessionManager = SessionManager.open(file(f.value), undefined, root);
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("Stale durable Pi session binding");
    expect(f.sent).toHaveLength(0);
  });

  it("accepts Pi's persisted JSON representation of optional undefined fields", async () => {
    const f = fixture();
    f.value.appendMessage({
      role: "toolResult",
      toolName: "example",
      toolCallId: "example-1",
      content: [],
      details: undefined,
      isError: false,
      timestamp: 2,
    });
    const bridge = await deriveBinding(f.api, f.ctx, f.guard);
    expect((await bridge.admit("spawn-1", { task: "Task" })).toolCallId).toBe("spawn-1");
  });

  it("rejects mutated saved reports even if sanitization or truncation hides the change", async () => {
    const f = await admitted();
    f.pending.result = "x".repeat(50_000);
    await expect(
      f.bridge.flush([f.pending], {
        ...f.callbacks,
        acknowledge: () => {
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    f.pending.result += "different suffix";
    await expect(f.bridge.flush([f.pending], f.callbacks)).rejects.toThrow("Conflicting durable report");
    expect(f.acknowledgements).toEqual([]);
    expect(f.sent).toHaveLength(1);
  });

  it("rechecks payload after asynchronous receipt reconciliation", async () => {
    const f = await admitted();
    let calls = 0;
    await expect(
      f.bridge.flush([f.pending], {
        ...f.callbacks,
        getLatest: async () => {
          if (++calls === 2) f.pending.result = "Changed after publication";
          return f.pending;
        },
      }),
    ).rejects.toThrow("payload changed");
    expect(f.acknowledgements).toEqual([]);
  });

  it("bounds and sanitizes child data without modifying the saved result", async () => {
    const f = await admitted();
    f.pending.result = `\u001b[31m\u0000\u202e${"😀".repeat(40_000)}\n${"line\n".repeat(3_000)}`;
    const original = f.pending.result;
    await f.bridge.flush([f.pending], f.callbacks);
    const sent = f.sent[0];
    assert.ok(sent);
    const text = sent[0].content as string;
    expect(Buffer.byteLength(text)).toBeLessThan(50_000);
    expect(text.split("\n").length).toBeLessThan(2_000);
    for (const control of ["\u0000", "\u001b", "\u202e"]) expect(text).not.toContain(control);
    expect(text).toContain("untrusted data");
    expect(text).toContain("truncated");
    expect(f.pending.result).toBe(original);
  });

  it("uses actual ExtensionAPI void actions with disk-backed public AgentSession and no idle wakeup", async () => {
    const f = await sdkFixture();
    await f.session.prompt("Establish main conversation");
    const bridge = await deriveBinding(f.api, f.ctx, () => undefined);
    await bridge.admit("spawn-1", { task: "Task" });
    let acknowledged = false;
    await bridge.flush([report()], {
      getLatest: () => report(),
      acknowledge: () => {
        acknowledged = true;
        expect(SessionManager.open(file(f.value)).getBranch().at(-1)?.type).toBe("custom_message");
      },
    });
    expect(acknowledged).toBe(true);
    expect(f.faux.state.callCount).toBe(1);
    expect(f.session.isIdle).toBe(true);
    const prefix = structuredClone(f.session.messages);
    await f.session.prompt("Ordinary next turn");
    expect(f.session.messages.slice(0, prefix.length)).toEqual(prefix);
    expect(f.faux.state.callCount).toBe(2);
    await f.session.prompt("Second ordinary turn");
    const normalized = f.captured.map((context) => ({
      system: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map(toToolDeclaration),
      messages: context.messages.map((message) => ({ role: message.role, content: message.content })),
    }));
    for (let index = 1; index < normalized.length; index++) {
      const before = normalized[index - 1];
      const after = normalized[index];
      assert.ok(before && after);
      expect(after.system).toEqual(before.system);
      expect(after.tools).toEqual(before.tools);
      expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    }
  });

  it("observes real ExtensionAPI swallowed append failures as disk receipt failures", async () => {
    const f = await sdkFixture();
    const path = file(f.value);
    const bridge = await deriveBinding(
      {
        appendEntry: f.api.appendEntry,
        sendMessage: (message, options) => {
          renameSync(path, `${path}.saved`);
          mkdirSync(path);
          try {
            f.api.sendMessage(message, options);
          } finally {
            rmSync(path, { recursive: true });
            renameSync(`${path}.saved`, path);
          }
        },
      },
      f.ctx,
      () => undefined,
    );
    await bridge.admit("spawn-1", {});
    let acknowledged = false;
    await expect(
      bridge.flush([report()], {
        getLatest: () => report(),
        acknowledge: () => {
          acknowledged = true;
        },
      }),
    ).rejects.toThrow("not present on disk");
    expect(acknowledged).toBe(false);
    expect(f.faux.state.callCount).toBe(0);
  });
});
