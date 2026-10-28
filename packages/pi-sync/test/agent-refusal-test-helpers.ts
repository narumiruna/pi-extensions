import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { stageMergeBaseline } from "../src/state/merge-baseline-store.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

export async function enableAgentMode(partialSync = false) {
  const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
  if (partialSync) settings.version = 5;
  Object.assign(settings.syncSetups.home.sync, { agentMode: true, ...(partialSync ? { partialSync } : {}) });
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  const config = await loadConfig();
  await stageMergeBaseline(
    config,
    await createSnapshot(config.snapshotIdentity, { include: config.include }),
    await readStateForConfig(config),
  );
  return config;
}

export async function refusalFixture(agentDir: string, prefix = "") {
  const fixture = await createMergeFixture(agentDir);
  if (prefix) {
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), `${prefix}original instructions\n`);
    await push(fixture.ctx, mergeOptions, undefined, () => fixture.backend);
  }
  await enableAgentMode();
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), `${prefix}local\n`);
  await fixture.remoteEdit("AGENTS.md", `${prefix}remote\n`);
  let response: Parameters<typeof agentContext>[0] = (units) =>
    JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) });
  const mock = agentContext((units, context) => response(units, context), {
    select: async () => "Yes, Send one fresh request",
  });
  const run = (extra: Partial<CommandOptions> = {}) =>
    withStateDirectoryAccess(() =>
      withAgentSyncLock(mock.ctx, { ...mergeOptions, ...extra }, (options) =>
        syncBoth(mock.ctx, options, () => fixture.backend),
      ),
    );
  await assert.rejects(run(), /refused/);
  const root = path.join(agentDir, "pi-sync", "agent-resolver");
  const names = await fs.readdir(root);
  const name = names.find((file) => /^[a-f0-9]{64}\.json$/u.test(file));
  assert.ok(name);
  const file = path.join(root, name);
  const original = await fs.readFile(file, "utf8");
  return {
    ...fixture,
    mock,
    run,
    root,
    file,
    original,
    answer: (next: Parameters<typeof agentContext>[0] = selectRemote) => {
      response = next;
    },
  };
}
