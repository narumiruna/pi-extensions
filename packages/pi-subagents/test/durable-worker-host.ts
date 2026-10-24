// Test-only SDK host in the crashable worker, not a production extension bridge.
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { DurableFixture } from "./durable-fixture.js";
import { DurableHost, HOST_REPORT } from "./durable-host.js";

export async function openWorkerHost(directory: string, sessionFile?: string) {
  const manager = sessionFile
    ? SessionManager.open(sessionFile)
    : SessionManager.create(directory, path.join(directory, "main-sessions"));
  if (!sessionFile) manager.appendMessage({ role: "user", content: "Synthetic main conversation", timestamp: 1 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Stable test host",
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    resourceLoader,
    sessionManager: manager,
    settingsManager,
    noTools: "all",
  });
  const host = new DurableHost(session);
  return {
    info: () => ({
      sessionId: session.sessionId,
      sessionFile: manager.getSessionFile(),
      intents: host.intents(),
      reports: manager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === HOST_REPORT),
    }),
    admit(agentId: string, task: string) {
      return host.admit({
        sessionId: session.sessionId,
        requestId: `spawn:${agentId}`,
        agentId,
        runId: `${agentId}:1`,
        task,
      });
    },
    async deliver(fixture: DurableFixture, reportId: string): Promise<string> {
      const report = (await fixture.state()).reports[reportId];
      if (!report) throw new Error("Missing durable report");
      const receipt = host
        .intents()
        .find(({ intent }) => intent.runId === report.runId && intent.agentId === report.agentId);
      if (!receipt) throw new Error("Missing durable admission receipt");
      return host.deliver({
        intentEntryId: receipt.entryId,
        reportId: report.id,
        intent: receipt.intent,
        content: report.result,
      });
    },
    dispose() {
      host.dispose();
      session.dispose();
    },
  };
}
