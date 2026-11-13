import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

// Load the large SDK dependency outside the per-test budget. Extension imports
// still happen fresh after the fixture sets PI_CODING_AGENT_DIR.
beforeAll(async () => {
  await import("@earendil-works/pi-coding-agent");
});

async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "chrome-tool-modes-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of [undefined, "codemode", "lazy", "direct"] as const) {
  test(`${mode ?? "legacy default"} exposes only enabled capabilities and preserves unrelated order`, async () =>
    fixture(async (root) => {
      const settings = await import("../src/settings.js");
      const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
      writeFileSync(settings.settingsFilePath(), JSON.stringify({ tools: names, updatedAt: 1, toolMode: mode }));
      const { default: extension } = await import("../src/chrome-devtools.js");
      const mock = createMockPi({ activeTools: ["other-a", "codemode", "other-b"] });
      const { ctx } = createMockContext({
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "test",
          compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
        },
      });
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const codemode = mode === undefined || mode === "codemode";
      assert.deepEqual(mock.rawPi.getActiveTools(), [
        "other-a",
        "codemode",
        "other-b",
        ...(mode === "lazy" ? ["chrome_devtools_load"] : codemode ? [] : names),
      ]);
      assert.ok(
        mock.tools
          .filter((tool) => names.includes(tool.name as never))
          .every((tool) => tool.exposure === (codemode ? "codemode" : "direct")),
      );
      assert.ok(mock.tools.filter((tool) => tool.name?.includes("webmcp")).every((tool) => tool.exposure === "hidden"));
      const before = mock.rawPi.getActiveTools();
      writeFileSync(settings.settingsFilePath(), "{");
      await mock.commands.get("chrome-devtools")?.handler("disable", ctx);
      assert.deepEqual(mock.rawPi.getActiveTools(), before);
      writeFileSync(settings.settingsFilePath(), JSON.stringify({ tools: names, updatedAt: 1, toolMode: mode }));
      await mock.commands.get("chrome-devtools")?.handler("disable", ctx);
      assert.ok(
        mock.tools.filter((tool) => names.includes(tool.name as never)).every((tool) => tool.exposure === "hidden"),
      );
      await mock.commands.get("chrome-devtools")?.handler("enable", ctx);
      assert.deepEqual(
        mock.rawPi.getActiveTools().filter((name) => !name.startsWith("chrome_devtools_")),
        ["other-a", "codemode", "other-b"],
      );
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(JSON.parse(readFileSync(join(root, "pi-chrome-devtools.json"), "utf8")).toolMode, mode);
    }));
}

test("mode-only saves preserve fields, pending mode survives availability saves, and reload applies it", async () =>
  fixture(async () => {
    const settings = await import("../src/settings.js");
    const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
    writeFileSync(
      settings.settingsFilePath(),
      JSON.stringify({ tools: names, updatedAt: 1, future: true, browser: { autoLaunch: false } }),
    );
    const { default: extension } = await import("../src/chrome-devtools.js");
    const mock = createMockPi({ activeTools: ["codemode"] });
    const { ctx } = createMockContext({
      sessionManager: { getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })) },
    });
    extension(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const before = mock.rawPi.getActiveTools();
    await Promise.all([settings.saveToolMode("direct"), settings.saveSettings({ tools: [...names], updatedAt: 2 })]);
    assert.deepEqual(mock.rawPi.getActiveTools(), before);
    const document = JSON.parse(readFileSync(settings.settingsFilePath(), "utf8"));
    assert.equal(document.toolMode, "direct");
    assert.equal(document.future, true);
    assert.deepEqual(document.browser, { autoLaunch: false });
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode", ...names]);
    await settings.saveToolMode("codemode");
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode"]);
  }));

test("mode validation blocks corrupt documents and recovers after atomic failure", async () =>
  fixture(async () => {
    const settings = await import("../src/settings.js");
    for (const text of ["{", '{"toolMode":"unknown"}']) {
      writeFileSync(settings.settingsFilePath(), text);
      assert.equal((await settings.loadSettings()).kind, "invalid");
      await assert.rejects(settings.saveToolMode("lazy"), /repair/);
      assert.equal(readFileSync(settings.settingsFilePath(), "utf8"), text);
    }
    writeFileSync(settings.settingsFilePath(), '{"future":true}');
    await assert.rejects(
      settings.saveToolMode("lazy", {
        rename: async () => {
          throw new Error("disk failure");
        },
      }),
      /disk failure/,
    );
    assert.equal(readFileSync(settings.settingsFilePath(), "utf8"), '{"future":true}');
    await settings.saveToolMode("direct");
    const result = await settings.loadSettings();
    assert.equal(result.kind, "loaded");
    if (result.kind === "loaded") assert.equal(result.settings.toolMode, "direct");
  }));

for (const cohort of ["capability-only", "unknown-loader", "known-explicit-loader"] as const) {
  test(`first codemode configuration handles ${cohort} provenance`, async () =>
    fixture(async () => {
      const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
      const { default: extension } = await import("../src/chrome-devtools.js");
      let entries: Array<{ customType: string; data: unknown }> = [];
      const { ctx } = createMockContext({
        sessionManager: { getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })) },
      });
      if (cohort === "known-explicit-loader") {
        const previous = createMockPi({ activeTools: ["other-a", names[0], "other-b"] });
        extension(previous.pi);
        await previous.events.get("session_start")?.[0]?.({}, ctx);
        entries = previous.entries;
      }
      const mock = createMockPi({
        activeTools: [
          "other-a",
          ...(cohort === "capability-only" ? [] : ["chrome_devtools_load"]),
          names[0],
          "other-b",
        ],
      });
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      assert.deepEqual(mock.rawPi.getActiveTools(), [
        "other-a",
        ...(cohort === "unknown-loader" ? [] : [names[0]]),
        "other-b",
      ]);
      assert.equal(mock.tools.find((tool) => tool.name === "chrome_devtools_load")?.exposure, "hidden");
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
    }));
}
