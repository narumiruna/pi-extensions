import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolCall, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionContext,
  ExtensionError,
  ExtensionUIContext,
  SessionManager as NativeSessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOffline = process.env.PI_OFFLINE;
const smokeRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-scope-runtime-")));
const agentDir = join(smokeRoot, "agent");
mkdirSync(agentDir);
// Set infrastructure variables before Pi or the extension graph is imported.
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

export const sdk = await import("@earendil-works/pi-coding-agent");
const { runToolCall } = await import("@earendil-works/pi-agent-core");
export const packageDir = fileURLToPath(new URL("..", import.meta.url));
export const entrypoint = join(packageDir, "src", "index.ts");
const smokeModel: Model<"openai-completions"> = {
  id: "scope-offline-fixture",
  name: "Scope offline fixture",
  api: "openai-completions",
  provider: "scope-offline-fixture",
  baseUrl: "http://127.0.0.1:1/not-used",
  reasoning: false,
  input: ["text"],
  contextWindow: 262_144,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function assistant(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: smokeModel.api,
    provider: smokeModel.provider,
    model: smokeModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

export function createFixture() {
  const cwd = mkdtempSync(join(smokeRoot, "workspace-"));
  const allowed = join(cwd, "allowed.txt");
  const outside = join(cwd, "outside.txt");
  const reserved = join(cwd, "not-created", "new.txt");
  const shellMarker = join(cwd, "shell-marker.txt");
  writeFileSync(allowed, "allowed original\n");
  writeFileSync(outside, "outside original\n");
  const manager = sdk.SessionManager.create(cwd, join(cwd, "sessions"));
  // Custom entries alone intentionally do not flush a new native session file.
  const beforeScope = manager.appendMessage({ role: "user", content: "Offline smoke fixture", timestamp: 1 });
  const snapshot = {
    version: 1,
    cwd,
    targets: [allowed, reserved].map((path) => ({ path, canonical: path })),
  };
  const scopeEntry = manager.appendCustomEntry("scope-state", snapshot);
  manager.appendMessage(assistant());
  return { cwd, allowed, outside, reserved, shellMarker, manager, beforeScope, scopeEntry, snapshot };
}
export type SmokeFixture = ReturnType<typeof createFixture>;

export async function createNativeSession(
  fixture: SmokeFixture,
  options: {
    manager?: NativeSessionManager;
    mode?: ExtensionContext["mode"];
    uiContext?: ExtensionUIContext;
    customTools?: ToolDefinition[];
    codemode?: "on" | "only";
    discovery?: boolean;
  } = {},
) {
  if (options.discovery) {
    const extensions = join(fixture.cwd, ".pi", "extensions");
    mkdirSync(extensions, { recursive: true });
    symlinkSync(packageDir, join(extensions, "edit-scope"), "dir");
  }
  const settingsManager = sdk.SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    ...(options.codemode ? { codemode: { mode: options.codemode } } : {}),
  });
  settingsManager.setProjectTrusted(true);
  const loader = new sdk.DefaultResourceLoader({
    cwd: fixture.cwd,
    agentDir,
    settingsManager,
    noExtensions: !options.discovery,
    additionalExtensionPaths: [
      ...(options.discovery ? [] : [packageDir]),
      ...(options.codemode ? ["builtin:codemode"] : []),
    ],
    extensionFactories: options.codemode
      ? [{ name: "codemode", builtin: true, factory: sdk.createCodemodeExtension() }]
      : [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  if (loader.getExtensions().errors.length) {
    throw new Error(`Scope loader errors: ${JSON.stringify(loader.getExtensions().errors)}`);
  }
  const customTools = options.customTools ?? [];
  const { session } = await sdk.createAgentSession({
    cwd: fixture.cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: options.manager ?? fixture.manager,
    settingsManager,
    customTools,
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "ls",
      "grep",
      "find",
      ...customTools.map((tool) => tool.name),
      ...(options.codemode ? ["codemode"] : []),
    ],
    model: smokeModel,
    thinkingLevel: "off",
  });
  const errors: ExtensionError[] = [];
  await session.bindExtensions({
    mode: options.mode ?? "rpc",
    ...(options.uiContext ? { uiContext: options.uiContext } : {}),
    onError: (error) => errors.push(error),
  });
  return { session, loader, errors };
}

let nextCall = 0;
/** Use Pi's exported native pipeline, including schema validation and both session hooks. */
export async function callTool(
  session: AgentSession,
  name: string,
  args: AgentToolCall["arguments"],
  signal?: AbortSignal,
): Promise<AgentToolCallOutcome> {
  const toolCall: AgentToolCall = { type: "toolCall", id: `smoke-${++nextCall}`, name, arguments: args };
  return runToolCall(toolCall, {
    assistantMessage: assistant([toolCall]),
    context: { messages: session.messages, tools: session.agent.state.tools },
    tools: session.agent.state.tools,
    beforeToolCall: session.agent.beforeToolCall,
    afterToolCall: session.agent.afterToolCall,
    signal,
  });
}

export function resultText(outcome: AgentToolCallOutcome): string {
  return outcome.result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function disposeNativeSession(session: AgentSession): Promise<void> {
  try {
    await session.abort();
    // AgentSession.dispose() invalidates contexts but does not emit the host-owned shutdown event.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

export function cleanupSmokeRoot(): void {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  rmSync(smokeRoot, { recursive: true, force: true });
}
