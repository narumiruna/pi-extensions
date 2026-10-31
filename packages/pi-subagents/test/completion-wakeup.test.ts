import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import type { MessageBroker } from "../src/message-broker.js";
import type { SubagentRuntime } from "../src/runtime.js";
import type { ChildResult } from "../src/types.js";

test.each(["idle", "running", "settling"] as const)(
  "completion resumes the main agent while %s through Pi's native delivery",
  async (timing) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-wakeup-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    vi.resetModules();
    const child = Promise.withResolvers<ChildResult>();
    const mainEntered = Promise.withResolvers<void>();
    const releaseMain = Promise.withResolvers<void>();
    const result: ChildResult = {
      state: "completed",
      result: "Late child result.",
      limitations: [],
      truncated: false,
    };
    let session: AgentSession | undefined;
    let runtime: SubagentRuntime | undefined;
    let broker: MessageBroker | undefined;
    let prompt: Promise<void> | undefined;
    try {
      const [
        { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager },
        transport,
        jobs,
      ] = await Promise.all([
        import("@earendil-works/pi-coding-agent"),
        import("../src/message-broker.js"),
        import("../src/runtime.js"),
      ]);
      const provider = fauxProvider({ provider: "subagents-wakeup", tokensPerSecond: 0 });
      const requests: Pick<Message, "role" | "content">[][] = [];
      provider.setResponses([
        async (context) => {
          requests.push(context.messages.map(({ role, content }) => ({ role, content: structuredClone(content) })));
          mainEntered.resolve();
          if (timing === "running") await releaseMain.promise;
          return fauxAssistantMessage("Main task finished.");
        },
        (context) => {
          requests.push(context.messages.map(({ role, content }) => ({ role, content: structuredClone(content) })));
          return fauxAssistantMessage("Main agent handled the completion.");
        },
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStorePath: join(directory, "models-store.json"),
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(provider.provider);
      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      const messageBroker = new transport.MessageBroker({ onMessage() {} });
      broker = messageBroker;
      let jobId = "";
      let starts = 0;
      let deliveredDuringSettle = false;
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => {
            const owner = new jobs.SubagentRuntime(pi, messageBroker, { runChild: () => child.promise });
            runtime = owner;
            pi.on("session_start", async () => {
              await messageBroker.start();
              owner.beginSession();
            });
            pi.on("before_agent_start", () => {
              starts++;
            });
            pi.on("agent_settled", async () => {
              if (timing !== "settling" || deliveredDuringSettle) return;
              deliveredDuringSettle = true;
              child.resolve(result);
              await owner.wait(jobId, undefined);
            });
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const created = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime,
        model: provider.getModel(),
        settingsManager,
        sessionManager: SessionManager.inMemory(directory),
        resourceLoader: loader,
        tools: [],
        thinkingLevel: "off",
      });
      session = created.session;
      const errors: unknown[] = [];
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      assert.ok(runtime);
      jobId = runtime.start({
        task: "Finish after the main agent.",
        tools: [],
        skills: [],
        extensions: [],
        toolSources: {},
        provider: provider.getModel().provider,
        model: provider.getModel().id,
        thinkingLevel: "off",
        defaultThinkingLevel: "off",
        cwd: directory,
        projectTrusted: false,
      }).jobId;
      prompt = session.prompt("Do the main task.");
      if (timing === "idle") {
        await prompt;
        assert.equal(session.isIdle, true);
        assert.equal(session.getLastAssistantText(), "Main task finished.");
      } else if (timing === "running") {
        await mainEntered.promise;
        assert.equal(session.isIdle, false);
      }
      if (timing !== "settling") {
        child.resolve(result);
        await runtime.wait(jobId, undefined);
        releaseMain.resolve();
      }
      await prompt;
      await session.waitForIdle();

      assert.deepEqual(errors, []);
      assert.equal(provider.state.callCount, 2);
      assert.equal(starts, timing === "running" ? 1 : 2);
      assert.equal(session.getLastAssistantText(), "Main agent handled the completion.");
      assert.equal(
        session.messages.filter(
          (message) => message.role === "custom" && message.customType === "pi-subagents-completion",
        ).length,
        1,
      );
      assert.match(JSON.stringify(requests[1]), /Late child result\./u);
      assert.deepEqual(requests[1]?.slice(0, requests[0]?.length), requests[0]);
    } finally {
      releaseMain.resolve();
      child.resolve(result);
      try {
        await runtime?.shutdown();
        await session?.abort();
        await prompt;
      } finally {
        session?.dispose();
        try {
          await broker?.shutdown();
        } finally {
          vi.unstubAllEnvs();
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  },
);
