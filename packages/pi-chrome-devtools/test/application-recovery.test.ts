import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";
import { deferred, useChromeSettingsFixture } from "./settings-fixture.js";

const fixture = useChromeSettingsFixture("chrome-application-recovery-");

for (const mode of ["codemode", "lazy", "direct"] as const)
  for (const boundary of ["write", "rename"] as const)
    test(`${mode} ${boundary} failure preserves host withdrawal, addition and ordering exactly`, async () => {
      const settings = await import("../src/settings.js");
      const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
      const { default: extension } = await import("../src/chrome-devtools.js");
      const document = JSON.stringify({ tools: names, toolMode: mode, updatedAt: 1 });
      writeFileSync(settings.settingsFilePath(), document);
      const mock = createMockPi({ activeTools: ["other-a", names[0], "other-b", names[1]] });
      const { ctx, notifications } = createMockContext({
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "test",
          compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
        },
      });
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      mock.rawPi.setActiveTools([
        "other-a",
        names[0],
        "other-b",
        names[1],
        ...(mode === "lazy" ? ["chrome_devtools_load"] : []),
      ]);
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
              throw new Error("disk failure");
            },
          },
          apply,
        ),
      );
      const entries = mock.entries.length;
      const command = mock.commands.get("chrome-devtools")?.handler("disable", ctx);
      const current = [
        "other-b",
        names[1],
        "new-other",
        "other-a",
        ...(mode === "lazy" ? ["chrome_devtools_load"] : []),
      ];
      try {
        await started.promise;
        mock.rawPi.setActiveTools(current);
      } finally {
        release.resolve();
      }
      await command;
      assert.deepEqual(mock.rawPi.getActiveTools(), current);
      assert.equal(mock.entries.length, entries);
      assert.equal(readFileSync(settings.settingsFilePath(), "utf8"), document);
      assert.match(notifications.at(-1)?.message ?? "", /save failed; active tools unchanged/);
    });

for (const mode of ["codemode", "lazy", "direct"] as const)
  for (const boundary of ["registerTool", "setActiveTools", "appendEntry"] as const)
    for (const catalog of ["absent", "partial"] as const)
      test(`${mode} ${boundary} application failure restores ${catalog} durable catalog and provenance`, async () => {
        const settings = await import("../src/settings.js");
        const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
        const { default: extension } = await import("../src/chrome-devtools.js");
        const { configuredChromeDevtoolsTools } = await import("../src/lazy-tools.js");
        const document = {
          toolMode: mode,
          future: { kept: true },
          ...(catalog === "partial" ? { tools: [names[0]], updatedAt: 7 } : {}),
        };
        writeFileSync(settings.settingsFilePath(), JSON.stringify(document));
        const mock = createMockPi({ activeTools: ["codemode", "other", names[0]] });
        const { ctx, notifications } = createMockContext({
          sessionManager: { getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })) },
          model: {
            api: "openai-responses",
            provider: "openai",
            id: "test",
            compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
          },
        });
        extension(mock.pi);
        await mock.events.get("session_start")?.[0]?.({}, ctx);
        const before = mock.rawPi.getActiveTools();
        const tools = configuredChromeDevtoolsTools(mock.pi);
        const original = mock.rawPi[boundary];
        let failed = false;
        // Pi appends to its in-memory branch before synchronous disk persistence.
        // Throw after publication too, so recovery cannot rely on no side effects.
        vi.spyOn(mock.rawPi, boundary).mockImplementation(((...args: never[]) => {
          const result = (original as (...args: never[]) => void)(...args);
          if (!failed) {
            failed = true;
            throw new Error(`${boundary} failure`);
          }
          return result;
        }) as never);
        await mock.commands.get("chrome-devtools")?.handler("disable", ctx);
        assert.equal(failed, true);
        assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")), document);
        assert.deepEqual(configuredChromeDevtoolsTools(mock.pi), tools);
        assert.deepEqual(mock.rawPi.getActiveTools(), before);
        const record = mock.entries.at(-1);
        assert.ok(record);
        assert.deepEqual((record.data as { available: string[] }).available, tools);
        assert.match(notifications.at(-1)?.message ?? "", /application failed.*previous catalog restored/);
        // Invalid reload must not recover the rejected intent from failed metadata.
        writeFileSync(settings.settingsFilePath(), "{");
        await mock.events.get("session_start")?.[0]?.({}, ctx);
        assert.deepEqual(configuredChromeDevtoolsTools(mock.pi), tools);
        assert.deepEqual(mock.rawPi.getActiveTools(), before);
      });

