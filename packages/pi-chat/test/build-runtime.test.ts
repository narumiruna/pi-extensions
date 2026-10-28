import assert from "node:assert/strict";
import { test } from "vitest";
import { withGeneratedRuntime } from "../../../test/generated-runtime-fixture.js";
import { registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-chat",
  forbiddenEagerInputs: [
    "src/network.ts",
    "src/directory-network.ts",
    "src/menu.ts",
    "src/chat-view.ts",
    "src/widget.ts",
  ],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated runtime loads a representative lazy menu through Pi's Jiti resource loader", async () => {
  await withGeneratedRuntime(packageRoot, await loadBuilder(), async (extension) => {
    const command = extension.commands.get("chat");
    assert.ok(command);
    assert.ok(extension.handlers.has("session_start"));
    assert.ok(extension.handlers.has("session_shutdown"));
    let rendered = "";
    const context = createMockContext({
      mode: "tui",
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        rendered = harness.render().join("\n");
        harness.handleInput("\u0003");
        return harness.result;
      },
    });
    try {
      for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, context.ctx);
      await command.handler("", context.ctx);
      assert.match(rendered, /Browse public rooms/u);
      assert.equal(context.widgets.get("chat"), undefined);
    } finally {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, context.ctx);
    }
  });
});
