import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerGoalCommand } from "../src/command-registration.js";
import { GoalCommandController } from "../src/commands.js";
import { GoalRuntime } from "../src/runtime.js";

test("Goal UI modules load only on demand and cache successful imports", async () => {
  const mock = createMockPi();
  const runtime = new GoalRuntime(mock.pi);
  const commands = new GoalCommandController(runtime);
  let managerLoads = 0;
  let settingsLoads = 0;
  let managerShows = 0;
  let settingsShows = 0;

  registerGoalCommand(mock.pi, runtime, commands, {
    loadGoalManager: async () => {
      managerLoads += 1;
      return {
        showGoalManager: async (_runtime, _commands, ctx, showSettings) => {
          managerShows += 1;
          await showSettings(ctx, "automatic");
        },
      };
    },
    loadGoalSettings: async () => {
      settingsLoads += 1;
      return {
        showGoalSettings: async () => {
          settingsShows += 1;
        },
      };
    },
  });
  const command = mock.commands.get("goal");
  assert.ok(command);
  const { ctx } = createMockContext();

  await command.handler("status", ctx);
  assert.equal(managerLoads, 0);
  assert.equal(settingsLoads, 0);

  await command.handler("", ctx);
  await command.handler("", ctx);
  assert.equal(managerLoads, 1);
  assert.equal(settingsLoads, 1);
  assert.equal(managerShows, 2);
  assert.equal(settingsShows, 2);
});

test("Goal UI loader rejection can retry without opening stale-session UI", async () => {
  const mock = createMockPi();
  const runtime = new GoalRuntime(mock.pi);
  const commands = new GoalCommandController(runtime);
  const { ctx } = createMockContext();
  let managerLoads = 0;
  let managerShows = 0;
  let releaseLoad: (() => void) | undefined;

  registerGoalCommand(mock.pi, runtime, commands, {
    loadGoalManager: async () => {
      managerLoads += 1;
      if (managerLoads === 1) throw new Error("temporary Goal UI load failure");
      if (managerLoads === 2) {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
      }
      return {
        showGoalManager: async () => {
          managerShows += 1;
        },
      };
    },
  });
  const command = mock.commands.get("goal");
  assert.ok(command);

  await assert.rejects(async () => command.handler("", ctx), /temporary Goal UI load failure/u);
  const pending = command.handler("", ctx);
  await Promise.resolve();
  runtime.replaceMenuSession();
  releaseLoad?.();
  await pending;
  assert.equal(managerLoads, 2);
  assert.equal(managerShows, 0);

  await command.handler("", ctx);
  assert.equal(managerLoads, 2);
  assert.equal(managerShows, 1);
});
