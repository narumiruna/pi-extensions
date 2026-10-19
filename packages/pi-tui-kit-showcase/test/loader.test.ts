import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";

test("Pi Jiti loads the package and runs a new interaction across the lazy boundary", async (t) => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "tui-kit-showcase-loader-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  t.onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [path.resolve("packages/pi-tui-kit-showcase")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  t.onTestFinished(() => loaded.runtime.invalidate("test complete"));
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  const command = loaded.extensions[0].commands.get("tui-kit-showcase");
  expect(command).toBeDefined();
  if (!command) throw new Error("Showcase command did not load");

  const tui = createTuiHarness({ width: 100, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = command.handler("", context.ctx);
  t.onTestFinished(async () => {
    tui.dispose();
    await running;
  });
  await tui.waitForOpen();
  // The command and menu are loaded by Jiti; use its actual screen order.
  const { createInitialShowcaseState, createShowcaseMenu } = await import("../src/menu.js");
  const { resolveMenuScreen } = await import("@narumitw/pi-tui-kit");
  const main = resolveMenuScreen(createShowcaseMenu({ requestStandalone() {} }), "main", createInitialShowcaseState());
  if (main.kind !== "actions") throw new Error("Expected main actions");
  const index = main.items.findIndex((item) => item.id === "secretInput");
  expect(index).toBeGreaterThanOrEqual(0);
  for (let row = 0; row < index; row += 1) tui.press("tui.select.down");
  const closed = tui.resultPromise;
  tui.press("tui.select.confirm");
  await closed;
  await tui.waitForOpen();
  expect(tui.render().join("\n")).toContain("Demo secret");
  tui.type("sample-only");
  tui.press("tui.input.submit");
  await tui.waitForOpen();
  expect(context.notifications).toEqual([{ message: "Demo secret discarded.", level: "info" }]);
  tui.press("ctrl+c");
  await running;
  expect(tui.isOpen).toBe(false);
});
