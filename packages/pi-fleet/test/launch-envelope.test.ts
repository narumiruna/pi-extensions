import assert from "node:assert/strict";
import { test } from "vitest";
import { consumeLaunchEnvelope } from "../src/launch-envelope.js";
import { createGroup, formatInvite } from "../src/protocol.js";

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    PI_FLEET_INVITE: formatInvite(createGroup(Buffer.alloc(32, 15)).secret),
    PI_FLEET_PARENT_SESSION_ID: "parent",
    PI_FLEET_LAUNCH_ID: "launch_12345678",
    PI_FLEET_KICKOFF_CAPABILITY: "kickoff_1234567890abcdef",
    PI_FLEET_ACCEPT_REQUESTS: "0",
  };
}

test("launch envelope requires a parent-only kickoff capability and consumes every key", () => {
  const environment = baseEnvironment();
  delete environment.PI_FLEET_KICKOFF_CAPABILITY;
  assert.throws(() => consumeLaunchEnvelope(environment), /kickoff capability/u);
  assert.deepEqual(environment, {});
});

test("launch thinking level is rejected without a complete model identity and all keys are consumed", () => {
  const environment = { ...baseEnvironment(), PI_FLEET_THINKING: "high" };
  assert.throws(() => consumeLaunchEnvelope(environment), /model identity is incomplete/u);
  assert.deepEqual(environment, {});
});
