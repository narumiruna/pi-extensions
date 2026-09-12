import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createHerdrMetadataClearSnapshot,
  createHerdrMetadataRequest,
  createHerdrMetadataSnapshot,
  formatContextUsagePercent,
  HERDR_METADATA_MAX_CHARACTERS,
  HERDR_METADATA_REFRESH_MS,
  HERDR_METADATA_TOKEN_KEYS,
  HERDR_METADATA_TTL_MS,
  herdrMetadataSnapshotsEqual,
  normalizeHerdrMetadataValue,
} from "../src/herdr-metadata.js";

test("normalizes hostile and overlong metadata without splitting Unicode", () => {
  assert.equal(normalizeHerdrMetadataValue(undefined), null);
  assert.equal(normalizeHerdrMetadataValue(" \n\t "), null);
  assert.equal(normalizeHerdrMetadataValue(" model\nname\u001b]8;;https://spoof\u0007\u202e "), "model name");
  const normalized = normalizeHerdrMetadataValue("🐑".repeat(HERDR_METADATA_MAX_CHARACTERS + 1));
  assert.equal([...String(normalized)].length, HERDR_METADATA_MAX_CHARACTERS);
  assert.equal(String(normalized).endsWith("🐑"), true);
});

test("builds complete snapshots and rounds valid context usage", () => {
  assert.equal(formatContextUsagePercent(12.49), "12%");
  assert.equal(formatContextUsagePercent(12.5), "13%");
  assert.equal(formatContextUsagePercent(101.2), "101%");
  for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(formatContextUsagePercent(value), null);
  }

  assert.deepEqual(
    createHerdrMetadataSnapshot({
      model: "claude",
      provider: "anthropic",
      thinking: "high",
      session: "Review metadata",
      contextUsagePercent: 48.6,
    }),
    {
      model: "claude",
      provider: "anthropic",
      thinking: "high",
      session: "Review metadata",
      context_usage: "49%",
    },
  );
  assert.deepEqual(createHerdrMetadataSnapshot({}), createHerdrMetadataClearSnapshot());
});

test("compares snapshots by the five stable owned keys", () => {
  const snapshot = createHerdrMetadataSnapshot({ model: "m" });
  assert.equal(herdrMetadataSnapshotsEqual(undefined, snapshot), false);
  assert.equal(herdrMetadataSnapshotsEqual(snapshot, snapshot), true);
  assert.equal(herdrMetadataSnapshotsEqual(snapshot, createHerdrMetadataSnapshot({ model: "next" })), false);
  assert.deepEqual(Object.keys(snapshot), [...HERDR_METADATA_TOKEN_KEYS]);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("constructs bounded full-patch requests without pane presentation fields", () => {
  const snapshot = createHerdrMetadataSnapshot({ model: "m", provider: "p" });
  const request = createHerdrMetadataRequest({
    id: "metadata-1",
    paneId: "w1:p1",
    source: "herdr:pi",
    seq: 42,
    snapshot,
  });
  assert.deepEqual(request, {
    id: "metadata-1",
    method: "pane.report_metadata",
    params: {
      pane_id: "w1:p1",
      source: "herdr:pi",
      seq: 42,
      tokens: {
        model: "m",
        provider: "p",
        thinking: null,
        session: null,
        context_usage: null,
      },
      ttl_ms: HERDR_METADATA_TTL_MS,
    },
  });
  assert.equal(HERDR_METADATA_REFRESH_MS <= HERDR_METADATA_TTL_MS / 2, true);
  for (const forbidden of ["title", "display_agent", "state_labels", "agent"]) {
    assert.equal(forbidden in request.params, false);
  }
});
