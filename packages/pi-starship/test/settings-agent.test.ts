import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type Message } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadStarshipConfig } from "../src/config.js";
import { createSettingsAgent, starshipPackageRoot } from "../src/settings-agent.js";
import { createSettingsDraft } from "../src/settings-draft.js";
import { settingsSnapshots } from "../src/settings-snapshots.js";

import { response, testModel } from "./settings-chat-support.js";

const packageRoot = resolve(import.meta.dirname, "..");

function normalizeRequest(messages: Message[]) {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return {
          role: message.role,
          content: message.content,
          sections: message.sections,
          toolsAdded: message.toolsAdded?.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            constrainedSampling: tool.constrainedSampling,
          })),
          toolsRemoved: message.toolsRemoved,
        };
      case "toolResult":
        return {
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
        };
      default:
        return { role: message.role, content: message.content };
    }
  });
}

test("real child Agent loads skill, executes only draft tools, and preserves ordinary request prefixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "starship-child-test-"));
  const settingsPath = join(root, "pi-starship.toml");
  const baseline = Buffer.from("# retained\nformat = '$model'\n");
  writeFileSync(settingsPath, baseline);
  const draft = createSettingsDraft({
    settingsPath,
    baseline,
    packageRoot,
    snapshots: settingsSnapshots(loadStarshipConfig(settingsPath), settingsPath, undefined),
    isCurrent: () => true,
    onPreview() {},
  });
  const requests: Message[][] = [];
  const calls: Array<{ provider: string; reasoning: unknown; signal: AbortSignal | undefined }> = [];
  const parent = [{ role: "user", text: "parent only" }];
  const context = createMockContext({ mode: "tui", model: { ...testModel, input: ["text"] }, thinkingLevel: "low" });
  const ctx = context.ctx as ExtensionCommandContext;
  ctx.modelRegistry.streamSimple = (model, input, options) => {
    assert.equal(model, ctx.model);
    calls.push({ provider: model.provider, reasoning: options?.reasoning, signal: options?.signal });
    requests.push(JSON.parse(JSON.stringify(input.messages)));
    if (requests.length === 1)
      return response(
        [
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { path: join(packageRoot, "skills/configure-pi-starship/references/module-catalog.md") },
          },
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: draft.path, content: "format = '$directory'\n" },
          },
        ],
        "toolUse",
      );
    if (requests.length === 3)
      return response(
        [
          {
            type: "toolCall",
            id: "active-state",
            name: "read",
            arguments: { path: join(draft.directory, "active-state.json") },
          },
          {
            type: "toolCall",
            id: "edit-2",
            name: "edit",
            arguments: { path: draft.path, edits: [{ oldText: "$directory", newText: "$model$directory" }] },
          },
        ],
        "toolUse",
      );
    return response([{ type: "text", text: "Preview updated." }]);
  };
  const agent = createSettingsAgent(ctx, draft, packageRoot);
  try {
    assert.deepEqual(
      agent.state.tools.map((tool) => tool.name),
      ["read", "write", "edit"],
    );
    assert.equal(agent.state.thinkingLevel, "low");
    assert.match(agent.state.systemPrompt, /# Configure pi-starship/u);
    assert.match(agent.state.systemPrompt, /Hosted preview-only chat/u);
    assert.match(agent.state.systemPrompt, /fixed at chat opening, not continuously current/u);
    for (const path of draft.snapshotPaths) assert.ok(agent.state.systemPrompt.includes(path));
    assert.ok(agent.state.systemPrompt.includes(join(packageRoot, "skills/configure-pi-starship")));
    await agent.prompt("Use directory only");
    assert.equal(draft.candidate?.rawDocument, "format = '$directory'\n");
    await agent.prompt("Also show the model");
    assert.equal(draft.candidate?.rawDocument, "format = '$model$directory'\n");
    assert.deepEqual(readFileSync(settingsPath), baseline);
    assert.deepEqual(parent, [{ role: "user", text: "parent only" }]);
    for (let index = 1; index < requests.length; index++) {
      // Compare serialized model-visible messages, including system prompt and ordered definitions.
      const previous = normalizeRequest(requests[index - 1]);
      const next = normalizeRequest(requests[index].slice(0, previous.length));
      assert.deepEqual(next, previous);
    }
    assert.equal(requests.length, 4);
    const readResult = requests[1].find((message) => message.role === "toolResult" && message.toolName === "read");
    assert.ok(readResult?.role === "toolResult" && !readResult.isError);
    const text = readResult.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    assert.ok(Buffer.byteLength(text) <= 50 * 1024);
    assert.ok(text.split("\n").length <= 2000);
    assert.match(text, /Output truncated.*smaller limit/u);
    assert.ok(calls.every((call) => call.provider === testModel.provider && call.signal));
    assert.equal(starshipPackageRoot(), packageRoot);
  } finally {
    agent.abort();
    await agent.waitForIdle();
    agent.reset();
    draft.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("child abort signal reaches the parent registry stream and settles before resources are removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "starship-child-abort-"));
  const draft = createSettingsDraft({
    settingsPath: join(root, "pi-starship.toml"),
    baseline: undefined,
    packageRoot,
    isCurrent: () => true,
    onPreview() {},
  });
  const ctx = createMockContext({ mode: "tui", model: { ...testModel, input: ["text"] } })
    .ctx as ExtensionCommandContext;
  let ready!: () => void;
  const started = new Promise<void>((done) => {
    ready = done;
  });
  let aborted = false;
  ctx.modelRegistry.streamSimple = (_model, _input, options) => {
    const stream = createAssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
        const result = response([], "aborted");
        void result.result().then((error) => stream.push({ type: "error", reason: "aborted", error }));
      },
      { once: true },
    );
    ready();
    return stream;
  };
  const agent = createSettingsAgent(ctx, draft, packageRoot);
  try {
    const running = agent.prompt("Wait");
    await started;
    agent.abort();
    await running;
    await agent.waitForIdle();
    assert.equal(aborted, true);
    assert.equal(agent.state.isStreaming, false);
  } finally {
    agent.abort();
    await agent.waitForIdle();
    draft.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
