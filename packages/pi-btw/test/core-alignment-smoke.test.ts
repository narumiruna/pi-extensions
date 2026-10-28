import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";

test("package-directory Jiti entry opens and closes its lazy Kit menu without changing a draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-btw-core-smoke-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  initTheme("dark", false);
  const tui = createTuiHarness({ width: 80, rows: 24 });
  let runtime: ReturnType<DefaultResourceLoader["getExtensions"]>["runtime"] | undefined;
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(process.cwd(), "packages/pi-btw")],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    runtime = loaded.runtime;
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const command = loaded.extensions[0]?.commands.get("btw");
    assert.ok(command);
    runtime.getThinkingLevel = () => "off";
    const host = createMockContext({ mode: "tui", custom: tui.custom, editorText: "untouched main draft" });
    const running = command.handler("", host.ctx);
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    tui.send("\u0003");
    await running;
    assert.match(frame, /Pi BTW/u);
    assert.match(frame, /Start side thread/u);
    assert.match(frame, /Settings/u);
    assert.equal(host.editorText, "untouched main draft");
    assert.deepEqual(host.notifications, []);
  } finally {
    tui.dispose();
    runtime?.invalidate("package-directory lazy menu smoke complete");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
