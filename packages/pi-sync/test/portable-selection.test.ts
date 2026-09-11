import assert from "node:assert/strict";
import { test } from "vitest";
import { readSnapshotForHead } from "../src/sync/remote-snapshot.js";
import {
  compareSyncInclude,
  discoverLegacySnapshotInclude,
  snapshotSelectionInclude,
} from "../src/sync/sync-policy.js";
import { snapshot } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

test("portable selection comparison preserves exact selected-but-missing intent", () => {
  const remote = {
    ...snapshot([]),
    selection: {
      version: 1 as const,
      include: ["settings.json", "pi-starship.toml", "sessions"],
    },
  };
  assert.deepEqual(snapshotSelectionInclude(remote), ["settings.json", "pi-starship.toml", "sessions"]);
  assert.deepEqual(compareSyncInclude(["settings.json", "AGENTS.md"], remote.selection.include), {
    same: false,
    remoteOnly: ["pi-starship.toml", "sessions"],
    localOnly: ["AGENTS.md"],
  });
});

test("portable selection rejects policies that exceed bounded collection and path sizes", () => {
  assert.throws(
    () =>
      snapshotSelectionInclude({
        selection: {
          version: 1,
          include: Array.from({ length: 1_025 }, (_, index) => `path-${index}`),
        },
      }),
    /too many|limit/i,
  );
  assert.throws(
    () =>
      snapshotSelectionInclude({
        selection: { version: 1, include: ["x".repeat(4_097)] },
      }),
    /too long|limit/i,
  );
  assert.throws(
    () =>
      snapshotSelectionInclude({
        selection: {
          version: 1,
          include: Array.from({ length: 1_024 }, (_, index) => `path-${index}-${"x".repeat(250)}`),
        },
      }),
    /too large|limit/i,
  );
});

test("remote head selection is revalidated against the immutable snapshot", async () => {
  const backend = new MemorySyncBackend();
  const selected = {
    ...snapshot([]),
    selection: { version: 1 as const, include: ["settings.json"] },
  };
  const { head } = await backend.publishSnapshot(selected, { kind: "missing" });
  await assert.rejects(
    readSnapshotForHead(backend, {
      ...head,
      selection: { version: 1, include: ["models.json"] },
    }),
    /selection does not match/i,
  );
});

test("legacy snapshot discovery is safe, partial, and rooted", () => {
  const legacy = snapshot([
    { path: "settings.json", content: Buffer.from("settings") },
    { path: "skills/demo.md", content: Buffer.from("skill") },
    { path: "pi-starship.toml", content: Buffer.from("starship") },
    { path: "snippets/nested/example.md", content: Buffer.from("snippet") },
    { path: "sessions/project/session.jsonl", content: Buffer.from("session") },
    { path: ".env", content: Buffer.from("secret") },
    { path: "unsafe\\nested.txt", content: Buffer.from("unsafe") },
    { path: `control-${String.fromCharCode(27)}.txt`, content: Buffer.from("unsafe") },
  ]);
  assert.deepEqual(discoverLegacySnapshotInclude(legacy), [
    "settings.json",
    "skills",
    "pi-starship.toml",
    "snippets",
    "sessions",
  ]);
});
