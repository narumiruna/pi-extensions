import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
  Type,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, test } from "vitest";
import { DurableHost, HOST_INTENT, HOST_REPORT, type HostIntent, type HostReport } from "./durable-host.js";

// Vitest's setup sets PI_CODING_AGENT_DIR before these lifecycle imports.
let root: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-subagents-host-"));
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function file(manager: SessionManager): string {
  const path = manager.getSessionFile();
  assert.ok(path);
  return path;
}

function newManager(conversation = true) {
  const manager = SessionManager.create(root, join(root, "sessions"));
  if (conversation) manager.appendMessage({ role: "user", content: "Host conversation", timestamp: 1 });
  return manager;
}

async function createHostSession(manager = newManager()) {
  const captured: TranscriptContext[] = [];
  const faux = createFauxCore({
    api: `host-api-${crypto.randomUUID()}`,
    provider: `host-provider-${crypto.randomUUID()}`,
    models: [{ id: "host-model", contextWindow: 100_000, maxTokens: 1_000 }],
  });
  faux.setResponses(
    Array.from({ length: 10 }, () => (context: TranscriptContext) => {
      captured.push(structuredClone(context));
      return fauxAssistantMessage("main reply");
    }),
  );
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const registry = new ModelRegistry(modelRuntime);
  registry.registerProvider(faux.getModel().provider, {
    api: faux.api,
    apiKey: "synthetic-not-a-secret",
    baseUrl: "http://localhost:0",
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const model = registry.find(faux.getModel().provider, faux.getModel().id);
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let api!: ExtensionAPI;
  let host: DurableHost | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Stable main host instructions.",
    extensionFactories: [
      (pi) => {
        api = pi;
        pi.on("session_shutdown", () => host?.dispose());
        pi.registerTool({
          name: "host_probe",
          label: "Host probe",
          description: "Return a deterministic host probe.",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "probe" }], details: undefined }),
        });
      },
    ],
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    resourceLoader,
    sessionManager: manager,
    settingsManager,
    noTools: "builtin",
    thinkingLevel: "off",
  });
  assert.deepEqual(created.extensionsResult.errors, []);
  const session = created.session;
  sessions.push(session);
  await session.bindExtensions({});
  host = new DurableHost(session);
  const services = { cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  return { session, manager, api, faux, captured, host, services, created };
}

function intent(session: AgentSession): HostIntent {
  return {
    sessionId: session.sessionId,
    requestId: "spawn-request-A",
    agentId: "agent-A",
    runId: "run-A",
    task: "Task A",
  };
}

function admit(session: AgentSession, host: DurableHost): HostReport {
  const value = intent(session);
  return { intentEntryId: host.admit(value), reportId: "report-A", intent: value, content: "Task A finished." };
}

function reports(manager: SessionManager) {
  return manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === HOST_REPORT);
}

function normalized(context: TranscriptContext) {
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages).map(toToolDeclaration),
    messages: context.messages.map((message) => {
      if (message.role === "system") {
        return {
          role: message.role,
          content: message.content,
          sections: message.sections,
          toolsAdded: message.toolsAdded?.map(toToolDeclaration),
          toolsRemoved: message.toolsRemoved,
        };
      }
      if (message.role === "toolResult") {
        return {
          role: message.role,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content,
          isError: message.isError,
        };
      }
      return { role: message.role, content: message.content };
    }),
  };
}

