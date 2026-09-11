import assert from "node:assert/strict";
import { test } from "vitest";
import { shouldRefreshSyncedState } from "../src/sync/sync-state.js";
import { requiredConfig, snapshot } from "./helpers.js";

test("matching legacy state backfills an opaque remote revision on no-op sync", () => {
  const remote = snapshot([{ path: "settings.json", content: Buffer.from("same") }]);
  const head = {
    snapshotRef: remote.id,
    snapshotId: remote.id,
    revision: "memory:2",
    createdAt: remote.createdAt,
    machine: remote.machine,
    syncSessions: false,
  };
  const config = {
    ...requiredConfig(),
    region: "auto",
    profile: "default",
    prefix: "pi-sync",
    syncSessions: false,
  };
  const state = {
    version: 1,
    profile: "default",
    lastAppliedSnapshot: remote.id,
    lastFileHashes: Object.fromEntries(remote.files.map((file) => [file.path, file.sha256])),
  };
  const sameRevision = (left: string, right: string) => left === right;

  assert.equal(shouldRefreshSyncedState(remote, head, state, config, sameRevision), true);
  assert.equal(
    shouldRefreshSyncedState(remote, head, { ...state, lastRemoteRevision: head.revision }, config, sameRevision),
    false,
  );
});
