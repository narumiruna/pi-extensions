// Public-SDK package smoke worker. The parent supplies a private agent directory before this module loads.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type ToolCall,
  type TranscriptContext,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface PackageCommand {
  op: "invoke" | "release" | "evidence" | "arm-report-crash" | "shutdown";
  name?: string;
  params?: ToolCall["arguments"];
  task?: string;
}
export interface PackageRequest {
  system: string;
  tools: unknown[];
  messages: { role: string; content: unknown }[];
}
export interface PackageEvidence {
  sessionFile: string;
  sessionId: string;
  entries: unknown[];
  mainRequests: PackageRequest[];
  childRequests: PackageRequest[];
  errors: string[];
  activeTools: string[];
  originalAgentSession: boolean;
}
export interface PackageToolResult {
  value: Record<string, unknown>;
  details: unknown;
  toolCallId: string;
}

if (process.argv[2] === "--durable-package-worker") {
  const root = process.argv[3];
  const packageEntry = process.argv[4];
  const originalFile = process.argv[5];
  const blocks = new Set<string>(JSON.parse(process.argv[6] ?? "[]"));
  assert.ok(root && packageEntry && process.send);
  assert.equal(getAgentDir(), join(root, "agent"));
  const send = (frame: unknown) => {
    if (process.connected) process.send?.(frame, () => {});
  };
  send({ event: "booted" });
  const releases = new Map<string, Set<() => void>>();
  const actions = new Map<string, { name: string; params: ToolCall["arguments"] }>();
  const mainRequests: PackageRequest[] = [];
  const childRequests: PackageRequest[] = [];
  const normalize = (request: TranscriptContext): PackageRequest => ({
    system: getCurrentSystemPrompt(request.messages),
    tools: getCurrentTools(request.messages).map(toToolDeclaration),
    messages: structuredClone(request.messages.map(({ role, content }) => ({ role, content }))),
  });
  // Stable provider/model identity is necessary when reopening a saved child profile in a fresh process.
  const faux = createFauxCore({
    api: "durable-package-synthetic",
    provider: "durable-package-synthetic",
    tokenSize: { min: 100_000, max: 100_000 },
    models: [{ id: "main", contextWindow: 100_000, maxTokens: 1_000 }],
  });
  faux.setResponses(
    Array.from({ length: 100 }, () => async (request, options) => {
      const child = getCurrentSystemPrompt(request.messages).includes("You are an isolated subagent.");
      (child ? childRequests : mainRequests).push(normalize(request));
      const user = [...request.messages].reverse().find((message) => message.role === "user");
      const text =
        typeof user?.content === "string"
          ? user.content
          : user?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      if (child) {
        // This handshake proves the real generated package has dispatched its durable child provider.
        const gate = blocks.has(text ?? "")
          ? new Promise<void>((resolve) => {
              const waiters = releases.get(text ?? "") ?? new Set<() => void>();
              releases.set(text ?? "", waiters);
              waiters.add(resolve);
            })
          : undefined;
        send({ event: `child:${text}`, data: normalize(request) });
        if (gate)
          await awaitWithContext(
            gate,
            withAbortSignal(options?.signal ?? new AbortController().signal, BACKGROUND_CONTEXT),
          );
        return fauxAssistantMessage(`child:${text}`);
      }
      const action = actions.get(text ?? "");
      if (action && request.messages.at(-1)?.role === "user")
        return fauxAssistantMessage([fauxToolCall(action.name, action.params, { id: `call-${text}` })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage("Original package main answer");
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(modelRuntime);
  registry.registerProvider(faux.provider, {
    api: faux.api,
    apiKey: "synthetic-only",
    baseUrl: "http://localhost:0",
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const model = registry.find(faux.provider, "main");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  assert.equal(settingsManager.isProjectTrusted(), true);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    systemPrompt: "Original package main instructions.",
    // A directory, not a source factory: the same discovery path as `pi --no-extensions -e <package>`.
    additionalExtensionPaths: [packageEntry],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.match(loader.getExtensions().extensions[0]?.resolvedPath ?? "", /[/\\]dist[/\\]index\.ts$/u);
  const manager = originalFile
    ? SessionManager.open(originalFile)
    : SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: getAgentDir(),
    modelRuntime,
    model,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: "builtin",
    thinkingLevel: "off",
  });
  assert.ok(session instanceof AgentSession);
  assert.equal(session.sessionManager, manager);
  const errors: string[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") send({ event: `tool:${event.toolName}` });
  });
  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(JSON.stringify(error)) });
  assert.deepEqual(errors, []);
  if (!originalFile) await session.prompt("original-main-user");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  if (originalFile) assert.equal(sessionFile, originalFile);
  assert.deepEqual(session.getActiveToolNames(), [
    "subagent_spawn",
    "subagent_send",
    "subagent_stop",
    "subagent_status",
    "subagent_wait",
  ]);
  async function invoke(name: string, params: ToolCall["arguments"]): Promise<PackageToolResult> {
    const key = `action-${process.pid}-${actions.size}`;
    actions.set(key, { name, params });
    // Real model-issued calls pass Pi's native registered-tool wrappers, validation and real context.
    await session.prompt(key);
    assert.deepEqual(errors, []);
    const result = [...session.messages]
      .reverse()
      .find((message) => message.role === "toolResult" && message.toolCallId === `call-${key}`);
    assert.ok(result?.role === "toolResult");
    assert.ok(!result.isError, JSON.stringify(result));
    const content = result.content.find((block) => block.type === "text");
    assert.ok(content?.type === "text");
    return { value: JSON.parse(content.text), details: result.details, toolCallId: result.toolCallId };
  }
  async function shutdown() {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  let crashArmed = false;
  const append = manager.appendCustomMessageEntry.bind(manager);
  manager.appendCustomMessageEntry = (...args: Parameters<typeof append>) => {
    const id = append(...args);
    if (crashArmed && args[0] === "pi-subagents.durable-report.v1") {
      // Stop only AFTER Pi's actual public append wrote the original file, BEFORE sendMessage returns.
      // No mock receipts, altered durable state, lease deletion, or production checkpoints are used.
      send({ event: "report:appended", data: { entryId: id, sessionFile } });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return id;
  };
  process.on("message", (command: PackageCommand & { id: number }) => {
    void (async () => {
      switch (command.op) {
        case "invoke":
          return invoke(command.name ?? "", command.params ?? {});
        case "release":
          blocks.delete(command.task ?? "");
          for (const release of releases.get(command.task ?? "") ?? []) release();
          releases.delete(command.task ?? "");
          return null;
        case "arm-report-crash":
          crashArmed = true;
          return null;
        case "evidence":
          return {
            sessionFile,
            sessionId: manager.getSessionId(),
            entries: (await readFile(sessionFile as string, "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
            mainRequests,
            childRequests,
            errors,
            activeTools: session.getActiveToolNames(),
            originalAgentSession: session instanceof AgentSession && session.sessionManager === manager,
          } satisfies PackageEvidence;
        case "shutdown":
          await shutdown();
          return null;
      }
    })().then(
      (value) => send({ id: command.id, value }),
      (error: unknown) => send({ id: command.id, error: String(error) }),
    );
  });
  process.once("disconnect", () => {
    void shutdown().finally(() => process.exit(0));
  });
  send({ event: "ready", data: { sessionFile, sessionId: manager.getSessionId() } });
}