for (const catalog of ["missing", "legacy", "partial"] as const)
  test(`compensation restores ${catalog} fields, preserves latest unknown fields and orders dependent work`, async () => {
    const settings = await import("../src/settings.js");
    const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
    const document =
      catalog === "partial"
        ? { tools: [names[0]], updatedAt: 7, future: "old" }
        : catalog === "legacy"
          ? { tools: "disabled", updatedAt: 8, future: "old" }
          : {};
    if (catalog !== "missing")
      writeFileSync(
        catalog === "legacy" ? join(fixture.root, "pi-chrome-devtools-settings.json") : settings.settingsFilePath(),
        JSON.stringify(document),
      );
    const started = deferred();
    const release = deferred();
    let writes = 0;
    const save = settings.saveSettings(
      { tools: [], updatedAt: 10 },
      {
        write: async (temporaryPath, data) => {
          writeFileSync(temporaryPath, data);
          if (++writes === 2) {
            started.resolve();
            await release.promise;
          }
        },
      },
      () => {
        const latest = JSON.parse(readFileSync(settings.settingsFilePath(), "utf8"));
        writeFileSync(
          settings.settingsFilePath(),
          JSON.stringify({ ...latest, future: "new", browser: { autoLaunch: false } }),
        );
        throw new Error("runtime failed");
      },
    );
    const rejected = assert.rejects(save, /runtime failed; previous catalog restored/);
    let readCompleted = false;
    let modeCompleted = false;
    let read: ReturnType<typeof settings.loadSettings> | undefined;
    let mode: Promise<void> | undefined;
    try {
      await started.promise;
      mode = settings.saveToolMode("direct").then(() => {
        modeCompleted = true;
      });
      read = settings.loadSettings().then((result) => {
        readCompleted = true;
        return result;
      });
      await Promise.resolve();
      assert.equal(modeCompleted, false);
      assert.equal(readCompleted, false);
    } finally {
      release.resolve();
    }
    await Promise.all([rejected, mode, read]);
    assert.equal(readCompleted, true);
    assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")), {
      ...document,
      future: "new",
      browser: { autoLaunch: false },
      toolMode: "direct",
    });
  });

for (const failure of ["write", "rename", "invalid", "newer-catalog"] as const)
  test(`compensation ${failure} failure is observable and does not poison later saves`, async () => {
    const settings = await import("../src/settings.js");
    const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
    const prior = { tools: [names[0]], updatedAt: 1 };
    writeFileSync(settings.settingsFilePath(), JSON.stringify(prior));
    let writes = 0;
    let renames = 0;
    const { rename } = await import("node:fs/promises");
    await assert.rejects(
      settings.saveSettings(
        { tools: [], updatedAt: 2 },
        {
          write: async (temporaryPath, data) => {
            if (++writes === 2 && failure === "write") throw new Error("recovery write failed");
            writeFileSync(temporaryPath, data);
          },
          rename: async (source, destination) => {
            if (++renames === 2 && failure === "rename") throw new Error("recovery rename failed");
            await rename(source, destination);
          },
        },
        () => {
          if (failure === "invalid") writeFileSync(settings.settingsFilePath(), "{");
          if (failure === "newer-catalog") writeFileSync(settings.settingsFilePath(), JSON.stringify(prior));
          throw new Error("runtime failed");
        },
      ),
      /runtime failed; saved catalog rollback failed/,
    );
    if (failure === "invalid") assert.equal(readFileSync(settings.settingsFilePath(), "utf8"), "{");
    if (failure === "newer-catalog")
      assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")), prior);
    writeFileSync(settings.settingsFilePath(), JSON.stringify(prior));
    await settings.saveToolMode("lazy");
    assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")), { ...prior, toolMode: "lazy" });
  });

for (const mode of ["codemode", "lazy", "direct"] as const)
  test(`${mode} replacement waits for post-application recovery without stale feedback`, async () => {
    const settings = await import("../src/settings.js");
    const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
    const { default: extension } = await import("../src/chrome-devtools.js");
    const { configuredChromeDevtoolsTools } = await import("../src/lazy-tools.js");
    const document = { tools: [names[0]], updatedAt: 1, toolMode: mode };
    writeFileSync(settings.settingsFilePath(), JSON.stringify(document));
    const first = createMockPi({ activeTools: ["codemode", names[0], "other"] });
    const { ctx, notifications } = createMockContext({
      sessionManager: { getBranch: () => first.entries.map((entry) => ({ type: "custom", ...entry })) },
    });
    extension(first.pi);
    await first.events.get("session_start")?.[0]?.({}, ctx);
    const append = first.rawPi.appendEntry;
    let failed = false;
    vi.spyOn(first.rawPi, "appendEntry").mockImplementation((type, data) => {
      append(type, data);
      if (!failed) {
        failed = true;
        throw new Error("session disk failed");
      }
    });
    const started = deferred();
    const release = deferred();
    let writes = 0;
    const save = settings.saveSettings;
    vi.spyOn(settings, "saveSettings").mockImplementation((value, _operations, apply) =>
      save(
        value,
        {
          write: async (temporaryPath, data) => {
            writeFileSync(temporaryPath, data);
            if (++writes === 2) {
              started.resolve();
              await release.promise;
            }
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
      next = createMockPi({ activeTools: first.rawPi.getActiveTools() });
      extension(next.pi);
      start = next.events.get("session_start")?.[0]?.({}, ctx);
    } finally {
      release.resolve();
    }
    await Promise.all([command, start]);
    assert.ok(next);
    assert.deepEqual(configuredChromeDevtoolsTools(next.pi), [names[0]]);
    assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")), document);
    assert.ok(!notifications.some(({ message }) => /application failed|save failed|catalog .*abled\./.test(message)));
  });
