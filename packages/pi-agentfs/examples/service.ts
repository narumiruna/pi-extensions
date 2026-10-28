/**
 * No-model SDK startup check. The service must authorize this database path first.
 * From the repository root, run npm run build, then run:
 * node --experimental-strip-types packages/pi-agentfs/examples/service.ts /approved/absolute/workspace.db
 * The database parent must already exist. This does not implement authentication.
 */
import assert from "node:assert/strict";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionError,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAgentfsExtension } from "@narumitw/pi-agentfs";

const approvedPath = process.argv[2];
if (process.argv.length !== 3 || !approvedPath) {
  throw new Error("Pass one service-approved absolute database path with an existing parent directory.");
}

const expectedTools = ["read", "write", "edit", "bash"];
const extension = createAgentfsExtension({ path: approvedPath });
const settingsManager = SettingsManager.inMemory({
  defaultTools: expectedTools,
  enableSkillCommands: false,
  cacheWarming: "off",
  compaction: { enabled: false },
  retry: { enabled: false },
});
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsStore: new InMemoryModelsStore(),
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});

// This cwd is only Pi metadata. It is not a host filesystem restriction.
const cwd = "/";
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir: "/",
  settingsManager,
  extensionFactories: [extension],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  // noContextFiles does not disable SYSTEM.md or APPEND_SYSTEM.md discovery.
  systemPrompt: "Use only the AgentFS workspace tools. All tool paths are virtual paths.",
  appendSystemPrompt: [],
});
await resourceLoader.reload();
const loaded = resourceLoader.getExtensions();
if (loaded.errors.length) throw new Error("AgentFS extension loading failed; session creation refused.");
assert.equal(loaded.extensions.length, 1, "Only the supplied factory may load");
const registered = loaded.extensions[0];
assert.ok(registered);
assert.deepEqual([...registered.tools.keys()].sort(), [...expectedTools].sort());
assert.deepEqual(resourceLoader.getSkills().skills, []);
assert.deepEqual(resourceLoader.getPrompts().prompts, []);
assert.deepEqual(resourceLoader.getThemes().themes, []);
assert.deepEqual(resourceLoader.getAgentsFiles().agentsFiles, []);

const { session, extensionsResult } = await createAgentSession({
  cwd,
  agentDir: "/",
  modelRuntime,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.inMemory(cwd),
  tools: ["read", "write", "edit", "bash"],
});
const errors: ExtensionError[] = [];
async function closeSession(): Promise<void> {
  const previousErrors = errors.length;
  try {
    try {
      await session.abort();
    } finally {
      // In the tested Pi runtime dispose() alone does not emit session_shutdown.
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
  } finally {
    session.dispose();
  }
  if (errors.length !== previousErrors) throw new Error("AgentFS workspace shutdown failed.");
}

try {
  if (extensionsResult.errors.length) throw new Error("Session extension loading failed.");
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  // Pi can catch session_start failures. A resolved bindExtensions() is not readiness.
  await extension.ready(session.sessionManager);
  if (errors.length) throw new Error("AgentFS extension startup failed.");

  // Check declarations, nested-tool reach, registry contents, and replacement ownership.
  for (const names of [
    session.getActiveToolNames(),
    session.getCallableToolNames(),
    session.getAllTools().map((tool) => tool.name),
  ]) {
    assert.deepEqual([...names].sort(), [...expectedTools].sort());
  }
  for (const name of expectedTools) {
    assert.equal(session.getToolDefinition(name), registered.tools.get(name)?.definition);
  }
  // Admit service requests only here. This sample makes no prompt or model calls.
} finally {
  await closeSession();
}
