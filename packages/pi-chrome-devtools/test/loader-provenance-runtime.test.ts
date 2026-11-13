import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const boundary of ["before", "after"] as const)
  test(`native loader reports activation truthfully after ${boundary}-append failure and retries metadata`, async () => {
    await withChromeRuntime(
      { native: true, toolMode: "lazy", persist: true },
      async ({ session, faux, fauxModule }) => {
        faux.setResponses([fauxModule.fauxAssistantMessage("persisted")]);
        await session.prompt("persist session before load");
        const active = session.getActiveToolNames();
        const prompt = session.systemPrompt;
        const manager = session.sessionManager;
        const append = manager.appendCustomEntry.bind(manager);
        const failure = new Error("ownership disk \u001b[31mfailure\u001b[0m");
        const spy = vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
          if (type !== "chrome-devtools.activation-provenance") return append(type, data);
          if (boundary === "after") append(type, data);
          throw failure;
        });
        const load = async () => {
          faux.setResponses([
            fauxModule.fauxAssistantMessage(
              fauxModule.fauxToolCall("chrome_devtools_load", { query: "list pages tabs", limit: 1 }),
            ),
            fauxModule.fauxAssistantMessage("loaded"),
          ]);
          await session.prompt("load list pages");
          const message = session.agent.state.messages
            .filter((message) => message.role === "toolResult" && message.toolName === "chrome_devtools_load")
            .at(-1);
          assert.ok(message?.role === "toolResult");
          return message;
        };
        const result = await load().finally(() => spy.mockRestore());
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result.content), /Loaded Chrome DevTools tools/);
        assert.match(JSON.stringify(result.content), /Warning:.*ownership.*could not be saved/);
        assert.ok(!JSON.stringify(result.content).includes("\\u001b"));
        assert.deepEqual(session.getActiveToolNames(), [...active, names[0]]);
        assert.equal(session.systemPrompt, prompt);
        const retried = await load();
        assert.notEqual(retried.isError, true);
        assert.match(JSON.stringify(retried.content), /already loaded/);
        assert.doesNotMatch(JSON.stringify(retried.content), /Warning:/);
        assert.deepEqual(session.getActiveToolNames(), [...active, names[0]]);
        assert.equal(session.systemPrompt, prompt);
        const record = manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "chrome-devtools.activation-provenance")
          .at(-1);
        assert.ok(record?.type === "custom");
        assert.deepEqual((record.data as { owned: string[] }).owned, [names[0]]);
        assert.deepEqual((record.data as { published: string[] }).published, [names[0]]);
        await session.reload();
        assert.ok(session.getActiveToolNames().includes("chrome_devtools_load"));
      },
    );
  });
