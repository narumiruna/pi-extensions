import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { AnySyncConfig } from "../src/settings/settings-types.js";
import { sessionDirFromContext, snapshotOptionsForContext } from "../src/snapshot/session-paths.js";

const cases = [
  { name: "legacy context without directory methods", manager: {}, expected: undefined },
  {
    name: "legacy context with a custom directory",
    manager: { getSessionDir: () => "/custom/sessions" },
    expected: "/custom/sessions",
  },
  {
    name: "default directory does not become a custom snapshot root",
    manager: { usesDefaultSessionDir: () => true, getSessionDir: () => "/default/sessions" },
    expected: undefined,
  },
  {
    name: "custom directory preserves method receiver binding",
    manager: {
      custom: "/custom/sessions",
      usesDefaultSessionDir() {
        return !this.custom;
      },
      getSessionDir() {
        return this.custom;
      },
    },
    expected: "/custom/sessions",
  },
  {
    name: "custom context without a directory getter",
    manager: { usesDefaultSessionDir: () => false },
    expected: undefined,
  },
] as const;

for (const { name, manager, expected } of cases) {
  test(`snapshot context: ${name}`, () => {
    const { ctx } = createMockContext({ sessionManager: manager });
    const config = { include: ["settings.json", "sessions"] } as AnySyncConfig;
    assert.equal(sessionDirFromContext(ctx), expected);
    assert.deepEqual(snapshotOptionsForContext(ctx, config), {
      include: config.include,
      sessionDir: expected,
    });
    assert.equal(snapshotOptionsForContext(ctx, config).include, config.include);
  });
}
