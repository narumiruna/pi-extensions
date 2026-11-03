import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type OAuthCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

interface SessionOptions {
  provider: Provider;
  extensionFactories?: ExtensionFactory[];
  sessionManager?: SessionManager;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
}

interface CompatibilityFixture {
  directory: string;
  credentials: InMemoryCredentialStore;
  createSession(options: SessionOptions): Promise<AgentSession>;
}

export async function withCoreCompatibilityFixture(
  run: (fixture: CompatibilityFixture) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-core-compatibility-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Compatibility fixtures must stay offline"));
  const credentials = new InMemoryCredentialStore();
  const sessions: AgentSession[] = [];
  const settingsManagers: SettingsManager[] = [];
  try {
    const runtime = await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    // Registration refreshes builtin availability too. A stored OAuth credential
    // selects stored-type checks instead of ambient API keys or credential files.
    const unusedCredential: OAuthCredential = {
      type: "oauth",
      access: "compat-unused-access",
      refresh: "compat-unused-refresh",
      expires: Number.MAX_SAFE_INTEGER,
    };
    for (const provider of runtime.getProviders()) {
      await credentials.modify(provider.id, async () => ({ ...unusedCredential }));
    }
    await run({
      directory,
      credentials,
      async createSession(options) {
        runtime.registerNativeProvider(options.provider);
        const refreshed = await runtime.refresh({ allowNetwork: false });
        assert.deepEqual([...refreshed.errors], []);
        const model = options.provider.getModels()[0];
        assert.ok(model);
        const settingsManager = SettingsManager.inMemory({
          enableInstallTelemetry: false,
          enableAnalytics: false,
          cacheWarming: "off",
          retry: { enabled: false },
          compaction: { enabled: false },
          ...options.settings,
        });
        settingsManagers.push(settingsManager);
        const resourceLoader = new DefaultResourceLoader({
          cwd: directory,
          agentDir: directory,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          agentsFilesOverride: () => ({ agentsFiles: [] }),
          extensionFactories: options.extensionFactories ?? [],
        });
        await resourceLoader.reload();
        assert.deepEqual(resourceLoader.getExtensions().errors, []);
        const { session } = await createAgentSession({
          cwd: directory,
          agentDir: directory,
          modelRuntime: runtime,
          model,
          resourceLoader,
          settingsManager,
          sessionManager: options.sessionManager ?? SessionManager.inMemory(directory),
          noTools: "builtin",
          thinkingLevel: "off",
        });
        sessions.push(session);
        await session.bindExtensions({ mode: "print" });
        return session;
      },
    });
    assert.equal(network.mock.calls.length, 0, "no builtin or synthetic provider may dispatch network requests");
  } finally {
    try {
      for (const session of sessions) {
        try {
          await session.abort();
        } finally {
          session.dispose();
        }
      }
      for (const settings of settingsManagers) await settings.flush();
    } finally {
      network.mockRestore();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  }
}