describe("durable Pi host receipts (test-only, single owner)", () => {
  test("reopen discovers agent/run intent and correlates an interrupted spawn receipt without a model-supplied list", async () => {
    const first = await createHostSession();
    const report = admit(first.session, first.host);
    const path = file(first.manager);
    first.session.dispose();
    const reopened = await createHostSession(SessionManager.open(path));
    assert.equal(reopened.session.sessionId, report.intent.sessionId);
    assert.deepEqual(reopened.host.intents(), [{ entryId: report.intentEntryId, intent: report.intent }]);
    assert.equal(reopened.host.admit(report.intent), report.intentEntryId);
    const count = reopened.manager.getEntryCount();
    assert.throws(() => reopened.host.admit({ ...report.intent, task: "different work" }), /Conflicting admission/);
    assert.equal(reopened.manager.getEntryCount(), count);
    assert.equal(JSON.stringify(reopened.manager.buildSessionContext().messages).includes("spawn-request-A"), false);
    assert.equal(reopened.faux.state.callCount, 0);
  });

  test("custom entries and even awaited custom messages alone do not create a persistent Pi conversation", async () => {
    const fixture = await createHostSession(newManager(false));
    fixture.api.appendEntry(HOST_INTENT, intent(fixture.session));
    await fixture.session.sendCustomMessage({ customType: HOST_REPORT, content: "custom only", display: false });
    assert.equal(existsSync(file(fixture.manager)), false);
    assert.equal(fixture.manager.isPersisted(), true);
    assert.throws(() => fixture.host.admit(intent(fixture.session)), /persisted Pi conversation/);
    const recovered = SessionManager.open(file(fixture.manager));
    assert.notEqual(recovered.getSessionId(), fixture.session.sessionId);
    assert.deepEqual(recovered.getEntries(), []);
  });

  test("an in-memory Pi conversation cannot admit durable work", async () => {
    const manager = SessionManager.inMemory(root);
    manager.appendMessage({ role: "user", content: "Not a persistent session", timestamp: 1 });
    const fixture = await createHostSession(manager);
    assert.throws(() => fixture.host.admit(intent(fixture.session)), /persisted Pi conversation/);
    assert.deepEqual(fixture.host.intents(), []);
  });

  test.each(["before-delivery", "append-before-ack", "after-ack"] as const)(
    "reconciles %s across real JSONL reopen with one report entry",
    async (gap) => {
      const first = await createHostSession();
      // This plain outbox value is NOT evidence of durable-worker storage.
      const outbox = { report: admit(first.session, first.host), acknowledged: false };
      let firstEntry: string | undefined;
      if (gap !== "before-delivery") firstEntry = await first.host.deliver(outbox.report);
      if (gap === "after-ack") outbox.acknowledged = true;
      first.host.dispose();
      first.session.dispose();
      const reopened = await createHostSession(SessionManager.open(file(first.manager)));
      if (!outbox.acknowledged) {
        const recoveredEntry = await reopened.host.deliver(structuredClone(outbox.report));
        if (firstEntry) assert.equal(recoveredEntry, firstEntry);
        outbox.acknowledged = true;
      }
      assert.equal(outbox.acknowledged, true);
      assert.equal(reports(reopened.manager).length, 1);
      const messages = reopened.manager.buildSessionContext().messages;
      assert.equal(
        messages.filter((message) => message.role === "custom" && message.customType === HOST_REPORT).length,
        1,
      );
      assert.equal(reopened.faux.state.callCount, 0, "receipt does not mean the main model read it or was awakened");
    },
  );

  test("concurrent report retries share the receipt and conflicting stable IDs cannot replace it", async () => {
    const fixture = await createHostSession();
    const report = admit(fixture.session, fixture.host);
    const [left, right] = await Promise.all([
      fixture.host.deliver(report),
      fixture.host.deliver(structuredClone(report)),
    ]);
    assert.equal(left, right);
    await assert.rejects(fixture.host.deliver({ ...report, content: "replacement" }), /Conflicting report/);
    assert.equal(reports(fixture.manager).length, 1);
  });

  test.each(["intent", "report"] as const)(
    "a failed %s storage path requires disk reopen instead of an acknowledgement",
    async (kind) => {
      const fixture = await createHostSession();
      const report = kind === "report" ? admit(fixture.session, fixture.host) : undefined;
      const path = file(fixture.manager);
      const saved = `${path}.saved`;
      renameSync(path, saved);
      mkdirSync(path);
      try {
        if (report) await assert.rejects(fixture.host.deliver(report), /EISDIR/);
        else assert.throws(() => fixture.host.admit(intent(fixture.session)), /EISDIR/);
        assert.equal(
          fixture.manager
            .getBranch()
            .filter((entry) =>
              kind === "report"
                ? entry.type === "custom_message" && entry.customType === HOST_REPORT
                : entry.type === "custom" && entry.customType === HOST_INTENT,
            ).length,
          kind === "report" ? 0 : 1,
          "intent append indexes before write; report delivery first revalidates its admission from disk",
        );
        if (report) await assert.rejects(fixture.host.deliver(report), /discard this host/);
        else assert.throws(() => fixture.host.admit(intent(fixture.session)), /discard this host/);
      } finally {
        rmSync(path, { recursive: true });
        renameSync(saved, path);
        fixture.session.dispose();
      }
      const reopened = await createHostSession(SessionManager.open(path));
      assert.equal(reports(reopened.manager).length, 0);
      if (report) await reopened.host.deliver(report);
      else assert.deepEqual(reopened.host.intents(), []);
      assert.equal(reports(reopened.manager).length, report ? 1 : 0);
    },
  );

  test("a memory-only report from an external failed Pi append is not accepted as a disk receipt", async () => {
    const fixture = await createHostSession();
    const report = admit(fixture.session, fixture.host);
    const path = file(fixture.manager);
    const saved = `${path}.saved`;
    renameSync(path, saved);
    mkdirSync(path);
    try {
      await assert.rejects(
        fixture.session.sendCustomMessage({
          customType: HOST_REPORT,
          content: report.content,
          display: false,
          details: report,
        }),
        /EISDIR/,
      );
    } finally {
      rmSync(path, { recursive: true });
      renameSync(saved, path);
    }
    assert.equal(reports(fixture.manager).length, 1);
    assert.equal(reports(SessionManager.open(path)).length, 0);
    await assert.rejects(fixture.host.deliver(report), /not present on disk/);
  });

  test("discovery rejects an external memory-only admission instead of publishing an orphan report", async () => {
    const fixture = await createHostSession();
    const path = file(fixture.manager);
    const saved = `${path}.saved`;
    renameSync(path, saved);
    mkdirSync(path);
    try {
      assert.throws(() => fixture.api.appendEntry(HOST_INTENT, intent(fixture.session)), /EISDIR/);
    } finally {
      rmSync(path, { recursive: true });
      renameSync(saved, path);
    }
    assert.equal(
      fixture.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === HOST_INTENT),
      true,
    );
    assert.throws(() => fixture.host.intents(), /not present on disk/);
    assert.equal(
      SessionManager.open(path)
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === HOST_INTENT),
      false,
    );
  });

  test("Pi does not deduplicate custom messages, even if their details contain the same report ID", async () => {
    const fixture = await createHostSession();
    const message = { customType: HOST_REPORT, content: "result", display: false, details: { reportId: "same-id" } };
    await fixture.session.sendCustomMessage(message);
    fixture.session.dispose();
    const reopened = await createHostSession(SessionManager.open(file(fixture.manager)));
    await reopened.session.sendCustomMessage(message);
    assert.equal(
      reports(reopened.manager).length,
      2,
      "stable-ID deduplication requires host policy; Pi does not enforce it",
    );
  });

  test("compaction retains raw branch receipts but can remove the report from model context", async () => {
    const first = await createHostSession();
    const report = admit(first.session, first.host);
    const reportEntry = await first.host.deliver(report);
    first.manager.appendCompaction("Summarized history without the report text.", null, 1_000);
    first.session.dispose();
    const reopened = await createHostSession(SessionManager.open(file(first.manager)));
    assert.equal(reports(reopened.manager).length, 1);
    assert.equal(JSON.stringify(reopened.manager.buildSessionContext().messages).includes(report.content), false);
    assert.equal(await reopened.host.deliver(report), reportEntry);
    assert.equal(reports(reopened.manager).length, 1);
    assert.equal(JSON.stringify(reopened.manager.buildSessionContext().messages).includes(report.content), false);
    assert.deepEqual(reopened.host.intents(), [{ entryId: report.intentEntryId, intent: report.intent }]);
  });

  test("a truncated Pi JSONL tail is not a receipt and public reopen permits one report retry", async () => {
    const first = await createHostSession();
    const report = admit(first.session, first.host);
    first.session.dispose();
    appendFileSync(file(first.manager), '{"type":"custom_message","id":"partial-report"');
    const reopened = await createHostSession(SessionManager.open(file(first.manager)));
    assert.equal(reports(reopened.manager).length, 0);
    assert.deepEqual(reopened.host.intents(), [{ entryId: report.intentEntryId, intent: report.intent }]);
    await reopened.host.deliver(report);
    assert.equal(reports(SessionManager.open(file(reopened.manager))).length, 1);
  });

  test("bare branch navigation is not persisted until an entry is appended", async () => {
    const fixture = await createHostSession();
    const anchor = fixture.manager.getLeafId();
    assert.ok(anchor);
    const report = admit(fixture.session, fixture.host);
    const reportLeaf = await fixture.host.deliver(report);
    fixture.manager.branch(anchor);
    assert.equal(reports(fixture.manager).length, 0);
    const reopened = SessionManager.open(file(fixture.manager));
    assert.equal(
      reopened.getLeafId(),
      reportLeaf,
      "reopen selects the final appended entry, not the last navigated leaf",
    );
    assert.equal(reports(reopened).length, 1);
    fixture.manager.appendCustomEntry("durable-host.branch-checkpoint.v1", { owner: "alternative" });
    assert.equal(reports(SessionManager.open(file(fixture.manager))).length, 0);
  });

  test("an abandoned branch is not an admission or delivery receipt for the active branch", async () => {
    const fixture = await createHostSession();
    const anchor = fixture.manager.getLeafId();
    assert.ok(anchor);
    const report = admit(fixture.session, fixture.host);
    const originalLeaf = await fixture.host.deliver(report);
    fixture.manager.branchWithSummary(anchor, "Alternative branch; no transfer of ownership.");
    assert.deepEqual(fixture.host.intents(), []);
    await assert.rejects(fixture.host.deliver(report), /active branch/);
    assert.equal(
      fixture.manager.getEntries().some((entry) => entry.id === originalLeaf),
      true,
    );
    const reopened = await createHostSession(SessionManager.open(file(fixture.manager)));
    assert.deepEqual(reopened.host.intents(), []);
    assert.equal(reports(reopened.manager).length, 0);
    reopened.manager.branch(originalLeaf);
    assert.equal(await reopened.host.deliver(report), originalLeaf);
  });

  test.each(["createBranchedSession", "forkFrom"] as const)(
    "%s copies receipts but cannot acquire the source session's work",
    async (mode) => {
      const first = await createHostSession();
      const report = admit(first.session, first.host);
      const leaf = await first.host.deliver(report);
      const sourcePath = file(first.manager);
      first.session.dispose();
      let fork: SessionManager;
      if (mode === "createBranchedSession") {
        fork = SessionManager.open(sourcePath);
        assert.ok(fork.createBranchedSession(leaf));
      } else {
        fork = SessionManager.forkFrom(sourcePath, root, join(root, "forks"));
      }
      const forked = await createHostSession(fork);
      assert.notEqual(forked.session.sessionId, report.intent.sessionId);
      assert.equal(reports(fork).length, 1, "copying transcript history is not ownership transfer");
      assert.deepEqual(forked.host.intents(), []);
      await assert.rejects(forked.host.deliver(report), /Wrong host session/);
      assert.equal(SessionManager.open(sourcePath).getSessionId(), report.intent.sessionId);
    },
  );

  test.each(["replacement", "generation", "shutdown", "branch"] as const)(
    "rejects delayed publication after %s",
    async (change) => {
      const first = await createHostSession();
      const anchor = first.manager.getLeafId();
      assert.ok(anchor);
      const report = admit(first.session, first.host);
      const next = await createHostSession();
      const gate = deferred();
      const publication = first.host.deliver(report, gate.promise);
      if (change === "replacement") first.host.replace(next.session);
      if (change === "generation") first.host.replace(first.session);
      if (change === "shutdown") {
        first.host.dispose();
        first.host.dispose();
      }
      if (change === "branch") first.manager.branchWithSummary(anchor, "New branch");
      gate.resolve();
      await assert.rejects(publication, /Stale host|active branch/);
      assert.equal(reports(first.manager).length, 0);
      assert.equal(reports(next.manager).length, 0);
    },
  );

  test.each(["new", "resume", "fork", "shutdown", "failed-startup"] as const)(
    "actual AgentSessionRuntime %s invalidates delayed host publication through session_shutdown",
    async (action) => {
      const first = await createHostSession();
      const report = admit(first.session, first.host);
      const target = newManager();
      let failStartup = false;
      const runtime = new AgentSessionRuntime(first.session, first.services, async ({ sessionManager }) => {
        if (failStartup) throw new Error("Injected partial startup failure");
        const next = await createHostSession(sessionManager);
        return { ...next.created, services: next.services, diagnostics: [] };
      });
      const gate = deferred();
      const publication = first.host.deliver(report, gate.promise);
      try {
        if (action === "new") await runtime.newSession();
        if (action === "resume") await runtime.switchSession(file(target));
        if (action === "fork") await runtime.fork(report.intentEntryId, { position: "at" });
        if (action === "shutdown") await runtime.dispose();
        if (action === "failed-startup") {
          failStartup = true;
          await assert.rejects(runtime.newSession(), /partial startup failure/);
        }
        gate.resolve();
        await assert.rejects(publication, /Stale host/);
        assert.throws(
          () => first.api.sendMessage({ customType: HOST_REPORT, content: "late", display: false }),
          /stale/i,
        );
        assert.equal(reports(SessionManager.open(file(first.manager))).length, 0);
        assert.equal(reports(runtime.session.sessionManager).length, 0);
      } finally {
        gate.resolve();
        await publication.catch(() => {});
        runtime.session.dispose();
      }
    },
  );

  test("replacement during message publication cannot acknowledge the old report into the next session", async () => {
    const first = await createHostSession();
    const next = await createHostSession();
    const report = admit(first.session, first.host);
    const unsubscribe = first.session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "custom") first.host.replace(next.session);
    });
    try {
      await assert.rejects(first.host.deliver(report), /Stale host/);
      assert.equal(
        reports(first.manager).length,
        1,
        "append preceded replacement, but no outbox acknowledgement is returned",
      );
      assert.equal(reports(next.manager).length, 0);
      first.session.dispose();
      const reopened = await createHostSession(SessionManager.open(file(first.manager)));
      await reopened.host.deliver(report);
      assert.equal(reports(reopened.manager).length, 1);
    } finally {
      unsubscribe();
    }
  });

  test("captured public extension actions are rejected after actual AgentSession disposal", async () => {
    const fixture = await createHostSession();
    fixture.session.dispose();
    assert.throws(
      () => fixture.api.sendMessage({ customType: HOST_REPORT, content: "late", display: false }),
      /stale/i,
    );
    assert.throws(() => fixture.api.appendEntry(HOST_INTENT, intent(fixture.session)), /stale/i);
    assert.equal(reports(SessionManager.open(file(fixture.manager))).length, 0);
  });

  test("ordinary main requests and reopen/redispatch retain normalized prompt, tools, and message prefixes", async () => {
    const first = await createHostSession();
    await first.session.prompt("First ordinary turn");
    const report = admit(first.session, first.host);
    await first.host.deliver(report);
    await first.session.prompt("Second ordinary turn");
    const path = file(first.manager);
    first.session.dispose();
    const reopened = await createHostSession(SessionManager.open(path));
    assert.equal(await reopened.host.deliver(report), reports(reopened.manager)[0]?.id);
    await reopened.session.prompt("Third ordinary turn after redispatch");
    const requests = [...first.captured, ...reopened.captured].map(normalized);
    assert.equal(requests.length, 3);
    assert.deepEqual(first.session.getActiveToolNames(), ["host_probe"]);
    assert.deepEqual(reopened.session.getActiveToolNames(), ["host_probe"]);
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1];
      const current = requests[index];
      assert.ok(previous && current);
      assert.equal(current.systemPrompt, previous.systemPrompt);
      assert.deepEqual(current.tools, previous.tools);
      assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages);
    }
    assert.equal(JSON.stringify(requests).includes("spawn-request-A"), false, "entry details are not model input");
    assert.equal(JSON.stringify(requests[0]).includes(report.content), false);
    assert.equal(JSON.stringify(requests[1]).split(report.content).length - 1, 1);
    assert.equal(JSON.stringify(requests[2]).split(report.content).length - 1, 1);
  });
});

