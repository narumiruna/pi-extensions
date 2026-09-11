import assert from "node:assert/strict";
import { test } from "vitest";
import { SyncBackendPublicationOutcomeUnknownError } from "../src/backends/sync-backend.js";
import { registerSyncBackendContractSuite } from "./backend-contract-suite.js";
import { snapshot } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

registerSyncBackendContractSuite("memory backend", () => new MemorySyncBackend());

test("memory backend distinguishes an unknown post-commit publication outcome", async () => {
  const backend = new MemorySyncBackend();
  backend.failNextPublicationAfterCommit = true;
  const value = snapshot([{ path: "settings.json", content: Buffer.from("committed") }]);

  await assert.rejects(backend.publishSnapshot(value, { kind: "missing" }), SyncBackendPublicationOutcomeUnknownError);
  assert.equal((await backend.readHead())?.snapshotId, value.id);
});
