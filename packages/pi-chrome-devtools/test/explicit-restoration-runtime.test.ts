import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const transition of ["enable", "reload"] as const)
  test(`codemode ${transition} restores availability-suppressed explicit activations`, async () => {
    await withChromeRuntime(
      { native: true, toolMode: "codemode", activeCapabilities: [names[0], names[2]] },
      async ({ session, file }) => {
        const before = session.getActiveToolNames();
        await session.prompt("/chrome-devtools disable");
        assert.ok(!session.getActiveToolNames().some((name) => names.includes(name as never)));
        if (transition === "enable") await session.prompt("/chrome-devtools enable");
        else {
          await writeFile(file, JSON.stringify({ toolMode: "codemode", browser: { autoLaunch: false } }));
          await session.reload();
        }
        assert.deepEqual(session.getActiveToolNames(), before);
        assert.ok(!session.getCallableToolNames().includes("chrome_devtools_webmcp_call_tool"));
        await session.reload();
        assert.deepEqual(session.getActiveToolNames(), before);
      },
    );
  });

test("codemode retained explicit WebMCP intent cannot bypass a disabled gate", async () => {
  const gateway = "chrome_devtools_webmcp_call_tool";
  const settings = (enabled: boolean) =>
    JSON.stringify({
      toolMode: "codemode",
      browser: { autoLaunch: false },
      webmcp: { enabled },
    });
  await withChromeRuntime(
    { native: true, toolMode: "codemode", activeCapabilities: [gateway], settingsText: settings(true) },
    async ({ session, file }) => {
      assert.ok(session.getActiveToolNames().includes(gateway));
      await writeFile(file, settings(false));
      await session.reload();
      assert.ok(!session.getActiveToolNames().includes(gateway));
      assert.equal(session.getToolDefinition(gateway)?.exposure, "hidden");
      await writeFile(file, settings(true));
      await session.reload();
      assert.ok(session.getActiveToolNames().includes(gateway));
    },
  );
});

test("codemode availability does not resurrect observed host withdrawal", async () => {
  await withChromeRuntime(
    { native: true, toolMode: "codemode", activeCapabilities: [names[0]] },
    async ({ session }) => {
      session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== names[0]));
      await session.prompt("/chrome-devtools enable");
      assert.ok(!session.getActiveToolNames().includes(names[0]));
      await session.reload();
      assert.ok(!session.getActiveToolNames().includes(names[0]));
    },
  );
});
