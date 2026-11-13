import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const toolMode of ["codemode", "direct", "lazy"] as const)
  for (const native of [false, true])
    for (const catalog of ["empty", "partial"] as const) {
      test(`invalid reload preserves ${toolMode} ${catalog} policy (${native ? "native" : "fallback"})`, async () => {
        const tools = catalog === "empty" ? [] : [names[0]];
        await withChromeRuntime(
          { native, toolMode, tools },
          async ({ session, file, faux, fauxModule, notifications }) => {
            let active = session.getActiveToolNames();
            await writeFile(file, "{");
            await session.reload();
            assert.deepEqual(
              names.filter((name) => session.getToolDefinition(name)?.exposure !== "hidden"),
              tools,
            );
            assert.deepEqual(session.getActiveToolNames(), active);
            assert.equal(await readFile(file, "utf8"), "{");
            await session.prompt("/chrome-devtools status");
            const status = notifications.at(-1)?.message ?? "";
            assert.match(status, new RegExp(`Running tool mode: ${toolMode}`));
            assert.match(status, /Saved tool mode: unavailable \(invalid user settings\)/);
            assert.doesNotMatch(status, /Tool mode change pending/);
            if (toolMode === "lazy" && native) {
              faux.setResponses([
                fauxModule.fauxAssistantMessage(
                  fauxModule.fauxToolCall("chrome_devtools_load", { query: "list pages tabs", limit: 1 }),
                ),
                fauxModule.fauxAssistantMessage("loaded"),
              ]);
              await session.prompt("load retained catalog");
              active = session.getActiveToolNames();
            }
            assert.deepEqual(
              names.filter((name) => session.getCallableToolNames().includes(name)),
              tools,
            );
            await session.prompt("/chrome-devtools disable");
            assert.deepEqual(
              names.filter((name) => session.getCallableToolNames().includes(name)),
              tools,
            );
            assert.deepEqual(session.getActiveToolNames(), active);
            assert.equal(await readFile(file, "utf8"), "{");
          },
        );
      });
    }

test("fresh invalid settings fail closed without modifying the file", async () => {
  await withChromeRuntime({ native: true, toolMode: "codemode", invalidSettings: true }, async ({ session, file }) => {
    assert.ok(names.every((name) => !session.getCallableToolNames().includes(name)));
    await session.prompt("/chrome-devtools enable");
    assert.ok(names.every((name) => !session.getCallableToolNames().includes(name)));
    assert.equal(await readFile(file, "utf8"), "{");
  });
});
