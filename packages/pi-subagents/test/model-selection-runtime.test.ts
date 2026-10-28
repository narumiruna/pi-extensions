import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageDirectory = resolve("packages/pi-subagents");
const parentProvider = "selection-parent";
const childProvider = "selection-child";
const parentModel = "parent-model";
const childModels = ["child/path:high", `${childProvider}/base`, "BASE"];
type Startup = "normal" | "default" | "late" | "missing" | "unavailable";

interface VisibleTool {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  constrainedSampling?: unknown;
}

interface VisibleMessage {
  role: string;
  content: unknown;
  toolName?: string;
  isError?: boolean;
}

interface ProviderInput {
  model: { provider: string; id: string };
  systemPrompt: string;
  names: string[];
  tools: VisibleTool[];
  messages: VisibleMessage[];
}

interface RpcRecord {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { model?: { provider: string; id: string }; text?: string; thinkingLevel?: string };
}

// The fixture lives below the package so Jiti resolves its public Pi peers from this checkout.
function providerFixture(
  evidence: string,
  fixture: string,
  childModel: string,
  selectedProvider: string,
  caseCollision: boolean,
  startup: Startup,
): string {
  return `
import { appendFileSync } from "node:fs";
import {
  fauxProvider, fauxAssistantMessage, fauxToolCall,
  getCurrentSystemPrompt, getCurrentTools,
} from "@earendil-works/pi-ai";

const record = (value) => appendFileSync(${JSON.stringify(evidence)}, JSON.stringify(value) + "\\n");
const visibleTool = ({ name, description, parameters, constrainedSampling }) =>
  ({ name, description, parameters, constrainedSampling });
// Normalize only message-level metadata: tool-call arguments remain byte-for-byte observable.
const visibleMessage = (message) => {
  const { role, content } = message;
  if (role === "system") return {
    role, content, sections: message.sections,
    toolsAdded: message.toolsAdded?.map(visibleTool), toolsRemoved: message.toolsRemoved,
  };
  if (role === "toolResult") return {
    role, content, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError,
  };
  return { role, content };
};
const capture = (context, model, kind) => {
  const tools = getCurrentTools(context.messages);
  record({ kind, input: {
    model: { provider: model.provider, id: model.id },
    systemPrompt: getCurrentSystemPrompt(context.messages),
    names: tools.map((tool) => tool.name), tools: tools.map(visibleTool),
    messages: context.messages.map(visibleMessage),
  }});
};
const resultOf = (context, name) => {
  const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
  if (!result || result.isError) throw new Error("Missing successful " + name + " result");
  return JSON.parse(result.content.map((block) => block.type === "text" ? block.text : "").join(""));
};
const call = (name, args, id) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });

export default function (pi) {
  const isChild = process.env.PI_SUBAGENT_DEPTH !== undefined;
  const pair = (model) => model && ({ provider: model.provider, id: model.id });
  const startup = ${JSON.stringify(startup)};
  const parent = fauxProvider({
    provider: ${JSON.stringify(parentProvider)}, api: "selection-parent-api",
    models: [{ id: ${JSON.stringify(parentModel)}, reasoning: true }],
    tokensPerSecond: 0,
  });
  const child = fauxProvider({
    provider: ${JSON.stringify(selectedProvider)}, api: "selection-child-api",
    models: [{ id: "base", reasoning: true }, { id: ${JSON.stringify(childModel)}, reasoning: false }],
    tokensPerSecond: 0,
  });
  // No parent's catalog or auth configuration is required for the requested child pair.
  if (!isChild || startup !== "late") pi.registerProvider(parent.provider);
  const registerChild = () => pi.registerProvider(startup === "unavailable"
    ? { ...child.provider, filterModels: () => [] }
    : child.provider);
  if (startup === "normal" || (isChild && startup !== "late" && startup !== "missing")) registerChild();
  if (${caseCollision}) {
    const rival = fauxProvider({
      provider: ${JSON.stringify(selectedProvider === "SELECTION-CHILD" ? childProvider : "SELECTION-CHILD")},
      api: "selection-rival-api", models: [{ id: ${JSON.stringify(childModel)} }], tokensPerSecond: 0,
    });
    pi.registerProvider(rival.provider);
    rival.setResponses([() => { record({ kind: "wrong-child-dispatch" }); throw new Error("Wrong provider"); }]);
  }
  pi.on("session_start", (_event, ctx) => {
    if (!isChild) {
      record({ kind: "parent-registration", registered: Boolean(ctx.modelRegistry.find(${JSON.stringify(selectedProvider)}, ${JSON.stringify(childModel)})) });
      return;
    }
    record({ kind: "child-start", model: pair(ctx.model),
      available: ctx.modelRegistry.getAvailable().map(pair),
      registered: Boolean(ctx.modelRegistry.find(${JSON.stringify(selectedProvider)}, ${JSON.stringify(childModel)})),
    });
  });
  // The attached extension runs before the production exact-selection probe.
  pi.on("resources_discover", (_event, ctx) => {
    if (!isChild) return;
    if (startup === "late") registerChild();
    record({ kind: "child-before-probe", model: pair(ctx.model),
      registered: Boolean(ctx.modelRegistry.find(${JSON.stringify(selectedProvider)}, ${JSON.stringify(childModel)})),
    });
  });
  pi.on("model_select", (event) => {
    if (isChild) record({ kind: "child-selection", model: pair(event.model), previousModel: pair(event.previousModel), source: event.source });
  });
  pi.on("session_shutdown", () => {
    if (isChild) record({ kind: "child-shutdown" });
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (isChild) record({ kind: "child-task-dispatch" });
    if (ctx.model?.provider === ${JSON.stringify(selectedProvider)}) {
      record({ kind: "child-state", model: { provider: ctx.model.provider, id: ctx.model.id }, thinkingLevel: pi.getThinkingLevel() });
    }
  });
  const respond = (step) => (context, _options, _state, model) => {
    if (isChild) { record({ kind: "wrong-child-dispatch" }); throw new Error("Provisional model received task"); }
    capture(context, model, "parent");
    return step(context);
  };
  parent.setResponses([
    respond(() => call("subagent_spawn", {
      task: "Return the synthetic child result.",
      provider: ${JSON.stringify(selectedProvider)}, model: ${JSON.stringify(childModel)},
      tools: [], extensions: [{ path: ${JSON.stringify(fixture)}, tools: [] }], thinkingLevel: "high",
    }, "spawn-literal-model")),
    respond((context) => {
      const result = resultOf(context, "subagent_spawn");
      record({ kind: "spawn-result", result });
      return call("subagent_wait", { jobId: result.jobId }, "wait-for-child");
    }),
    respond((context) => {
      record({ kind: "wait-result", result: resultOf(context, "subagent_wait") });
      return fauxAssistantMessage("First ordinary response.");
    }),
    respond(() => fauxAssistantMessage("Second ordinary response.")),
  ]);
  child.setResponses([(context, options, _state, model) => {
    capture(context, model, "child");
    record({ kind: "child-options", reasoning: options?.reasoning ?? null });
    return fauxAssistantMessage("Synthetic child result.");
  }]);
}
`;
}

