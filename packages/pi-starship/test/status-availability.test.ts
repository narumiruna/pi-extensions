import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { parseGitStatusPorcelain } from "../src/modules/git/runtime.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";

const runtime: StarshipRuntimeSnapshot = {
  cwd: "/repo",
  thinkingLevel: "off",
  turnCount: 0,
  activeTools: new Map(),
  isStreaming: false,
  tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  usingSubscription: false,
  gitBranch: "main",
  gitStatus: parseGitStatusPorcelain(" M file"),
  extensionStatuses: new Map(),
  now: new Date(0),
};

for (const [format, expected] of [
  [undefined, "before|after"],
  ["$all_status ", "before|after"],
  ["$worktree_modified ", "beforeM1 |after"],
  ["$index_modified ", "before|after"],
  ["[$all_status]($style)($ahead_behind) ", "before|after"],
] as const) {
  test(`suppressed Git status has no unused-template separator: ${format ?? "default"}`, () => {
    const { config } = normalizeConfig({
      format: "before$git_status|after",
      git_status: { modified: "", ...(format === undefined ? {} : { format }) },
    });
    assert.equal(
      renderStatusline(config, runtime)
        .chunks.map((chunk) => chunk.text)
        .join(""),
      expected,
    );
  });
}
