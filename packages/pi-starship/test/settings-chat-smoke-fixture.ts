import assert from "node:assert/strict";
import { existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic provider for the automated PTY smoke; never contacts an external service. */
export default function settingsChatSmokeFixture(pi: ExtensionAPI) {
  const record = {
    requests: 0,
    skillLoaded: false,
    tools: [] as string[],
    mainMessages: -1,
    draftPath: "",
    executedTools: [] as string[],
    userMessages: [] as string[],
  };
  const pending = new Set<() => void>();
  const save = () => writeFileSync(join(process.cwd(), "smoke-record.json"), JSON.stringify(record));
  pi.registerProvider("starship-smoke", {
    api: "starship-smoke",
    apiKey: "local-fixture",
    baseUrl: "http://unused.invalid",
    models: [
      {
        id: "configuration-smoke",
        name: "configuration-smoke",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      record.requests += 1;
      const system = context.messages[0];
      assert.ok(system?.role === "system");
      const prompt = typeof system.content === "string" ? system.content : "";
      record.skillLoaded = prompt.includes("# Configure pi-starship") && prompt.includes("Hosted preview-only chat");
      record.tools = system.toolsAdded?.map((tool) => tool.name) ?? [];
      record.draftPath = /Draft path: ([^\n]+)/u.exec(prompt)?.[1] ?? "";
      assert.equal(record.skillLoaded, true);
      assert.deepEqual(record.tools, ["read", "write", "edit"]);
      assert.ok(record.draftPath);
      const toolResults = context.messages.filter((message) => message.role === "toolResult");
      assert.ok(toolResults.every((message) => !message.isError));
      record.executedTools = toolResults.map((message) => message.toolName);
      record.userMessages = context.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
        );
      const second = record.userMessages.length > 1;
      const followUp = record.userMessages.at(-1) === "follow";
      const toolsNeeded = context.messages.at(-1)?.role === "user" && !followUp;
      const content: AssistantMessage["content"] = toolsNeeded
        ? [
            {
              type: "toolCall",
              id: `call-${record.requests}`,
              name: second ? "edit" : "write",
              arguments: second
                ? { path: record.draftPath, edits: [{ oldText: "$directory", newText: "$model$directory" }] }
                : { path: record.draftPath, content: "# smoke draft\nformat = '$directory'\n" },
            },
          ]
        : [
            {
              type: "text",
              text: followUp ? "SMOKE_FOLLOW_READY" : second ? "SMOKE_SECOND_READY" : "SMOKE_FIRST_READY",
            },
          ];
      if (toolsNeeded && !second) {
        const skillDirectory = /Skill base directory: ([^\n]+)/u.exec(prompt)?.[1];
        assert.ok(skillDirectory);
        content.unshift({
          type: "toolCall",
          id: `read-${record.requests}`,
          name: "read",
          arguments: { path: join(skillDirectory, "references/configuration.md"), limit: 10 },
        });
      }
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toolsNeeded ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      if (record.requests === 1) {
        const partial = { ...message, content: [{ type: "text" as const, text: "SMOKE_QUEUE_WAIT" }] };
        stream.push({ type: "start", partial });
        const releasePath = join(process.cwd(), "smoke-release");
        let finished = false;
        const finish = (aborted = false) => {
          if (finished) return;
          finished = true;
          dispose();
          if (aborted)
            stream.push({
              type: "error",
              reason: "aborted",
              error: { ...message, content: [], stopReason: "aborted" },
            });
          else stream.push({ type: "done", reason: "toolUse", message });
        };
        const watcher = watch(process.cwd(), () => {
          if (existsSync(releasePath)) finish();
        });
        const abort = () => finish(true);
        const dispose = () => {
          watcher.close();
          options?.signal?.removeEventListener("abort", abort);
          pending.delete(abort);
        };
        pending.add(abort);
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) abort();
        else if (existsSync(releasePath)) finish();
      } else stream.push({ type: "done", reason: toolsNeeded ? "toolUse" : "stop", message });
      save();
      return stream;
    },
  });
  pi.on("session_shutdown", () => {
    for (const cancel of pending) cancel();
  });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("STARSHIP_SMOKE_READY", "info");
  });
  pi.registerCommand("smoke-check", {
    description: "Record parent isolation and finish the automated smoke",
    handler: async (_args, ctx) => {
      record.mainMessages = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").length;
      save();
      ctx.shutdown();
    },
  });
}
