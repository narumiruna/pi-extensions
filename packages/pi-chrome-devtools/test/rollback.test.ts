import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: string;
let previousDir: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "chrome-rollback-"));
  previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.resetModules();
  await import("../src/chrome-devtools.js");
});
afterEach(async () => {
  vi.restoreAllMocks();
  const { waitForSettingsWrites } = await import("../src/settings.js");
  await waitForSettingsWrites();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

for (const mode of ["codemode", "lazy", "direct"] as const) {
  for (const boundary of ["write", "rename"] as const) {
    for (const change of ["none", "model", "other-tools"] as const) {
      test(`${mode} ${boundary} failure preserves current policy and ${change} state`, async () => {
        const settings = await import("../src/settings.js");
        const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
        const { chromeDevtoolsToolExposureMode, configuredChromeDevtoolsTools } = await import("../src/lazy-tools.js");
        const { default: extension } = await import("../src/chrome-devtools.js");
        const document = JSON.stringify({ tools: names, toolMode: mode, updatedAt: 1, future: { kept: true } });
        writeFileSync(settings.settingsFilePath(), document);
        const mock = createMockPi({ activeTools: ["other-a", "other-b", "other-c"] });
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
        const prior = [
          "other-a",
          names[0],
          "other-b",
          names[1],
          "other-c",
          ...(mode === "lazy" ? ["chrome_devtools_load"] : []),
          ...(mode === "direct" ? names.slice(2) : []),
        ];
        mock.rawPi.setActiveTools(prior);
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
        const command = mock.commands.get("chrome-devtools")?.handler("disable", ctx);
        let expectedOthers = ["other-a", "other-b", "other-c"];
        try {
          await started.promise;
          if (change === "model") {
            await mock.events.get("model_select")?.[0]?.(
              { model: { api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5" } },
              ctx,
            );
          } else if (change === "other-tools") {
            expectedOthers = ["other-c", "new-other", "other-a"];
            mock.rawPi.setActiveTools([...expectedOthers, ...(mode === "lazy" ? ["chrome_devtools_load"] : [])]);
          }
        } finally {
          release.resolve();
        }
        await command;
        assert.equal(readFileSync(settings.settingsFilePath(), "utf8"), document);
        assert.deepEqual(configuredChromeDevtoolsTools(mock.pi), names);
        const active = mock.rawPi.getActiveTools();
        assert.deepEqual(
          active.filter((name) => !name.startsWith("chrome_devtools_")),
          expectedOthers,
        );
        const eager = mode === "direct" || (mode === "lazy" && change === "model");
        assert.equal(
          chromeDevtoolsToolExposureMode(mock.pi),
          mode === "codemode" ? "codemode" : eager ? "eager" : "native deferred",
        );
        assert.deepEqual(
          active.filter((name) => names.includes(name as never)),
          change === "other-tools" ? [] : eager ? names : names.slice(0, 2),
        );
        if (change === "none") assert.deepEqual(active, prior);
        assert.match(notifications.at(-1)?.message ?? "", new RegExp(`save failed.*${boundary} failed`));
        await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
      });
    }
  }
}

test("rollback preserves configured gated names without exposing disabled WebMCP", async () => {
  const settings = await import("../src/settings.js");
  const { CHROME_DEVTOOLS_TOOL_NAMES: names, WEBMCP_TOOL_NAMES } = await import("../src/tool-names.js");
  const { configuredChromeDevtoolsTools } = await import("../src/lazy-tools.js");
  const { default: extension } = await import("../src/chrome-devtools.js");
  writeFileSync(
    settings.settingsFilePath(),
    JSON.stringify({ tools: names, toolMode: "codemode", updatedAt: 1, webmcp: { enabled: false } }),
  );
  const mock = createMockPi({ activeTools: ["codemode"] });
  const { ctx } = createMockContext();
  extension(mock.pi);
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  writeFileSync(settings.settingsFilePath(), "{");
  await mock.commands.get("chrome-devtools")?.handler("disable", ctx);
  assert.deepEqual(configuredChromeDevtoolsTools(mock.pi), names);
  assert.ok(
    mock.tools
      .filter((tool) => WEBMCP_TOOL_NAMES.includes(tool.name as never))
      .every((tool) => tool.exposure === "hidden"),
  );
  assert.deepEqual(mock.rawPi.getActiveTools(), ["codemode"]);
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});
