import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStatuslineCommand } from "../src/commands.js";
import { loadStatuslineSettings } from "../src/settings.js";

function assistant(total: number, totalFromProvider?: boolean) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: 10,
        output: 2,
        cost: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total, totalFromProvider },
      },
    },
  };
}

function statusCommand() {
  const mock = createMockPi();
  registerStatuslineCommand(mock.pi, {
    settingsPath: "/tmp/pi-statusline-cost-status.json",
    getLoaded: () => loadStatuslineSettings("/tmp/pi-statusline-cost-status.json"),
    apply() {
      assert.fail("A status read must not apply settings");
    },
  });
  const command = mock.commands.get("statusline");
  assert.ok(command);
  return command;
}

const cases = [
  { name: "confirmed", entries: [assistant(1.25, true)], expected: "$1.25 (provider-reported)" },
  { name: "provider zero", entries: [assistant(0, true)], expected: "$0.000 (provider-reported)" },
  { name: "estimated", entries: [assistant(0.125, false)], expected: "$0.125 (unconfirmed)" },
  { name: "legacy", entries: [assistant(0.125)], expected: "$0.125 (unconfirmed)" },
  {
    name: "mixed",
    entries: [assistant(0.125, true), assistant(0.125, false)],
    expected: "$0.250 (unconfirmed)",
  },
  { name: "empty", entries: [], expected: "$0.000 (unconfirmed)" },
  {
    name: "missing total",
    entries: [{ type: "usage", usage: { input: 1, cost: { totalFromProvider: true } } }],
    expected: "$0.000 (unconfirmed)",
  },
];

for (const mode of ["tui", "rpc"] as const) {
  test.each(cases)(`status exposes $name cost provenance in ${mode}`, async ({ entries, expected }) => {
    const command = statusCommand();
    const context = createMockContext({
      mode,
      hasUI: true,
      sessionManager: { getEntries: () => entries },
      custom: async () => assert.fail("Status must not open custom UI"),
    });
    await command.handler("status", context.ctx);
    assert.ok(context.notifications.at(-1)?.message.includes(`session cost: ${expected}`));
    assert.equal(context.notifications.at(-1)?.level, "info");
  });
}

test.each(["print", "json"] as const)("status remains silent and does not read usage in %s mode", async (mode) => {
  const context = createMockContext({
    mode,
    hasUI: false,
    sessionManager: { getEntries: () => assert.fail("Unavailable output must not read session usage") },
    custom: async () => assert.fail("Non-TUI modes must not open custom UI"),
  });
  await statusCommand().handler("status", context.ctx);
  assert.deepEqual(context.notifications, []);
});

test("the menu Status action uses the same session cost detail", async () => {
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (_title: string, choices: string[]) => choices.find((choice) => choice === "Status"),
    sessionManager: { getEntries: () => [assistant(0.125, true)] },
  });
  await statusCommand().handler("", context.ctx);
  assert.match(context.notifications.at(-1)?.message ?? "", /session cost: \$0\.125 \(provider-reported\)/u);
});
