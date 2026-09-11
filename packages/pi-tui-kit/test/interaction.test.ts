import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { invokeMenuInteraction, type MenuInteraction } from "../src/interaction.js";
import { defineMenu } from "../src/model.js";
import type { MenuScreen } from "../src/types.js";

test("the internal driver rejects mismatched and disabled interactions without invoking actions", async () => {
  let actionCalls = 0;
  const context = createMockContext({ mode: "rpc", hasUI: true });
  const enabled: MenuScreen<"main", "act"> = {
    kind: "actions",
    title: "Actions",
    items: [{ id: "run", label: "Run", action: "act" }],
  };
  const disabled: MenuScreen<"main", "act"> = {
    ...enabled,
    items: [{ id: "run", label: "Run", action: "act", disabled: true }],
  };
  const definition = defineMenu<undefined, "main", "act">({
    start: "main",
    screens: { main: () => enabled },
    actions: {
      act: async () => {
        actionCalls += 1;
        return { kind: "close" };
      },
    },
  });
  const invoke = (screen: MenuScreen<"main", "act">, interaction: MenuInteraction) =>
    invokeMenuInteraction({
      ctx: context.ctx,
      definition,
      screen,
      state: undefined,
      menuSignal: new AbortController().signal,
      runtime: {},
      interaction,
    });

  assert.deepEqual(await invoke(enabled, { kind: "setting", itemId: "run", value: "On" }), {
    accepted: false,
    stale: false,
    transition: { kind: "stay" },
  });
  assert.deepEqual(await invoke(disabled, { kind: "activate", itemId: "run" }), {
    accepted: false,
    stale: false,
    transition: { kind: "stay" },
  });
  assert.deepEqual(await invoke(enabled, { kind: "activate", itemId: "missing" }), {
    accepted: false,
    stale: false,
    transition: { kind: "stay" },
  });
  assert.equal(actionCalls, 0);
});