function rpcHarness(args: string[], agentDir: string, signal: AbortSignal) {
  // Do not inherit provider secrets or real user credential/configuration directories.
  // This also removes any enclosing subagent's bootstrap environment.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: agentDir,
    USERPROFILE: agentDir,
    XDG_CONFIG_HOME: agentDir,
    XDG_CACHE_HOME: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
  const child = spawn(process.execPath, args, {
    cwd: resolve("."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let input = "";
  let counter = 0;
  let failure: Error | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let cleanup: Promise<void> | undefined;
  let didClose = false;
  const pending = new Map<
    string,
    { command: string; resolve: (record: RpcRecord) => void; reject: (error: Error) => void }
  >();
  const subscribers = new Set<(record: RpcRecord) => void>();
  const eventFailures = new Set<(error: Error) => void>();
  const rejectPending = (error: Error) => {
    failure ??= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    for (const reject of eventFailures) reject(failure);
    eventFailures.clear();
  };
  const closed = new Promise<number | null>((done) => {
    child.once("close", (code, closeSignal) => {
      didClose = true;
      rejectPending(new Error(`Pi RPC closed (${code ?? closeSignal}): ${stderr}`));
      done(code);
    });
  });
  child.on("error", rejectPending);
  child.stdin.on("error", rejectPending);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    input += chunk;
    while (true) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      if (Buffer.byteLength(input.slice(0, newline)) > 256 * 1024) {
        rejectPending(new Error("Pi RPC line exceeded the test limit"));
        child.kill("SIGTERM");
        return;
      }
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as RpcRecord;
        if (record.type === "response" && record.id) {
          const request = pending.get(record.id);
          if (request) {
            pending.delete(record.id);
            if (record.command !== request.command || record.success !== true) {
              request.reject(new Error(`Pi RPC ${request.command}: ${record.error ?? "invalid response"}`));
            } else request.resolve(record);
          }
        }
        for (const subscriber of subscribers) subscriber(record);
      } catch (error) {
        rejectPending(error instanceof Error ? error : new Error(String(error)));
        child.kill("SIGTERM");
      }
    }
    if (Buffer.byteLength(input) > 256 * 1024) {
      rejectPending(new Error("Pi RPC partial line exceeded the test limit"));
      child.kill("SIGTERM");
    }
  });
  const request = (command: string, fields: Record<string, unknown> = {}) => {
    if (failure) return Promise.reject(failure);
    return new Promise<RpcRecord>((done, reject) => {
      const id = `selection-${++counter}`;
      pending.set(id, { command, resolve: done, reject });
      child.stdin.write(`${JSON.stringify({ id, type: command, ...fields })}\n`);
    });
  };
  const dispose = () => {
    cleanup ??= (async () => {
      if (deadline) clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 500);
      try {
        const code = await closed;
        if (!signal.aborted && code !== 0) throw new Error(`Pi RPC did not close cleanly (${code}): ${stderr}`);
      } finally {
        clearTimeout(kill);
        subscribers.clear();
      }
    })();
    return cleanup;
  };
  const onAbort = () => {
    rejectPending(new Error("Pi RPC test was cancelled"));
    if (!didClose) child.kill("SIGTERM");
    void dispose();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    request,
    dispose,
    async ready() {
      const response = await request("get_state");
      signal.throwIfAborted();
      // Startup has no execution deadline; Vitest still owns the whole test's five-second limit.
      deadline = setTimeout(() => {
        rejectPending(new Error(`Pi RPC execution deadline exceeded: ${stderr}`));
        child.kill("SIGTERM");
      }, 3_000);
      return response;
    },
    async prompt(message: string) {
      // Install the event subscription before publishing the prompt, including synchronous providers.
      let onRecord: (record: RpcRecord) => void = () => undefined;
      let rejectEvent: (error: Error) => void = () => undefined;
      const settled = new Promise<void>((done, reject) => {
        rejectEvent = reject;
        onRecord = (record) => {
          if (record.type === "agent_settled") done();
        };
        subscribers.add(onRecord);
        eventFailures.add(rejectEvent);
      });
      try {
        await Promise.all([request("prompt", { message }), settled]);
      } finally {
        subscribers.delete(onRecord);
        eventFailures.delete(rejectEvent);
      }
    },
  };
}

