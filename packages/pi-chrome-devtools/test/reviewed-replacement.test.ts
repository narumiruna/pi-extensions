import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";
import { deferred, useChromeSettingsFixture } from "./settings-fixture.js";

useChromeSettingsFixture("chrome-reviewed-replacement-");

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const enabled of [false, true])
    for (const replacement of [false, true])
      for (const preceding of ["empty", "partial", "unchanged"] as const)
        test(`${toolMode} gate ${enabled} replacement ${replacement} preserves stale-review checks after ${preceding} save`, async () => {
          const settings = await import("../src/settings.js");
          const { CHROME_DEVTOOLS_TOOL_NAMES: all, CORE_CHROME_DEVTOOLS_TOOL_NAMES: core } = await import(
            "../src/tool-names.js"
          );
          const { default: extension } = await import("../src/chrome-devtools.js");
          const { availableChromeDevtoolsTools } = await import("../src/lazy-tools.js");
          const { setSelectedChromeDevtoolsTools } = await import("../src/tool-selector.js");
          const initial = [...(enabled ? all : core)];
          const firstTools = preceding === "empty" ? [] : preceding === "partial" ? [initial[1]] : initial;
          const selected = [initial[0]];
          writeFileSync(
            settings.settingsFilePath(),
            JSON.stringify({ tools: initial, toolMode, webmcp: { enabled }, updatedAt: 1 }),
          );
          const mock = createMockPi({ activeTools: ["codemode", "other"] });
          const { ctx, notifications } = createMockContext({
            sessionManager: { getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })) },
          });
          extension(mock.pi);
          await mock.events.get("session_start")?.[0]?.({}, ctx);
          const priorNotifications = notifications.length;
          const started = deferred();
          const release = deferred();
          const save = settings.saveSettings;
          let writes = 0;
          vi.spyOn(settings, "saveSettings").mockImplementation((value, _operations, apply) =>
            save(
              value,
              {
                write: async (path, data) => {
                  writeFileSync(path, data);
                  if (++writes === 1) {
                    started.resolve();
                    await release.promise;
                  }
                },
              },
              apply,
            ),
          );
          const first = setSelectedChromeDevtoolsTools(mock.pi, ctx, firstTools, initial);
          let reviewed: ReturnType<typeof setSelectedChromeDevtoolsTools> | undefined;
          let replacing: unknown;
          let next = mock;
          try {
            await started.promise;
            reviewed = setSelectedChromeDevtoolsTools(mock.pi, ctx, selected, initial);
            if (replacement) {
              next = createMockPi({ activeTools: mock.rawPi.getActiveTools() });
              extension(next.pi);
              const nextContext = createMockContext({
                sessionManager: (ctx as { sessionManager: object }).sessionManager,
              });
              replacing = next.events.get("session_start")?.[0]?.({}, nextContext.ctx);
              vi.spyOn(mock.rawPi, "getActiveTools").mockImplementation(() => {
                throw new Error("retired API read");
              });
            }
          } finally {
            release.resolve();
          }
          const [, result] = await Promise.all([first, reviewed, replacing]);
          const stale = preceding !== "unchanged";
          assert.equal(result, stale ? "active-tools-changed" : replacement ? "failed" : "saved");
          assert.equal(writes, stale ? 1 : 2);
          const expected = stale ? firstTools : selected;
          assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")).tools, expected);
          assert.deepEqual(availableChromeDevtoolsTools(next.pi), expected);
          if (replacement) assert.equal(notifications.length, priorNotifications);
        });
