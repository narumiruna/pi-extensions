import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders } from "./continuous-test-helpers.js";
import { RecoveryClock as Clock, recoveryFixture, waitRecoveryStatus as waitStatus } from "./recovery-test-helpers.js";

vi.mock("../src/sync/continuous-watch.js", () => ({ watchContinuous: async () => () => {} }));

const fixture = recoveryFixture();

test("uncertain publication with a superseding remote stays conservative across polls and owner restart", async () => {
  const { agentDir, f, config } = fixture();
  const file = path.join(agentDir, "AGENTS.md");
  await fs.writeFile(file, "pending local\n");
  const before = await readStateForConfig(config);
  const mock = agentContext(selectRemote);
  const clock = new Clock();
  const publish = vi.spyOn(f.backend, "publishSnapshot");
  f.backend.failNextPublicationAfterCommit = true;
  let service = createContinuousSync(continuousLoaders(f.backend), clock);
  try {
    service.start(mock.ctx, new AbortController().signal);
    await waitStatus(mock.statuses, /blocked: unknown/);
    const journal = await readMergeJournal(config);
    assert.ok(journal);
    await f.remoteEdit("AGENTS.md", "superseding remote\n");
    const head = await f.backend.readHead();
    for (const restart of [false, true]) {
      mock.statuses.clear();
      if (restart) {
        await service.stop();
        assert.equal(clock.tasks.size, 0);
        service = createContinuousSync(continuousLoaders(f.backend), clock);
        service.start(mock.ctx, new AbortController().signal);
      } else clock.advance(67000);
      await waitStatus(mock.statuses, /blocked: unknown/);
      assert.deepEqual(await readMergeJournal(config), journal, "uncertain evidence must not be retired");
      assert.deepEqual(await readStateForConfig(config), before);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(await fs.readFile(file, "utf8"), "pending local\n");
      assert.equal(publish.mock.calls.length, 2, "one uncertain commit and one external writer; no blind retry");
      assert.equal(mock.requests.length, 0);
    }
  } finally {
    await service.stop();
    assert.equal(clock.tasks.size, 0);
  }
});
