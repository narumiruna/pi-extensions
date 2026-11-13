import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";
import { deferred, useChromeSettingsFixture } from "./settings-fixture.js";

useChromeSettingsFixture("chrome-replacement-save-");

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const boundary of ["write", "rename"] as const)
    for (const catalog of ["empty", "partial"] as const)
      for (const replacement of ["reload", "new-manager"] as const)
        test(`${toolMode} ${boundary} failure retains ${catalog} policy across ${replacement}`, async () => {
          const settings = await import("../src/settings.js");
          const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
          const { default: extension } = await import("../src/chrome-devtools.js");
          const { configuredChromeDevtoolsTools, chromeDevtoolsToolMode } = await import("../src/lazy-tools.js");
          const tools = catalog === "empty" ? [] : [names[0]];
          writeFileSync(settings.settingsFilePath(), JSON.stringify({ toolMode, tools, updatedAt: 1 }));
          const first = createMockPi({ activeTools: ["codemode", "other"] });
          const { ctx, notifications } = createMockContext({
            sessionManager: { getBranch: () => first.entries.map((entry) => ({ type: "custom", ...entry })) },
          });
          extension(first.pi);
          await first.events.get("session_start")?.[0]?.({}, ctx);
          const started = deferred();
          const release = deferred();
          const save = settings.saveSettings;
          vi.spyOn(settings, "saveSettings").mockImplementation((value, _operations, apply) =>
            save(
              value,
              {
                [boundary]: async () => {
                  started.resolve();
                  await release.promise;
                  throw new Error(`${boundary} failed`);
                },
              },
              apply,
            ),
          );
          const command = first.commands
            .get("chrome-devtools")
            ?.handler(catalog === "empty" ? "enable" : "disable", ctx);
          let start: unknown;
          let next: ReturnType<typeof createMockPi> | undefined;
          try {
            await started.promise;
            assert.deepEqual(configuredChromeDevtoolsTools(first.pi), tools);
            writeFileSync(settings.settingsFilePath(), "{");
            next = createMockPi({ activeTools: first.rawPi.getActiveTools() });
            extension(next.pi);
            const nextCtx =
              replacement === "reload"
                ? ctx
                : createMockContext({
                    sessionManager: { getBranch: () => first.entries.map((entry) => ({ type: "custom", ...entry })) },
                  }).ctx;
            start = next.events.get("session_start")?.[0]?.({}, nextCtx);
          } finally {
            release.resolve();
          }
          await Promise.all([command, start]);
          assert.ok(next);
          assert.deepEqual(configuredChromeDevtoolsTools(next.pi), tools);
          assert.equal(chromeDevtoolsToolMode(next.pi), toolMode);
          assert.equal(readFileSync(settings.settingsFilePath(), "utf8"), "{");
          assert.deepEqual(
            notifications.filter(({ message }) => /save failed|catalog .*abled\./.test(message)),
            [],
          );
          const record = next.entries.at(-1)?.data as { available: string[] } | undefined;
          if (record) assert.deepEqual(record.available, tools);
        });

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  test(`${toolMode} replacement applies a successful durable intent without stale publication`, async () => {
    const settings = await import("../src/settings.js");
    const { default: extension } = await import("../src/chrome-devtools.js");
    const { configuredChromeDevtoolsTools } = await import("../src/lazy-tools.js");
    writeFileSync(settings.settingsFilePath(), JSON.stringify({ toolMode }));
    const first = createMockPi({ activeTools: ["codemode", "other"] });
    const { ctx } = createMockContext({
      sessionManager: { getBranch: () => first.entries.map((entry) => ({ type: "custom", ...entry })) },
    });
    extension(first.pi);
    await first.events.get("session_start")?.[0]?.({}, ctx);
    const entries = first.entries.length;
    const started = deferred();
    const release = deferred();
    const save = settings.saveSettings;
    vi.spyOn(settings, "saveSettings").mockImplementation((value, _operations, apply) =>
      save(
        value,
        {
          write: async (temporaryPath, data) => {
            writeFileSync(temporaryPath, data);
            started.resolve();
            await release.promise;
          },
        },
        apply,
      ),
    );
    const command = first.commands.get("chrome-devtools")?.handler("disable", ctx);
    let start: unknown;
    let next: ReturnType<typeof createMockPi> | undefined;
    try {
      await started.promise;
      assert.equal(first.entries.length, entries);
      next = createMockPi({ activeTools: first.rawPi.getActiveTools() });
      extension(next.pi);
      start = next.events.get("session_start")?.[0]?.({}, ctx);
    } finally {
      release.resolve();
    }
    await Promise.all([command, start]);
    assert.ok(next);
    assert.deepEqual(configuredChromeDevtoolsTools(next.pi), []);
    assert.equal(first.entries.length, entries);
    assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")).tools, []);
  });

for (const toolMode of ["lazy", "direct"] as const)
  for (const invalid of [true, false])
    test(`${toolMode} status distinguishes ${invalid ? "invalid" : "missing"} saved mode`, async () => {
      const settings = await import("../src/settings.js");
      const { default: extension } = await import("../src/chrome-devtools.js");
      const { buildToolStatusMessage } = await import("../src/tool-selector.js");
      writeFileSync(settings.settingsFilePath(), JSON.stringify({ toolMode }));
      const mock = createMockPi();
      const { ctx } = createMockContext();
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      if (invalid) writeFileSync(settings.settingsFilePath(), "{");
      else rmSync(settings.settingsFilePath());
      const status = await buildToolStatusMessage(mock.pi, (ctx as { sessionManager: object }).sessionManager);
      assert.match(status, new RegExp(`Running tool mode: ${toolMode}`));
      if (invalid) {
        assert.match(status, /Saved tool mode: unavailable \(invalid user settings\)/);
        assert.doesNotMatch(status, /Tool mode change pending/);
      } else {
        assert.match(status, /Saved tool mode: codemode/);
        assert.match(status, /Tool mode change pending/);
      }
    });
