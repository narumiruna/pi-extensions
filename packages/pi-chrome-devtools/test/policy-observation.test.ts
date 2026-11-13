import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createMockPi } from "./mock-pi.js";
import { deferred, useChromeSettingsFixture } from "./settings-fixture.js";

useChromeSettingsFixture("chrome-policy-observation-");

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const boundary of ["write", "rename"] as const)
    for (const action of ["enable", "disable"] as const)
      test(`${toolMode} status observes settled ${action} ${boundary} with one settings snapshot`, async () => {
        const settings = await import("../src/settings.js");
        const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
        const { default: extension } = await import("../src/chrome-devtools.js");
        const { buildToolStatusMessage, setSelectedChromeDevtoolsTools } = await import("../src/tool-selector.js");
        const initialTools = action === "enable" ? [] : [...names];
        const selectedTools = action === "enable" ? [...names] : [];
        writeFileSync(settings.settingsFilePath(), JSON.stringify({ toolMode, tools: initialTools, updatedAt: 1 }));
        const mock = createMockPi({ activeTools: ["codemode", "other", names[0]] });
        const { ctx } = createMockContext({
          model: {
            api: "openai-responses",
            provider: "openai",
            id: "test",
            compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true },
          },
        });
        const owner = (ctx as { sessionManager: object }).sessionManager;
        extension(mock.pi);
        await mock.events.get("session_start")?.[0]?.({}, ctx);
        const started = deferred();
        const release = deferred();
        const save = settings.saveSettings;
        const { rename } = await import("node:fs/promises");
        vi.spyOn(settings, "saveSettings").mockImplementation((value, _operations, apply) =>
          save(
            value,
            {
              [boundary]: async (path: string, data: string) => {
                started.resolve();
                await release.promise;
                if (boundary === "write") writeFileSync(path, data);
                else await rename(path, data);
              },
            },
            apply,
          ),
        );
        const change = setSelectedChromeDevtoolsTools(mock.pi, ctx, selectedTools, initialTools);
        let observing: Promise<string> | undefined;
        let reads: ReturnType<typeof vi.spyOn> | undefined;
        try {
          await started.promise;
          reads = vi.spyOn(settings, "loadSettings");
          observing = buildToolStatusMessage(mock.pi, owner);
        } finally {
          release.resolve();
        }
        const [result, status] = await Promise.all([change, observing]);
        assert.equal(result, "saved");
        assert.ok(status);
        assert.match(
          status,
          new RegExp(
            `tools available: ${action === "enable" ? "enabled" : "disabled"} \\(${selectedTools.length}/5 available\\)`,
          ),
        );
        const loaded = mock.rawPi.getActiveTools().filter((name) => names.includes(name as never)).length;
        assert.match(status, new RegExp(`Loaded capability tools this session: ${loaded}/5`));
        assert.match(
          status,
          action === "enable"
            ? /Persisted tool catalog: 5\/7 selected/
            : /Persisted tool catalog: all unavailable \(0\/7 selected\)/,
        );
        assert.match(status, new RegExp(`Saved tool mode: ${toolMode}`));
        assert.equal(reads?.mock.calls.length, 1);
      });

