import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const transition of ["reload", "availability"] as const)
  test(`withdrawn explicit activation becomes owned on direct ${transition}`, async () => {
    await withChromeRuntime(
      { native: true, toolMode: "codemode", activeCapabilities: [names[0]] },
      async ({ session, file }) => {
        assert.ok(session.getActiveToolNames().includes(names[0]));
        session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== names[0]));
        if (transition === "availability") await session.prompt("/chrome-devtools enable");
        await writeFile(file, JSON.stringify({ toolMode: "direct", browser: { autoLaunch: false } }));
        await session.reload();
        assert.ok(session.getActiveToolNames().includes(names[0]));
        await writeFile(file, JSON.stringify({ toolMode: "codemode", browser: { autoLaunch: false } }));
        await session.reload();
        assert.ok(!session.getActiveToolNames().includes(names[0]));
      },
    );
  });
test("extension-suppressed explicit activation is not mistaken for host withdrawal", async () => {
  await withChromeRuntime(
    { native: true, toolMode: "codemode", activeCapabilities: [names[0]] },
    async ({ session, file }) => {
      await session.prompt("/chrome-devtools disable");
      assert.ok(!session.getActiveToolNames().includes(names[0]));
      await session.prompt("/chrome-devtools enable");
      await writeFile(file, JSON.stringify({ toolMode: "direct", browser: { autoLaunch: false } }));
      await session.reload();
      await writeFile(file, JSON.stringify({ toolMode: "codemode", browser: { autoLaunch: false } }));
      await session.reload();
      assert.ok(session.getActiveToolNames().includes(names[0]));
    },
  );
});
