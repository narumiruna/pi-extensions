import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";
import { WAIT_GOAL_ID, waitRenderFixtures } from "./support/goal-wait-render-fixtures.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-goal",
  forbiddenEagerInputs: ["src/menu.ts", "src/settings-ui.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  allowedEagerExternals: ["@narumitw/pi-tui-kit/terminal-document"],
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-goal-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("goal"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));
    const tool = extension.tools.get("goal_wait")?.definition;
    assert.ok(tool?.renderCall && tool.renderResult);
    const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as Theme;
    const renderContext: Parameters<NonNullable<ToolRenderers["renderResult"]>>[3] = {
      args: {},
      toolCallId: "loaded-wait",
      cwd: root,
      state: {},
      lastComponent: undefined,
      invalidate() {},
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 1,
      keyText: () => "",
      keyHint: () => "",
    };
    assert.deepEqual(tool.renderCall({}, theme, renderContext).render(80), ["Goal Wait"]);
    for (const fixture of waitRenderFixtures) {
      for (const expanded of [false, true]) {
        const result = {
          details: fixture.result.details,
          content: fixture.result.content.map((block) => ({ type: "text" as const, text: block.text })),
        };
        const rendered: string[] = tool
          .renderResult(result, { expanded, isPartial: false }, theme, renderContext)
          .render(80);
        const text = rendered.join("\n");
        assert.ok(text.includes("Resume:") === fixture.accepted);
        if (expanded) {
          assert.ok(text.replaceAll("\n", "").includes(fixture.expected));
          assert.equal(text.includes(`Goal ID: ${WAIT_GOAL_ID}`), fixture.accepted);
        }
      }
    }

    const context = createMockContext({ cwd: root, mode: "tui", hasUI: true });
    await extension?.commands.get("goal")?.handler("", context.ctx);
    assert.deepEqual(context.notifications, []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
