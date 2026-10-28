import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { localConfigPath } from "../src/settings/config-file.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { mergeSync } from "../src/sync/merged-sync.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { mergeOptions } from "./merge-options.js";
import { recoveryFixture } from "./recovery-test-helpers.js";

const fixture = recoveryFixture();

for (const denied of ["automatic", "background", "no-ui", "print", "agent-off"] as const)
  test(`merge rejects refused-candidate retry with ${denied} authorization before backend initialization`, async () => {
    const { f, config } = fixture();
    const mock = agentContext(selectRemote, {
      hasUI: denied !== "no-ui",
      mode: denied === "print" ? "print" : "rpc",
    });
    if (denied === "agent-off") {
      const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      settings.syncSetups.home.sync.agentMode = false;
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    }
    const state = await readStateForConfig(config);
    const backend = vi.fn(() => f.backend);
    await assert.rejects(
      mergeSync(
        mock.ctx,
        {
          ...mergeOptions,
          agentRetryRefusal: true,
          auto: denied === "automatic",
          ...(denied === "background" ? { background: { validate() {}, reserve: async () => {} } } : {}),
        },
        backend,
      ),
      /requires foreground Agent mode in TUI or RPC/,
    );
    assert.equal(backend.mock.calls.length, 0);
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(await readStateForConfig(config), state);
  });

test("refused-candidate retry cannot reconcile a newly pending journal before consent", async () => {
  const { agentDir, f, config } = fixture();
  const mock = agentContext(selectRemote);
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), "pending publication\n");
  f.backend.failNextPublicationAfterCommit = true;
  await assert.rejects(mergeSync(mock.ctx, mergeOptions, () => f.backend));
  const journal = await readMergeJournal(config);
  assert.ok(journal);
  const state = await readStateForConfig(config);
  const read = vi.spyOn(f.backend, "readHead");
  const publish = vi.spyOn(f.backend, "publishSnapshot");
  await assert.rejects(
    mergeSync(mock.ctx, { ...mergeOptions, agentRetryRefusal: true }, () => f.backend),
    /pending merge journal requires ordinary Sync now/,
  );
  assert.equal(read.mock.calls.length, 0);
  assert.equal(publish.mock.calls.length, 0);
  assert.equal(mock.requests.length, 0);
  assert.deepEqual(await readMergeJournal(config), journal);
  assert.deepEqual(await readStateForConfig(config), state);
  assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "pending publication\n");
});
