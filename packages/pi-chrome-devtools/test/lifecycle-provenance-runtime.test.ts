import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test, vi } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const boundary of ["before", "after"] as const)
    test(`real Pi/Jiti ${toolMode} lifecycle ${boundary} provenance failure continues startup and retries on reload`, async () => {
      await withChromeRuntime(
        { native: true, toolMode: "codemode", persist: true, hostCodemode: false },
        async ({ session, faux, fauxModule, file, errors, notifications }) => {
          faux.setResponses([fauxModule.fauxAssistantMessage("persisted")]);
          await session.prompt("persist session before lifecycle");
          await writeFile(
            file,
            JSON.stringify({ toolMode, tools: [names[0]], updatedAt: 1, browser: { autoLaunch: false } }),
          );
          notifications.length = 0;
          const manager = session.sessionManager;
          const append = manager.appendCustomEntry.bind(manager);
          let attempts = 0;
          const spy = vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
            if (type !== "chrome-devtools.activation-provenance") return append(type, data);
            attempts += 1;
            if (boundary === "after") append(type, data);
            throw new Error("ownership append failed");
          });
          try {
            await session.reload();
          } finally {
            spy.mockRestore();
          }
          assert.equal(attempts, 1);
          assert.deepEqual(errors, []);
          assert.ok(notifications.some(({ message }) => /ownership could not be saved/.test(message)));
          assert.equal(
            notifications.some(({ message }) => /require Pi's codemode tool/.test(message)),
            toolMode === "codemode",
          );
          assert.deepEqual(
            names.filter((name) => session.getToolDefinition(name)?.exposure !== "hidden"),
            [names[0]],
          );
          assert.deepEqual(
            names.filter((name) => session.getActiveToolNames().includes(name)),
            toolMode === "direct" ? [names[0]] : [],
          );
          const retry = vi.spyOn(manager, "appendCustomEntry");
          await session.reload();
          assert.equal(retry.mock.calls.filter(([type]) => type === "chrome-devtools.activation-provenance").length, 1);
          retry.mockRestore();
          assert.deepEqual(errors, []);
        },
      );
    });

for (const boundary of ["before", "after"] as const)
  test(`real Pi/Jiti eager model selection ${boundary} provenance failure warns without a failed handler`, async () => {
    await withChromeRuntime(
      { native: true, toolMode: "lazy", persist: true },
      async ({ session, faux, fauxModule, model, errors, notifications }) => {
        faux.setResponses([fauxModule.fauxAssistantMessage("persisted")]);
        await session.prompt("persist session before model switch");
        const active = session.getActiveToolNames();
        const manager = session.sessionManager;
        const append = manager.appendCustomEntry.bind(manager);
        const spy = vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
          if (type !== "chrome-devtools.activation-provenance") return append(type, data);
          if (boundary === "after") append(type, data);
          throw new Error("ownership append failed");
        });
        const eager = {
          ...model,
          id: "eager",
          compat: { ...model.compat, supportsToolSearch: false, supportsAdditionalTools: false },
        };
        try {
          await session.setModel(eager);
        } finally {
          spy.mockRestore();
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(session.getActiveToolNames(), [...active, ...names]);
        assert.match(notifications.at(-1)?.message ?? "", /ownership could not be saved/);
        const retry = vi.spyOn(manager, "appendCustomEntry");
        await session.setModel({ ...eager, id: "retry" });
        assert.equal(retry.mock.calls.filter(([type]) => type === "chrome-devtools.activation-provenance").length, 1);
        retry.mockRestore();
        assert.deepEqual(errors, []);
        const record = manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "chrome-devtools.activation-provenance")
          .at(-1);
        assert.ok(record?.type === "custom");
        assert.deepEqual((record.data as { owned: string[] }).owned, [...names]);
      },
    );
  });
