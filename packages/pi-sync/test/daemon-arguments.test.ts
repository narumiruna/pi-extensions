import assert from "node:assert/strict";
import { test } from "vitest";
import { completeSyncArguments, parseOptions, validateCommandOptions } from "../src/commands/command.js";

for (const action of ["status", "handover", "allow-after-exit", "revoke-after-exit"])
  test(`daemon ${action} is accepted and completed`, () => {
    assert.doesNotThrow(() => validateCommandOptions("daemon", parseOptions([action])));
    assert.ok(completeSyncArguments("daemon ")?.some((item) => item.value === `daemon ${action}`));
    assert.ok(completeSyncArguments(`daemon ${action.slice(0, 3)}`)?.some((item) => item.value === `daemon ${action}`));
    assert.equal(completeSyncArguments(`daemon ${action} `), null);
  });
test("unsupported daemon actions and flags reject before dispatch", () => {
  for (const action of ["stop", "restart", "serve", "invalid"])
    assert.throws(() => validateCommandOptions("daemon", parseOptions([action])), /Unknown daemon action/u);
  assert.throws(() => validateCommandOptions("daemon", parseOptions(["status", "extra"])), /Unexpected/u);
  assert.throws(() => validateCommandOptions("daemon", parseOptions(["--yes"])), /not supported/u);
  assert.equal(completeSyncArguments("daemon invalid"), null);
});