describe("Pi delivery acknowledgement boundaries", () => {
  test("pi.sendMessage returns void and nextTurn is not persisted, does not wake an idle model, and is lost on dispose", async () => {
    const first = await createHostSession();
    const result = first.api.sendMessage(
      { customType: HOST_REPORT, content: "queued report", display: false, details: { reportId: "queued" } },
      { deliverAs: "nextTurn", triggerTurn: false },
    );
    assert.equal(result, undefined);
    assert.equal(reports(first.manager).length, 0);
    assert.equal(first.faux.state.callCount, 0);
    first.session.dispose();
    assert.equal(reports(SessionManager.open(file(first.manager))).length, 0);
  });

  test("awaiting the public AgentSession nextTurn method also returns before a session receipt exists", async () => {
    const first = await createHostSession();
    await first.session.sendCustomMessage(
      { customType: HOST_REPORT, content: "not durable", display: false },
      { deliverAs: "nextTurn", triggerTurn: true },
    );
    assert.equal(reports(first.manager).length, 0);
    assert.equal(first.faux.state.callCount, 0, "nextTurn takes precedence over triggerTurn");
    first.session.dispose();
    assert.equal(reports(SessionManager.open(file(first.manager))).length, 0);
  });

  test.each([
    { name: "default steering", options: {} },
    { name: "explicit steering", options: { deliverAs: "steer" as const } },
    { name: "follow-up", options: { deliverAs: "followUp" as const } },
    { name: "next turn", options: { deliverAs: "nextTurn" as const } },
    { name: "non-triggering end-of-turn append", options: { triggerTurn: false } },
  ])("streaming $name resolves before persistence; the host keeps its outbox pending", async ({ options }) => {
    const fixture = await createHostSession();
    const report = admit(fixture.session, fixture.host);
    const started = deferred();
    const release = deferred();
    fixture.faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return fauxAssistantMessage("finished");
      },
    ]);
    const run = fixture.session.prompt("Controlled active generation");
    try {
      await started.promise;
      await fixture.session.sendCustomMessage(
        { customType: HOST_REPORT, content: report.content, display: false },
        options,
      );
      assert.equal(reports(fixture.manager).length, 0);
      assert.equal(reports(SessionManager.open(file(fixture.manager))).length, 0);
      await assert.rejects(fixture.host.deliver(report), /Host is busy/);
    } finally {
      fixture.session.clearQueue();
      fixture.session.dispose();
      release.resolve();
      await run;
    }
  });

  test("triggering delivery from agent_settled resolves before its deferred append and next request", async () => {
    const fixture = await createHostSession();
    let firstSettled = true;
    let receiptsWhenResolved = -1;
    fixture.api.on("agent_settled", async () => {
      if (!firstSettled) return;
      firstSettled = false;
      await fixture.session.sendCustomMessage(
        { customType: HOST_REPORT, content: "deferred settled report", display: false },
        { triggerTurn: true },
      );
      // Capture inside the callback; assert after command completion.
      receiptsWhenResolved = reports(fixture.manager).length;
    });
    await fixture.session.prompt("First request");
    await fixture.session.waitForIdle();
    assert.equal(receiptsWhenResolved, 0);
    assert.equal(reports(fixture.manager).length, 1);
    assert.equal(fixture.faux.state.callCount, 2);
  });

  test("idle triggerTurn true persists its message and performs a real synthetic model request", async () => {
    const fixture = await createHostSession();
    await fixture.session.sendCustomMessage(
      { customType: HOST_REPORT, content: "Please read this report", display: false },
      { triggerTurn: true },
    );
    assert.equal(reports(SessionManager.open(file(fixture.manager))).length, 1);
    assert.equal(fixture.faux.state.callCount, 1);
  });
});
