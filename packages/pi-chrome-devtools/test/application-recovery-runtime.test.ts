import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test, vi } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  test(`real Pi/Jiti ${toolMode} post-save append failure restores durable policy and branch metadata`, async () => {
    await withChromeRuntime(
      { native: true, toolMode, tools: [names[0]], persist: true },
      async ({ session, faux, fauxModule, file, notifications }) => {
        faux.setResponses([fauxModule.fauxAssistantMessage("persisted")]);
        await session.prompt("persist session before tool transaction");
        const document = await readFile(file, "utf8");
        const active = session.getActiveToolNames();
        const manager = session.sessionManager;
        const append = manager.appendCustomEntry.bind(manager);
        let failed = false;
        const spy = vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
          const id = append(type, data);
          if (type === "chrome-devtools.activation-provenance" && !failed) {
            failed = true;
            throw new Error("session append persistence failed");
          }
          return id;
        });
        try {
          await session.prompt("/chrome-devtools disable");
          assert.equal(failed, true);
          assert.deepEqual(JSON.parse(await readFile(file, "utf8")), JSON.parse(document));
          assert.deepEqual(session.getActiveToolNames(), active);
          const record = manager
            .getBranch()
            .filter((entry) => entry.type === "custom" && entry.customType === "chrome-devtools.activation-provenance")
            .at(-1);
          assert.ok(record?.type === "custom");
          assert.deepEqual((record.data as { available: string[] }).available, [names[0]]);
          assert.match(notifications.at(-1)?.message ?? "", /application failed.*previous catalog restored/);
        } finally {
          spy.mockRestore();
        }
        await writeFile(file, "{");
        await session.reload();
        assert.deepEqual(session.getActiveToolNames(), active);
        assert.deepEqual(
          names.filter((name) => session.getToolDefinition(name)?.exposure !== "hidden"),
          [names[0]],
        );
      },
    );
  });