const selections = [
  ...childModels.map((model) => ({
    model,
    provider: childProvider,
    caseCollision: false,
    startup: "normal" as Startup,
  })),
  ...["SELECTION-CHILD", childProvider].map((provider) => ({
    model: "shared",
    provider,
    caseCollision: true,
    startup: "normal" as Startup,
  })),
  ...(["default", "late", "missing", "unavailable"] as const).map((startup) => ({
    model: "child-only",
    provider: childProvider,
    caseCollision: false,
    startup,
  })),
];

for (const { model: childModel, provider: selectedProvider, caseCollision, startup } of selections) {
  test(`package-directory RPC preserves parent prefixes with exact child model ${selectedProvider}/${childModel} (${startup})`, async ({
    signal,
  }) => {
    const root = await mkdtemp(join(packageDirectory, ".model-selection-runtime-"));
    const agentDir = join(root, "agent");
    const fixture = join(root, "provider.ts");
    const evidence = join(root, "evidence.jsonl");
    const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
    let rpc: ReturnType<typeof rpcHarness> | undefined;
    try {
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: parentProvider,
          defaultModel: parentModel,
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
      );
      await writeFile(
        fixture,
        providerFixture(evidence, fixture, childModel, selectedProvider, caseCollision, startup),
      );
      rpc = rpcHarness(
        [
          cli,
          "--offline",
          "--no-extensions",
          "-e",
          "./packages/pi-subagents",
          "-e",
          fixture,
          "--mode",
          "rpc",
          "--no-session",
          "--no-skills",
          "--no-prompt-templates",
          "--no-mcp",
          "--no-themes",
          "--no-context-files",
          "--approve",
          "--tools",
          "subagent_spawn,subagent_inspect,subagent_cancel,subagent_wait,subagent_send",
          "--provider",
          parentProvider,
          "--model",
          parentModel,
          "--thinking",
          "high",
        ],
        agentDir,
        signal,
      );
      const initial = await rpc.ready();
      assert.deepEqual(
        { provider: initial.data?.model?.provider, id: initial.data?.model?.id },
        { provider: parentProvider, id: parentModel },
      );
      await rpc.prompt("First ordinary synthetic request.");
      assert.equal(
        (await rpc.request("get_last_assistant_text")).data?.text,
        "First ordinary response.",
        JSON.stringify(await rpc.request("get_messages")),
      );
      await rpc.prompt("Second ordinary synthetic request.");
      assert.equal((await rpc.request("get_last_assistant_text")).data?.text, "Second ordinary response.");
      const final = await rpc.request("get_state");
      assert.deepEqual(final.data?.model, initial.data?.model);
      assert.equal(final.data?.thinkingLevel, "high");

      const records = (await readFile(evidence, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<{
        kind: string;
        input: ProviderInput;
        model?: { provider: string; id: string };
        thinkingLevel?: string;
        reasoning?: string | null;
        available?: Array<{ provider: string; id: string }>;
        registered?: boolean;
        previousModel?: { provider: string; id: string };
        source?: string;
        result?: { jobId: string; state: string; result?: string; error?: string; timedOut?: boolean };
      }>;
      const parent = records.filter((record) => record.kind === "parent").map((record) => record.input);
      assert.equal(
        parent.length,
        4,
        "spawn, wait, final, and the next ordinary request must all reach the faux parent",
      );
      const baseline = parent[0];
      assert.ok(baseline);
      assert.deepEqual(baseline.names, [
        "subagent_spawn",
        "subagent_inspect",
        "subagent_cancel",
        "subagent_wait",
        "subagent_send",
      ]);
      const spawnTool = baseline.tools.find((tool) => tool.name === "subagent_spawn");
      assert.ok(spawnTool);
      for (const field of ["provider", "model"]) {
        assert.ok(spawnTool.parameters.properties[field], `${field} must reach the provider-visible schema`);
        assert.equal((spawnTool.parameters.properties[field] as { maxLength?: number }).maxLength, 16 * 1024);
        assert.equal(spawnTool.parameters.required?.includes(field) ?? false, false);
      }
      for (const [index, request] of parent.entries()) {
        assert.deepEqual(request.model, { provider: parentProvider, id: parentModel });
        assert.equal(request.systemPrompt, baseline.systemPrompt);
        assert.deepEqual(request.names, baseline.names);
        assert.deepEqual(request.tools, baseline.tools);
        const previous = parent[index - 1];
        if (previous) {
          assert.ok(request.messages.length > previous.messages.length);
          assert.deepEqual(request.messages.slice(0, previous.messages.length), previous.messages);
        }
        assert.equal(
          request.messages.some((message) => message.role === "toolResult" && message.isError),
          false,
        );
      }
      const spawnMessage = parent[1]?.messages.find((message) => message.role === "assistant");
      assert.ok(spawnMessage);
      assert.ok(Array.isArray(spawnMessage.content));
      const spawnCall = (spawnMessage.content as Array<{ type: string; arguments: Record<string, unknown> }>).find(
        (block) => block.type === "toolCall",
      );
      assert.ok(spawnCall);
      assert.equal(spawnCall.arguments.provider, selectedProvider);
      assert.equal(spawnCall.arguments.model, childModel);
      assert.deepEqual(spawnCall.arguments.tools, []);
      const admitted = records.find((record) => record.kind === "spawn-result")?.result;
      assert.ok(admitted?.jobId, "model lookup must not reject the spawn before job admission");
      assert.equal(admitted.state, "queued");
      const result = records.find((record) => record.kind === "wait-result")?.result;
      assert.ok(result);
      assert.equal(result.jobId, admitted.jobId);
      assert.equal(result.timedOut, false);
      assert.equal(
        records.some((record) => record.kind === "wrong-child-dispatch"),
        false,
      );
      if (startup !== "normal") {
        assert.equal(records.find((record) => record.kind === "parent-registration")?.registered, false);
      }
      if (startup === "missing" || startup === "unavailable") {
        assert.equal(result.state, "failed");
        assert.match(
          result.error ?? "",
          startup === "missing" ? /not registered as an exact chat model/ : /unavailable as an exact chat model/,
        );
        assert.equal(
          records.some((record) => ["child", "child-task-dispatch", "child-selection"].includes(record.kind)),
          false,
        );
        assert.equal(
          records.find((record) => record.kind === "child-before-probe")?.registered,
          startup === "unavailable",
        );
        assert.ok(records.some((record) => record.kind === "child-shutdown"));
        return;
      }
      if (startup === "late") {
        const start = records.find((record) => record.kind === "child-start");
        assert.deepEqual(start?.model, { provider: "unknown", id: "unknown" });
        assert.deepEqual(start?.available, []);
        assert.equal(start?.registered, false);
        assert.equal(records.find((record) => record.kind === "child-before-probe")?.registered, true);
      }
      if (startup === "late" || startup === "default") {
        const provisional =
          startup === "late" ? { provider: "unknown", id: "unknown" } : { provider: parentProvider, id: parentModel };
        assert.deepEqual(records.find((record) => record.kind === "child-before-probe")?.model, provisional);
        const selection = records.find((record) => record.kind === "child-selection");
        assert.ok(selection);
        assert.deepEqual(selection.previousModel, provisional);
        assert.deepEqual(selection.model, { provider: selectedProvider, id: childModel });
        assert.equal(selection.source, "set");
        const selectionIndex = records.indexOf(selection);
        assert.ok(selectionIndex > records.findIndex((record) => record.kind === "child-before-probe"));
        assert.ok(selectionIndex < records.findIndex((record) => record.kind === "child-task-dispatch"));
      }
      const children = records.filter((record) => record.kind === "child");
      assert.equal(
        children.length,
        1,
        `exact child task must run: ${JSON.stringify(records.find((record) => record.kind === "wait-result"))}`,
      );
      assert.deepEqual(children[0]?.input.model, { provider: selectedProvider, id: childModel });
      assert.deepEqual(children[0]?.input.names, ["subagent_send", "subagent_wait"]);
      assert.deepEqual(
        records.find((record) => record.kind === "child-state"),
        {
          kind: "child-state",
          model: { provider: selectedProvider, id: childModel },
          thinkingLevel: "off",
        },
      );
      assert.equal(records.find((record) => record.kind === "child-options")?.reasoning, null);
      assert.equal(result.state, "completed");
      assert.equal(result.result, "Synthetic child result.");
      assert.ok(records.some((record) => record.kind === "child-shutdown"));
    } finally {
      try {
        await rpc?.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}
