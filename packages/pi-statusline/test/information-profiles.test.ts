import assert from "node:assert/strict";
import { test } from "vitest";
import { INFORMATION_PROFILES, inferInformationProfile } from "../src/information-profiles.js";

test("information profiles expose curated segment sets in deterministic order", () => {
  assert.deepEqual(INFORMATION_PROFILES.minimal, { left: ["cwd", "branch", "context"], right: ["model"] });
  assert.deepEqual(INFORMATION_PROFILES.balanced, {
    left: ["thinking", "cwd", "branch", "tools", "context", "time"],
    right: ["session", "provider", "model"],
  });
  assert.deepEqual(INFORMATION_PROFILES.detailed, {
    left: ["thinking", "cwd", "branch", "tools", "context", "tokens", "cache", "cost", "time"],
    right: ["session", "provider", "model"],
  });
});

test("information profile inference recognizes exact profiles and reports custom layouts", () => {
  assert.equal(
    inferInformationProfile({
      segments: INFORMATION_PROFILES.minimal.left,
      rightSegments: INFORMATION_PROFILES.minimal.right,
    }),
    "minimal",
  );
  assert.equal(
    inferInformationProfile({
      segments: INFORMATION_PROFILES.balanced.left,
      rightSegments: INFORMATION_PROFILES.balanced.right,
    }),
    "balanced",
  );
  assert.equal(
    inferInformationProfile({
      segments: INFORMATION_PROFILES.detailed.left,
      rightSegments: INFORMATION_PROFILES.detailed.right,
    }),
    "detailed",
  );
  assert.equal(inferInformationProfile({ segments: ["cwd", "context"], rightSegments: ["model"] }), "custom");
  assert.equal(inferInformationProfile({ segments: ["context", "cwd", "branch"], rightSegments: ["model"] }), "custom");
  assert.equal(
    inferInformationProfile({ segments: ["cwd", "line_break", "branch", "context"], rightSegments: ["model"] }),
    "custom",
  );
  assert.equal(
    inferInformationProfile({ segments: INFORMATION_PROFILES.minimal.left, rightSegments: ["provider", "model"] }),
    "custom",
  );
});
