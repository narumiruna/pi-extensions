import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

let agentDir: string;
let invalidate = () => {};
let runSmoke: (ctx: ExtensionCommandContext) => Promise<void>;

// Prepare the cold Jiti graph before timing each mode's interaction; do not enlarge the test budget.
beforeAll(async () => {
  agentDir = mkdtempSync(path.join(os.tmpdir(), "kit-renderer-smoke-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [path.resolve("packages/pi-tui-kit/test/fixtures/interaction-smoke.ts")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  invalidate = () => loaded.runtime.invalidate("smoke complete");
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const command = loaded.extensions[0].commands.get("kit-selector-smoke");
  assert.ok(command);
  runSmoke = (ctx) => command.handler("", ctx);
});

afterAll(() => {
  invalidate();
  vi.unstubAllEnvs();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
});

// Jiti loads the actual fixture; its lazy command runs through Pi's real renderers.
// No interactive shell, physical terminal, provider, or credentials are needed.
for (const mode of ["regular", "fullscreen"] as const) {
  test(`Pi Jiti fixture smoke exercises selectors in the ${mode} renderer`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme());
    t.onTestFinished(() => fixture.stop());
    const running = runSmoke(fixture.ctx);
    await fixture.waitForOpen();
    assert.match(fixture.frame().join("\n"), /Thinking/u);
    fixture.send("\x1b[B");
    fixture.send("\x13");
    await running;
    assert.deepEqual(fixture.notifications, [{ message: "Selector result: saveDefault high", level: "info" }]);
    assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
    assert.equal(fixture.editor.getValue(), "main draft");
  });
}
