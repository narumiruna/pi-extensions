import assert from "node:assert/strict";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runBtwThread } from "../src/btw.js";
import { createSideThread } from "../src/side-thread.js";

const selectedModel: Model<"anthropic-messages"> = {
  id: "side-appearance-model",
  name: "Side fixture",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://127.0.0.1:1",
  input: ["text"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};
const mainModel = { ...selectedModel, id: "main-model-not-side" };

function state() {
  return {
    id: "side-test",
    thread: createSideThread("immutable side context"),
    thinkingLevel: "low" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

function answer(): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: selectedModel.id,
    content: [{ type: "text", text: "late answer" }],
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("the real idle composer displays the selected side model, not the live main model", async () => {
  initTheme("dark");
  const tui = createTuiHarness({ width: 120, rows: 24 });
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    model: mainModel,
    editorText: "main draft",
    custom: tui.custom,
  });
  const threadState = state();
  const originalModel = structuredClone(selectedModel);
  const running = runBtwThread({
    selected: { model: selectedModel },
    thinkingLevel: "low",
    state: threadState,
    ctx: mock.ctx,
  });
  await tui.waitForOpen();
  const frame = tui.render(120).join("\n");
  tui.send("\u0003");
  assert.deepEqual(await running, { kind: "closed" });
  assert.match(frame, /anthropic\/side-appearance-model/u);
  assert.doesNotMatch(frame, /main-model-not-side/u);
  assert.match(frame, /thinking low/u);
  assert.equal(mock.editorText, "main draft");
  assert.deepEqual(threadState.thread.turns, []);
  assert.deepEqual(selectedModel, originalModel);
});

test("the real answering view uses display-only side metadata without changing the provider request", async () => {
  initTheme("dark");
  const tui = createTuiHarness({ width: 120, rows: 24 });
  let complete!: (message: AssistantMessage) => void;
  const completion = new Promise<AssistantMessage>((resolve) => {
    complete = resolve;
  });
  const requests: Array<{ model: typeof selectedModel; context: Context; options: SimpleStreamOptions }> = [];
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    model: mainModel,
    editorText: "main draft",
    custom: tui.custom,
    modelRegistry: {
      streamSimple(model: typeof selectedModel, context: Context, options: SimpleStreamOptions) {
        requests.push({ model, context, options });
        return { result: () => completion };
      },
    },
  });
  const threadState = state();
  const running = runBtwThread({
    initialQuestion: "only a side question",
    selected: { model: selectedModel },
    thinkingLevel: "low",
    state: threadState,
    ctx: mock.ctx,
  });
  try {
    await tui.waitForOpen();
    const frame = tui.render(120).join("\n");
    tui.send("\u0003");
    assert.deepEqual(await running, { kind: "closed" });
    assert.match(frame, /anthropic\/side-appearance-model/u);
    assert.doesNotMatch(frame, /main-model-not-side/u);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.model, selectedModel);
    assert.equal(requests[0]?.options.reasoning, "low");
    assert.equal(requests[0]?.options.signal?.aborted, true);
    const request = JSON.stringify(requests[0]?.context);
    assert.match(request, /immutable side context/u);
    assert.match(request, /only a side question/u);
    assert.doesNotMatch(request, /btw ·|thinking low|Ctrl\+C|Main focus/u);
    assert.equal(mock.editorText, "main draft");
  } finally {
    complete(answer());
    await running;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(threadState.thread.turns, []);
});