for (const boundary of ["transaction", "read"] as const)
  test(`status discards replaced-session output after pending ${boundary} without retired API reads`, async () => {
    const settings = await import("../src/settings.js");
    const { CORE_CHROME_DEVTOOLS_TOOL_NAMES: names } = await import("../src/tool-names.js");
    const { default: extension } = await import("../src/chrome-devtools.js");
    const { buildToolStatusMessage, setSelectedChromeDevtoolsTools } = await import("../src/tool-selector.js");
    writeFileSync(settings.settingsFilePath(), JSON.stringify({ tools: names, updatedAt: 1 }));
    const first = createMockPi({ activeTools: ["codemode", "other"] });
    const { ctx } = createMockContext({
      sessionManager: { getBranch: () => first.entries.map((entry) => ({ type: "custom", ...entry })) },
    });
    const owner = (ctx as { sessionManager: object }).sessionManager;
    extension(first.pi);
    await first.events.get("session_start")?.[0]?.({}, ctx);
    const started = deferred();
    const release = deferred();
    let change: Promise<unknown> | undefined;
    let observing: Promise<string>;
    if (boundary === "transaction") {
      const save = settings.saveSettings;
      vi.spyOn(settings, "saveSettings").mockImplementation((value, _operations, apply) =>
        save(
          value,
          {
            write: async (path, data) => {
              writeFileSync(path, data);
              started.resolve();
              await release.promise;
            },
          },
          apply,
        ),
      );
      change = setSelectedChromeDevtoolsTools(first.pi, ctx, [], [...names]);
      await started.promise;
      observing = buildToolStatusMessage(first.pi, owner);
    } else {
      const load = settings.loadSettings;
      vi.spyOn(settings, "loadSettings").mockImplementation(async (options) => {
        started.resolve();
        await release.promise;
        return load(options);
      });
      observing = buildToolStatusMessage(first.pi, owner);
      await started.promise;
    }
    const next = createMockPi({ activeTools: first.rawPi.getActiveTools() });
    extension(next.pi);
    let replacement: unknown;
    try {
      replacement = next.events.get("session_start")?.[0]?.({}, ctx);
      vi.spyOn(first.rawPi, "getActiveTools").mockImplementation(() => {
        throw new Error("retired API read");
      });
    } finally {
      release.resolve();
    }
    const [status] = await Promise.all([observing, change, replacement]);
    assert.equal(status, "");
  });

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const direction of ["add", "remove"] as const)
    for (const failure of ["registerTool", "setActiveTools", "appendEntry", "none"] as const)
      test(`${toolMode} WebMCP ${direction} ${failure} invalidates only a successful publication`, async () => {
        const settings = await import("../src/settings.js");
        const { CHROME_DEVTOOLS_TOOL_NAMES: names, CORE_CHROME_DEVTOOLS_TOOL_NAMES: core } = await import(
          "../src/tool-names.js"
        );
        const { default: extension } = await import("../src/chrome-devtools.js");
        const { setSelectedChromeDevtoolsTools } = await import("../src/tool-selector.js");
        const runtime = await import("../src/runtime.js");
        const initialTools = direction === "add" ? [...core] : [...names];
        const selectedTools = direction === "add" ? [...names] : [...core];
        const document = { toolMode, tools: initialTools, updatedAt: 1, webmcp: { enabled: true } };
        writeFileSync(settings.settingsFilePath(), JSON.stringify(document));
        const mock = createMockPi({ activeTools: ["codemode", "other"] });
        const { ctx } = createMockContext();
        const owner = (ctx as { sessionManager: object }).sessionManager;
        extension(mock.pi);
        await mock.events.get("session_start")?.[0]?.({}, ctx);
        const operation = runtime.beginWebMcpOperation(owner);
        const sibling = runtime.beginWebMcpOperation({});
        const generation = runtime.currentWebMcpGeneration(owner);
        if (failure !== "none") {
          const original = mock.rawPi[failure];
          let failed = false;
          vi.spyOn(mock.rawPi, failure).mockImplementation(((...args: never[]) => {
            const result = (original as (...args: never[]) => void)(...args);
            if (!failed) {
              failed = true;
              throw new Error(`${failure} failed`);
            }
            return result;
          }) as never);
        }
        try {
          const result = await setSelectedChromeDevtoolsTools(mock.pi, ctx, selectedTools, initialTools);
          const published = failure === "none";
          assert.equal(result, published ? "saved" : "failed");
          assert.equal(operation.signal.aborted, published);
          assert.equal(runtime.webMcpOperationIsCurrent(operation), !published);
          assert.equal(runtime.currentWebMcpGeneration(owner), generation + Number(published));
          assert.equal(sibling.signal.aborted, false);
          assert.equal(runtime.webMcpOperationIsCurrent(sibling), true);
          if (!published) assert.deepEqual(JSON.parse(readFileSync(settings.settingsFilePath(), "utf8")), document);
        } finally {
          operation.dispose();
          sibling.dispose();
        }
      });

for (const toolMode of ["codemode", "lazy", "direct"] as const)
  for (const enabled of [false, true])
    test(`${toolMode} unchanged effective WebMCP catalog preserves operations (gate ${enabled})`, async () => {
      const settings = await import("../src/settings.js");
      const {
        CHROME_DEVTOOLS_TOOL_NAMES: names,
        CORE_CHROME_DEVTOOLS_TOOL_NAMES: core,
        WEBMCP_TOOL_NAMES: gateways,
      } = await import("../src/tool-names.js");
      const { default: extension } = await import("../src/chrome-devtools.js");
      const { setSelectedChromeDevtoolsTools } = await import("../src/tool-selector.js");
      const runtime = await import("../src/runtime.js");
      const initialTools = enabled ? [...names] : [...core];
      const selectedTools = [...gateways, core[0]];
      writeFileSync(
        settings.settingsFilePath(),
        JSON.stringify({ toolMode, tools: initialTools, updatedAt: 1, webmcp: { enabled } }),
      );
      const mock = createMockPi({ activeTools: ["codemode"] });
      const { ctx } = createMockContext();
      const owner = (ctx as { sessionManager: object }).sessionManager;
      extension(mock.pi);
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const operation = runtime.beginWebMcpOperation(owner);
      const generation = runtime.currentWebMcpGeneration(owner);
      try {
        assert.equal(await setSelectedChromeDevtoolsTools(mock.pi, ctx, selectedTools, initialTools), "saved");
        assert.equal(operation.signal.aborted, false);
        assert.equal(runtime.webMcpOperationIsCurrent(operation), true);
        assert.equal(runtime.currentWebMcpGeneration(owner), generation);
      } finally {
        operation.dispose();
      }
    });
