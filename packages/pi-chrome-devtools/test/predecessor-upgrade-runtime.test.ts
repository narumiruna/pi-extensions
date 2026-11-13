import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const native of [false, true]) {
  for (const catalog of ["default", "partial", "empty"] as const) {
    test(`first predecessor ${native ? "native" : "eager"} upgrade migrates ${catalog} catalog without restart`, async () => {
      const tools = catalog === "default" ? undefined : catalog === "partial" ? [names[0]] : [];
      await withChromeRuntime(
        {
          native,
          toolMode: "codemode",
          tools,
          extensionPath: resolve("packages/pi-chrome-devtools/test/fixtures/predecessor-loader.ts"),
        },
        async ({ session, faux, fauxModule, file, setExtensionPath }) => {
          if (native) {
            faux.setResponses([
              fauxModule.fauxAssistantMessage(
                fauxModule.fauxToolCall("chrome_devtools_load", { query: "list pages tabs", limit: 1 }),
              ),
              fauxModule.fauxAssistantMessage("loaded"),
            ]);
            await session.prompt("load list pages");
          }
          const before = session.getActiveToolNames();
          assert.ok(before.includes("chrome_devtools_load"));
          assert.deepEqual(
            before.filter((name) => names.includes(name as never)),
            catalog === "empty" ? [] : native || catalog === "partial" ? [names[0]] : names,
          );
          const document = await readFile(file, "utf8");
          const oldPrompt = session.systemPrompt;
          const owner = session.sessionManager;
          setExtensionPath(resolve("packages/pi-chrome-devtools"));
          await session.reload();
          assert.equal(session.sessionManager, owner);
          assert.deepEqual(
            session.getActiveToolNames(),
            before.filter((name) => !name.startsWith("chrome_devtools_")),
          );
          assert.notEqual(session.systemPrompt, oldPrompt);
          assert.equal(await readFile(file, "utf8"), document);
          assert.deepEqual(
            names.filter((name) => session.getCallableToolNames().includes(name)),
            tools ?? names,
          );
          assert.ok(!session.getCallableToolNames().includes("chrome_devtools_load"));
          assert.ok(
            session
              .getAllTools()
              .filter((tool) => tool.name.includes("webmcp"))
              .every((tool) => tool.exposure === "hidden"),
          );
          const prompt = session.systemPrompt;
          const definitions = JSON.stringify(session.getAllTools());
          const captures: string[][] = [];
          faux.setResponses(
            ["first", "second"].map((text) => (request) => {
              captures.push(request.messages.map((message) => JSON.stringify(message)));
              return fauxModule.fauxAssistantMessage(text);
            }),
          );
          await session.prompt("after upgrade");
          await session.prompt("continue");
          assert.equal(session.systemPrompt, prompt);
          assert.equal(JSON.stringify(session.getAllTools()), definitions);
          assert.deepEqual(captures[1]?.slice(0, captures[0]?.length), captures[0]);
          if (catalog !== "empty") {
            session.setActiveToolsByName([...session.getActiveToolNames(), names[0]]);
            await session.reload();
            assert.ok(
              session.getActiveToolNames().includes(names[0]),
              "subsequent explicit capability activation remains declared",
            );
          }
        },
      );
    });
  }
}
