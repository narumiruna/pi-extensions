import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { DRAFT_CONTRACT_TYPE } from "../src/draft-contract.js";
import { createPlanPaneHost } from "./plan-pane-support.js";
import { createMockContext } from "./support.js";

const fauxSpecifier = "@earendil-works/pi-ai/providers/faux";

function providerInput(context: TranscriptContext) {
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages).map(({ name, description, parameters, constrainedSampling }) => ({
      name,
      description,
      parameters,
      constrainedSampling,
    })),
    messages: JSON.parse(
      JSON.stringify(context.messages, (key, value) =>
        ["timestamp", "usage", "durationMs", "details"].includes(key) ? undefined : value,
      ),
    ) as unknown[],
  };
}

const modes = ["print", "tui"] as const;

test.each(modes)("real Pi in %s snapshots the draft and preserves the provider prefix", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-draft-runtime-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let terminal: ReturnType<typeof createPlanPaneHost> | undefined;
  try {
    await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const { createFauxCore, fauxAssistantMessage, fauxToolCall } = (await import(
      fauxSpecifier
    )) as typeof import("@earendil-works/pi-ai/providers/faux");
    const faux = createFauxCore({
      api: `draft-${crypto.randomUUID()}`,
      provider: `draft-${crypto.randomUUID()}`,
      models: [{ id: "draft", contextWindow: 100_000, maxTokens: 4000 }],
    });
    let path = "";
    const draftOne = "    保留 Markdown 縮排\n\n# 初稿\n";
    const draftTwo = "    保留 Markdown 縮排\n\n# 定稿\n";
    const requests: ReturnType<typeof providerInput>[] = [];
    const observed = (context: TranscriptContext) => requests.push(providerInput(context));
    faux.setResponses([
      (context) => {
        observed(context);
        const text = context.messages
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.filter((block) => block.type === "text").map((block) => block.text),
          )
          .join("\n");
        const authorization = /exact absolute path \(as a JSON string\): ("[^\n]+")\./u.exec(text);
        assert.ok(authorization, JSON.stringify(context.messages));
        path = JSON.parse(authorization[1]);
        return fauxAssistantMessage([
          fauxToolCall("write", { path: join(root, "forbidden.md"), content: "blocked" }, { id: "other-write" }),
          fauxToolCall("write", { path, content: draftOne }, { id: "draft-write" }),
          fauxToolCall("plan_mode_complete", {}, { id: "parallel-complete" }),
        ]);
      },
      (context) => {
        observed(context);
        return fauxAssistantMessage(
          fauxToolCall("edit", { path, edits: [{ oldText: "初稿", newText: "定稿" }] }, { id: "edit" }),
        );
      },
      (context) => {
        observed(context);
        return fauxAssistantMessage(fauxToolCall("read", { path }, { id: "read" }));
      },
      () => fauxAssistantMessage("<proposed_plan>Ignored prose</proposed_plan>"),
      (context) => {
        observed(context);
        return fauxAssistantMessage(fauxToolCall("plan_mode_complete", {}, { id: "complete" }));
      },
    ]);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider(faux.provider, {
      api: faux.api,
      apiKey: "fixture",
      baseUrl: "http://localhost",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const model = registry.find(faux.provider, "draft");
    assert.ok(model);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      additionalExtensionPaths: [resolve("packages/pi-plan-mode/src/index.ts")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model,
      settingsManager,
      resourceLoader: loader,
      sessionManager:
        mode === "tui" ? SessionManager.create(root, join(root, "sessions")) : SessionManager.inMemory(root),
    });
    session = created.session;
    const errors: unknown[] = [];
    if (mode === "tui") {
      initTheme("dark");
      const host = createPlanPaneHost();
      terminal = host;
      const ctx: ExtensionContext = createMockContext({ mode }).ctx;
      ctx.ui.setWidget = host.setWidget;
      await session.bindExtensions({ mode, uiContext: ctx.ui, onError: (error) => errors.push(error) });
      const tool = session.getToolDefinition("plan_mode_complete");
      assert.ok(tool);
      let row: ToolExecutionComponent | undefined;
      session.subscribe((event) => {
        if (!("toolCallId" in event) || event.toolCallId !== "complete") return;
        if (event.type === "tool_execution_start") {
          row = new ToolExecutionComponent(tool.name, event.toolCallId, event.args, {}, tool, host.host, root);
          row.markExecutionStarted();
          host.appendToTranscript(row);
        } else if (event.type === "tool_execution_end") {
          row?.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
        }
      });
    } else {
      await session.bindExtensions({ mode, onError: (error) => errors.push(error) });
    }
    const before = session.getActiveToolNames();
    const native = new Map(session.getAllTools().map((tool) => [tool.name, tool.sourceInfo]));
    for (const name of ["read", "write", "edit"]) assert.equal(native.get(name)?.path, `builtin:${name}`);
    await session.prompt("/plan start");
    await session.prompt("Prepare a plan.");
    assert.equal(await readFile(path, "utf8"), draftTwo);
    await assert.rejects(readFile(join(root, "forbidden.md")), { code: "ENOENT" });
    const messages = () => created.session.messages.filter((message) => message.role === "toolResult");
    for (const id of ["other-write", "parallel-complete"])
      assert.equal(messages().find((message) => message.toolCallId === id)?.isError, true);
    for (const id of ["draft-write", "edit", "read"])
      assert.equal(messages().find((message) => message.toolCallId === id)?.isError, false);
    assert.equal(
      created.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === DRAFT_CONTRACT_TYPE).length,
      1,
    );
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = created.session.subscribe((event) => {
        if (event.type !== "agent_settled") return;
        unsubscribe();
        resolve();
      });
    });
    await session.prompt("/plan finalize");
    await settled;
    const completed = messages().find((message) => message.toolCallId === "complete");
    assert.equal(completed?.isError, false);
    assert.deepEqual(completed?.details, { version: 1, source: "plan_mode_complete", plan: draftTwo });
    assert.deepEqual(completed?.content, [{ type: "text", text: `**Proposed Plan**\n\n${draftTwo}` }]);
    if (terminal) {
      const frame = terminal.render().map(stripTerminalSequences).join("\n");
      assert.match(frame, /Plan complete\. See the Plan pane\./u);
      assert.equal(frame.match(/定稿/gu)?.length, 1);
      const html = await readFile(await session.exportToHtml(join(root, "session.html")), "utf8");
      const base64 = /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(html)?.[1];
      assert.ok(base64);
      const data: { renderedTools: Record<string, { resultHtmlCollapsed?: string; resultHtmlExpanded: string }> } =
        JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
      const rendered = data.renderedTools.complete;
      for (const result of [rendered.resultHtmlExpanded, rendered.resultHtmlCollapsed ?? rendered.resultHtmlExpanded]) {
        assert.match(result, /定稿/u);
        assert.doesNotMatch(result, /See the Plan pane/u);
      }
      const jsonl = await readFile(session.exportToJsonl(join(root, "session.jsonl")), "utf8");
      assert.ok(jsonl.includes(JSON.stringify(draftTwo)));
    }
    assert.equal(faux.state.callCount, 5);
    assert.deepEqual(session.getActiveToolNames(), before);
    assert.equal(requests.length, 4);
    assert.ok(requests[0]?.systemPrompt);
    assert.ok(requests[0]?.tools.some(({ name }) => name === "write"));
    for (let index = 1; index < requests.length; index++) {
      const current = requests[index];
      const earlier = requests[index - 1];
      assert.equal(current.systemPrompt, earlier.systemPrompt);
      assert.deepEqual(current.tools, earlier.tools);
      assert.deepEqual(current.messages.slice(0, earlier.messages.length), earlier.messages);
      assert.equal(
        current.messages.filter((item) => JSON.stringify(item).includes("PI PLAN MODE DRAFT CONTRACT")).length,
        1,
      );
    }
    await writeFile(path, "Changed outside the completed workflow");
    await session.prompt(`/plan export ${join(root, "export.md")}`);
    assert.equal(await readFile(join(root, "export.md"), "utf8"), draftTwo);
    assert.deepEqual(errors, []);
  } finally {
    await session?.dispose();
    terminal?.stop();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
