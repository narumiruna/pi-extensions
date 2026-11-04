import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { onTestFinished, test } from "vitest";
import { latestTokensPerSecond } from "../src/usage.js";

test("the generated package renders persisted response rates through real AgentSession tool and turn events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "starship-throughput-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  let session: AgentSession | undefined;
  let footer: (Component & { dispose?(): void }) | undefined;
  onTestFinished(async () => {
    try {
      await session?.abort();
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
      footer?.dispose?.();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const path = join(directory, "pi-starship.toml");
  writeFileSync(path, 'format = "$tokens_per_second"\n[tokens_per_second]\ndisabled = false\n');
  const { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
  const provider = fauxProvider({ provider: "starship-throughput-test", tokensPerSecond: Infinity });
  provider.setResponses([
    { ...fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }), durationMs: 2000 },
    { ...fauxAssistantMessage("x".repeat(480)), durationMs: 4000 },
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-store.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  const text = () => stripVTControlCharacters((footer?.render(80) ?? []).join("\n"));
  const messageEnds: boolean[] = [];
  const tools: { text: string; output?: number }[] = [];
  const turns: { text: string; output: number; durationMs?: number }[] = [];
  const observer: ExtensionFactory = (pi) => {
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") {
        messageEnds.push(
          manager.getBranch().some((entry) => entry.type === "message" && entry.message === event.message),
        );
      }
    });
    pi.on("tool_call", () => {
      const latest = manager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      tools.push({
        text: text(),
        output:
          latest?.type === "message" && latest.message.role === "assistant" ? latest.message.usage.output : undefined,
      });
    });
    pi.on("turn_end", (event) => {
      if (event.message.role === "assistant") {
        turns.push({ text: text(), output: event.message.usage.output, durationMs: event.message.durationMs });
      }
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    extensionFactories: [observer],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model: provider.getModel(),
    settingsManager,
    sessionManager: manager,
    resourceLoader: loader,
    tools: ["read"],
    thinkingLevel: "off",
  }));
  const errors: unknown[] = [];
  const renders: string[] = [];
  const ui: ExtensionUIContext = {
    ...session.extensionRunner.getUIContext(),
    setFooter(factory) {
      footer?.dispose?.();
      footer = factory?.(
        {
          requestRender() {
            renders.push(text());
          },
        } as never,
        ui.theme,
        {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => undefined,
        } as never,
      );
    },
  };
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error) });
  assert.equal(text(), "");
  await session.prompt("Read the settings and finish.");
  assert.equal(provider.state.callCount, 2);
  assert.deepEqual(messageEnds, [false, false], "message_end runs before persistence");
  assert.equal(tools.length, 1);
  assert.ok(tools[0]?.output !== undefined);
  assert.equal(tools[0].text, `${(tools[0].output / 2).toFixed(1)} tok/s `);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.durationMs, 2000);
  assert.deepEqual(turns[1], { text: "30.0 tok/s ", output: 120, durationMs: 4000 });
  assert.equal(text(), "30.0 tok/s ");
  assert.ok(renders.includes("30.0 tok/s "), "existing event hooks request a fresh render");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const resumed = SessionManager.open(sessionFile);
  assert.equal(latestTokensPerSecond(resumed.getBranch()), 30, "disk-backed resume preserves response timing");
  assert.deepEqual(errors, []);
});
