import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { CORE_CHROME_DEVTOOLS_TOOL_NAMES as names } from "../src/tool-names.js";
import { withChromeRuntime } from "./runtime-session.js";

for (const invalidSource of ["user", "project"] as const)
  for (const toolMode of ["codemode", "direct", "lazy"] as const)
    for (const catalog of ["empty", "partial"] as const) {
      test(`${invalidSource} invalid mixed-source ${toolMode} ${catalog} keeps authoritative user policy`, async () => {
        const tools = catalog === "empty" ? [] : [names[0]];
        await withChromeRuntime({ native: true, toolMode, tools }, async ({ session, file }) => {
          const active = session.getActiveToolNames();
          session.settingsManager.setProjectTrusted(true);
          const project = join(session.sessionManager.getCwd(), ".pi", "pi-chrome-devtools.json");
          await mkdir(dirname(project), { recursive: true });
          await writeFile(
            project,
            invalidSource === "project" ? "{" : JSON.stringify({ browser: { autoLaunch: false } }),
          );
          if (invalidSource === "user") await writeFile(file, "{");
          await session.reload();
          assert.deepEqual(
            names.filter((name) => session.getToolDefinition(name)?.exposure !== "hidden"),
            tools,
          );
          assert.deepEqual(session.getActiveToolNames(), active);
          assert.equal(await readFile(invalidSource === "user" ? file : project, "utf8"), "{");
        });
      });
    }
test("invalid project-only settings do not freeze missing user catalog defaults", async () => {
  await withChromeRuntime({ native: true, toolMode: "direct", tools: [] }, async ({ session, file }) => {
    session.settingsManager.setProjectTrusted(true);
    const project = join(session.sessionManager.getCwd(), ".pi", "pi-chrome-devtools.json");
    await mkdir(dirname(project), { recursive: true });
    await writeFile(project, "{");
    await unlink(file);
    await session.reload();
    assert.ok(names.every((name) => session.getCallableToolNames().includes(name)));
    assert.ok(!session.getCallableToolNames().includes("chrome_devtools_load"));
  });
});
