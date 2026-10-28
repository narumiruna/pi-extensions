import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export interface RestartRequest {
  operation: "seed" | "resume" | "inspect";
  status: "completed" | "pending" | "in_progress" | "blocked";
  mode: "tui" | "rpc";
  compacted: boolean;
  file?: string;
}

export interface RestartResult {
  file: string;
  pid: number;
}

// Each worker imports Pi and loads the published entrypoint in its own process.
// The parent supplies PI_CODING_AGENT_DIR before these imports run.
const root = process.argv[2];
assert.ok(root);
initTheme("dark");
const provider = fauxProvider({ provider: "progress-restart", tokensPerSecond: Infinity });
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  modelsStorePath: join(root, "models-store.json"),
  refreshOnCreate: false,
});
modelRuntime.registerNativeProvider(provider.provider);
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir: root,
  settingsManager,
  additionalExtensionPaths: [resolve("packages/pi-progress")],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert.equal(loader.getExtensions().extensions.length, 1);

async function run(request: RestartRequest): Promise<RestartResult> {
  const manager =
    request.operation === "seed"
      ? SessionManager.create(root, join(root, "sessions"))
      : SessionManager.open(assertFile(request.file));
  const originalBytes = request.file ? readFileSync(request.file, "utf8") : undefined;
  const originalEntries = structuredClone(manager.getEntries());
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model: provider.getModel(),
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    tools: ["update_progress"],
    thinkingLevel: "off",
  });
  const errors: unknown[] = [];
  const widgets: Array<string[] | undefined> = [];
  const notifications: string[] = [];
  const baseUI = session.extensionRunner.getUIContext();
  let mounted: (Component & { dispose?(): void }) | undefined;
  const renderMounted = () => widgets.push(mounted?.render(80).map(stripVTControlCharacters));
  const tui = { terminal: { rows: 36 }, requestRender: renderMounted } as unknown as TUI;
  const ui: ExtensionUIContext = {
    ...baseUI,
    setWidget(key, content) {
      assert.equal(key, "progress");
      if (request.mode === "rpc" && typeof content === "function") {
        throw new Error("RPC must receive string lines, not component factories");
      }
      mounted?.dispose?.();
      mounted = undefined;
      if (typeof content === "function") {
        mounted = content(tui, ui.theme);
        renderMounted();
      } else {
        widgets.push(content?.map(stripVTControlCharacters));
      }
    },
    notify(message) {
      notifications.push(message);
    },
  };
  const status = request.operation === "inspect" ? "pending" : request.status;
  const expectedSteps = [{ text: request.operation === "inspect" ? "follow-up task" : "saved task", status }];
  const assertVisible = (visible: boolean, text = expectedSteps[0].text) => {
    assert.equal(widgets.at(-1) !== undefined, visible, "restored widget visibility");
    if (visible) assert.ok(widgets.at(-1)?.some((line) => line.includes(text)));
  };
  const update = async (steps: typeof expectedSteps) => {
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("update_progress", { steps }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Saved."),
    ]);
    await session.prompt("Update the progress.");
    const result = [...session.messages].reverse().find((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false);
    assert.deepEqual(result.details, { version: 5, steps });
  };
  const clear = async () => {
    const file = assertFile(manager.getSessionFile());
    const bytes = readFileSync(file, "utf8");
    const context = structuredClone(session.messages);
    await session.prompt("/progress clear");
    assertVisible(false);
    assert.match(notifications.at(-1) ?? "", /Saved progress is unchanged/u);
    assert.equal(readFileSync(file, "utf8"), bytes, "clear must not change the session file");
    assert.deepEqual(session.messages, context, "clear must not change model context");
  };
  try {
    await session.bindExtensions({ mode: request.mode, uiContext: ui, onError: (error) => errors.push(error) });
    if (request.operation === "seed") {
      await update(expectedSteps);
      await clear();
      if (request.compacted) {
        // Use Pi's persistence API, not a hand-constructed in-memory branch.
        // No retained messages: the progress context must be reconstructed on reopen.
        manager.appendCompaction("Earlier work was summarized.", null, 100);
      }
    } else {
      assertVisible(status !== "completed");
      assert.ok(
        widgets.every((lines) => status !== "completed" || lines === undefined),
        "startup must not transiently replay the completion summary",
      );
      assert.equal(
        readFileSync(assertFile(request.file), "utf8"),
        originalBytes,
        "opening the session must preserve its bytes",
      );
      assert.deepEqual(manager.getEntries(), originalEntries);

      // Capture the real model request after Pi's context hooks have run.
      let seen: TranscriptContext["messages"] | undefined;
      provider.setResponses([
        (context) => {
          seen = structuredClone(context.messages);
          return fauxAssistantMessage("Restored.");
        },
      ]);
      await session.prompt("What progress was saved?");
      assert.ok(seen);
      if (request.compacted) {
        const restored = seen
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
          )
          .filter((text) => text.startsWith("[PI PROGRESS STATUS v5]"));
        assert.equal(restored.length, 1, "one model-visible restored progress block");
        assert.ok(restored[0].endsWith(JSON.stringify({ steps: [{ text: "saved task", status: request.status }] })));
        const boundaries = manager
          .getEntries()
          .filter((entry) => entry.type === "custom" && entry.customType === "progress-restored-context-boundary");
        assert.equal(boundaries.length, 1, "persist or reuse exactly one restored boundary across processes");
      }
      if (!request.compacted || request.operation === "inspect") {
        const calls = seen.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter((block) => block.type === "toolCall" && block.name === "update_progress")
            : [],
        );
        const call = calls.at(-1);
        assert.ok(call?.type === "toolCall");
        assert.deepEqual(call.arguments, { steps: expectedSteps });
      }
      assertVisible(status !== "completed");

      if (request.operation === "resume") {
        await clear();
        const progressEntry = manager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolName === "update_progress",
          );
        assert.ok(progressEntry);
        const returnTo = manager.getLeafId();
        assert.ok(returnTo);
        assert.equal((await session.navigateTree(progressEntry.id, { summarize: false })).cancelled, false);
        assertVisible(true);
        assert.equal((await session.navigateTree(returnTo, { summarize: false })).cancelled, false);
        assertVisible(true);
        await clear();
        await update([{ text: "follow-up task", status: "pending" }]);
        assertVisible(true, "follow-up task");
      }
      // All original entries, including compacted tool details, remain byte-for-byte intact.
      assert.ok(readFileSync(assertFile(request.file), "utf8").startsWith(originalBytes ?? ""));
      assert.deepEqual(manager.getEntries().slice(0, originalEntries.length), originalEntries);
    }
    assert.deepEqual(errors, []);
    return { file: assertFile(manager.getSessionFile()), pid: process.pid };
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assertVisible(false);
    session.dispose();
  }
}

function assertFile(file: string | undefined): string {
  assert.ok(file);
  return file;
}

process.once("message", (request: RestartRequest) => {
  void run(request).then(
    (result) => process.send?.({ result }, () => process.disconnect?.()),
    (error: unknown) => {
      process.exitCode = 1;
      process.send?.({ error: error instanceof Error ? error.stack : String(error) }, () => process.disconnect?.());
    },
  );
});
process.send?.({ ready: true });
