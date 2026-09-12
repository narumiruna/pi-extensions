import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import interactionSmoke from "./fixtures/interaction-smoke.js";

test("interaction smoke fixture loads and registers deterministic commands", () => {
  const commands = new Map<string, unknown>();
  interactionSmoke({
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
  } as ExtensionAPI);
  assert.deepEqual([...commands.keys()], ["kit-capabilities-smoke", "kit-selector-smoke", "kit-secret-smoke"]);
});
