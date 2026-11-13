import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const native of [false, true]) {
  for (const transition of ["startup", "settings-reload"] as const) {
    test(`mode-only lazy ${transition} has a full gated catalog (${native ? "native" : "fallback"})`, async () => {
      await withChromeRuntime(
        { native, toolMode: transition === "startup" ? "lazy" : "codemode" },
        async ({ session, faux, fauxModule, file, errors }) => {
          if (transition === "settings-reload") {
            initTheme("dark", false);
            const tui = createTuiHarness({ width: 80 });
            const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
            try {
              await session.bindExtensions({
                mode: "tui",
                uiContext: (context.ctx as ExtensionContext).ui,
                onError: (error) => errors.push(error),
              });
              const before = session.getActiveToolNames();
              const command = session.prompt("/chrome-devtools settings");
              await tui.waitForOpen();
              for (let row = 0; row < 5; row++) tui.press("tui.select.down");
              tui.press("tui.select.confirm");
              await tui.waitForPending();
              await tui.waitForOpen();
              const activeAfterSave = session.getActiveToolNames();
              tui.press("ctrl+c");
              await command;
              const saved = JSON.parse(await readFile(file, "utf8"));
              assert.equal(saved.toolMode, "lazy");
              assert.equal(saved.tools, undefined);
              assert.deepEqual(activeAfterSave, before);
              await session.reload();
            } finally {
              tui.dispose();
            }
          }
          assert.deepEqual(
            session.getActiveToolNames().filter((name) => name.startsWith("chrome_devtools_")),
            ["chrome_devtools_load", ...(native ? [] : names)],
          );
          assert.ok(
            session
              .getAllTools()
              .filter((tool) => names.includes(tool.name as never))
              .every((tool) => tool.exposure === "direct"),
          );
          assert.ok(
            session
              .getAllTools()
              .filter((tool) => tool.name.includes("webmcp"))
              .every((tool) => tool.exposure === "hidden"),
          );
          const prior = session.getActiveToolNames();
          const prompt = session.systemPrompt;
          faux.setResponses([
            fauxModule.fauxAssistantMessage(
              fauxModule.fauxToolCall("chrome_devtools_load", { query: "list pages tabs", limit: 1 }),
            ),
            fauxModule.fauxAssistantMessage("loaded"),
          ]);
          await session.prompt("load list pages");
          assert.deepEqual(session.getActiveToolNames(), native ? [...prior, names[0]] : prior);
          assert.equal(session.systemPrompt, prompt);
          assert.ok(session.getCallableToolNames().includes(names[0]));
          const results = session.agent.state.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "chrome_devtools_load",
          );
          assert.ok(
            results.some(
              (message) => message.role === "toolResult" && JSON.stringify(message.details).includes(names[0]),
            ),
          );
          await session.prompt("/chrome-devtools disable");
          await session.reload();
          assert.deepEqual(
            session.getActiveToolNames().filter((name) => name.startsWith("chrome_devtools_")),
            ["chrome_devtools_load"],
          );
          assert.ok(names.every((name) => !session.getCallableToolNames().includes(name)));
          assert.deepEqual(JSON.parse(await readFile(file, "utf8")).tools, []);
        },
      );
    });
  }
}

for (const change of ["model", "other-tools"] as const) {
  test(`real Pi/Jiti rejected save makes no runtime publication before later ${change}`, async () => {
    await withChromeRuntime({ native: true, toolMode: "lazy", tools: names }, async ({ session, file, model }) => {
      session.setActiveToolsByName([
        "read",
        names[0],
        "bash",
        names[1],
        "edit",
        "write",
        "codemode",
        "chrome_devtools_load",
      ]);
      // Pi retains the order of active tools and appends newly activated names.
      const prior = session.getActiveToolNames();
      await writeFile(file, "{");
      const setActive = session.setActiveToolsByName.bind(session);
      let publications = 0;
      session.setActiveToolsByName = (tools) => {
        publications++;
        setActive(tools);
      };
      const command = session.prompt("/chrome-devtools disable");
      let others: string[];
      try {
        await command;
        assert.equal(publications, 0);
        assert.deepEqual(session.getActiveToolNames(), prior);
        if (change === "model") {
          await session.extensionRunner.emit({
            type: "model_select",
            model: { ...model, compat: { supportsToolSearch: false } },
            previousModel: model,
            source: "set",
          });
          others = prior.filter((name) => !name.startsWith("chrome_devtools_"));
        } else {
          others = ["write", "grep", "codemode", "read", "edit"];
          session.setActiveToolsByName([...others, "chrome_devtools_load"]);
          others = session.getActiveToolNames().filter((name) => !name.startsWith("chrome_devtools_"));
        }
        await command;
      } finally {
        session.setActiveToolsByName = setActive;
      }
      const active = session.getActiveToolNames();
      assert.deepEqual(
        active.filter((name) => !name.startsWith("chrome_devtools_")),
        others,
      );
      // A rejected write makes no runtime publication. The later host action
      // wins; application-recovery.test.ts gates I/O to cover the concurrent path.
      const expected = change === "model" ? names : [];
      assert.deepEqual(
        active.filter((name) => names.includes(name as never)),
        expected,
      );
      assert.ok(expected.every((name) => session.getCallableToolNames().includes(name)));
      assert.equal(await readFile(file, "utf8"), "{");
    });
  });
}
