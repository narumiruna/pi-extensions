import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import type { RemoteHead, SyncBackend } from "../src/backends/sync-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { statePathForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { inspectSync } from "../src/sync/sync-inspection.js";
import { classifyObservation } from "../src/ui/sync-attention.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";

const head: RemoteHead = {
  snapshotId: "synced",
  snapshotRef: "ref",
  revision: "rev",
  machine: "remote",
  createdAt: "2026-09-06T00:00:00.000Z",
  syncSessions: false,
  selection: { version: 1, include: ["settings.json", "AGENTS.md"] },
};

const cases = [
  { name: "unchanged baseline", localChanged: false, remoteChanged: false },
  { name: "local edit", local: "edited", localChanged: true, remoteChanged: false },
  { name: "local deletion", missingLocal: true, localChanged: true, remoteChanged: false },
  {
    name: "remote snapshot changed",
    remote: { ...head, snapshotId: "other" },
    localChanged: false,
    remoteChanged: true,
  },
  {
    name: "revision only changed",
    remote: { ...head, revision: "new-rev" },
    localChanged: false,
    remoteChanged: true,
  },
  {
    name: "both changed",
    local: "edited",
    remote: { ...head, snapshotId: "other" },
    localChanged: true,
    remoteChanged: true,
  },
  { name: "remote removed", missingRemote: true, localChanged: false, remoteChanged: true },
  { name: "first sync", first: true, localChanged: true, remoteChanged: true },
  {
    name: "both empty without baseline",
    first: true,
    missingLocal: true,
    missingRemote: true,
    localChanged: false,
    remoteChanged: false,
  },
  {
    name: "empty include",
    include: [],
    localChanged: false,
    remoteChanged: true,
    selection: "different",
  },
  {
    name: "ordered selection mismatch",
    remote: {
      ...head,
      selection: { version: 1 as const, include: ["AGENTS.md", "settings.json"] },
    },
    localChanged: false,
    remoteChanged: false,
    selection: "different",
  },
  {
    name: "content selection mismatch",
    remote: { ...head, selection: { version: 1 as const, include: ["models.json"] } },
    localChanged: false,
    remoteChanged: false,
    selection: "different",
  },
  {
    name: "unknown legacy selection",
    remote: { ...head, selection: undefined },
    localChanged: false,
    remoteChanged: false,
    selection: "legacy",
  },
];

const presentations: Record<string, string> = {
  "unchanged baseline": "none",
  "local edit": "status",
  "local deletion": "status",
  "remote snapshot changed": "status",
  "revision only changed": "status",
  "both changed": "review",
  "remote removed": "review",
  "first sync": "review",
  "both empty without baseline": "guidance",
  "empty include": "guidance",
  "ordered selection mismatch": "review",
  "content selection mismatch": "review",
  "unknown legacy selection": "none",
};

for (const scenario of cases) {
  test(`inspection: ${scenario.name} remains advisory and read-only`, async () => {
    await withTempHome(async (agentDir) => {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        localConfigPath(),
        JSON.stringify(v3S3Settings({ include: scenario.include ?? ["settings.json", "AGENTS.md"] })),
      );
      const config = await loadConfig();
      if (!scenario.missingLocal) await writeFile(path.join(agentDir, "settings.json"), scenario.local ?? "baseline");
      if (!scenario.first)
        await writeStateForConfig(config, {
          version: 2,
          profile: config.snapshotIdentity,
          lastAppliedSnapshot: "synced",
          lastRemoteRevision: "rev",
          lastFileHashes: {
            "settings.json":
              snapshot([{ path: "settings.json", content: Buffer.from("baseline") }]).files[0]?.sha256 ?? "",
          },
          include: ["settings.json", "AGENTS.md"],
        });
      const stateBefore = await readFile(statePathForConfig(config)).catch(() => undefined);
      const settingsBefore = await readFile(localConfigPath());
      let reads = 0;
      const backend = {
        identity: "test",
        destination: "test",
        capability: "lease-protected",
        sameRevision: (a: string, b: string) => a === b,
        readHead: async () => {
          reads++;
          return scenario.missingRemote ? undefined : (scenario.remote ?? head);
        },
        readSnapshot: forbidden,
        publishSnapshot: forbidden,
        listHistory: forbidden,
        diagnose: forbidden,
      } as SyncBackend;
      const result = await inspectSync(
        config,
        { include: config.include, sessionDir: path.join(agentDir, "sessions") },
        undefined,
        async () => backend,
      );
      assert.equal(reads, 1);
      assert.equal(result.localChanged, scenario.localChanged);
      assert.equal(result.remoteChanged, scenario.remoteChanged);
      assert.equal(result.firstSync, scenario.first ?? false);
      assert.equal(result.emptyInclude, scenario.include?.length === 0);
      assert.equal(result.selectionState?.kind, scenario.missingRemote ? undefined : (scenario.selection ?? "same"));
      assert.equal(
        classifyObservation({
          setupName: config.setupName,
          configIdentity: "test",
          checkedAt: "test",
          inspection: result,
        }),
        presentations[scenario.name],
      );
      assert.equal("files" in result, false);
      assert.deepEqual(await readFile(localConfigPath()), settingsBefore);
      assert.deepEqual(await readFile(statePathForConfig(config)).catch(() => undefined), stateBefore);
      if (!scenario.missingLocal)
        assert.equal(await readFile(path.join(agentDir, "settings.json"), "utf8"), scenario.local ?? "baseline");
    });
  });
}

test("inspection honors custom session roots and protects excluded credential files", async () => {
  await withTempHome(async (agentDir) => {
    const sessionDir = path.join(agentDir, "..", "custom-sessions");
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(path.join(agentDir, "custom"));
    await writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ include: ["sessions", "custom"] })));
    const config = await loadConfig();
    const files = [
      [path.join(sessionDir, "active.jsonl"), '{"type":"session"}\n'],
      [path.join(sessionDir, "not-a-session.txt"), "excluded"],
      [path.join(agentDir, "custom", "notes.md"), "included"],
      [path.join(agentDir, "auth.json"), '{"token":"private"}'],
    ] as const;
    for (const [file, content] of files) await writeFile(file, content);
    const backend: SyncBackend = {
      identity: "test",
      destination: "test",
      capability: "lease-protected",
      sameRevision: (a: string, b: string) => a === b,
      readHead: async () => undefined,
      readSnapshot: forbidden,
      publishSnapshot: forbidden,
      listHistory: forbidden,
      diagnose: forbidden,
    };
    const result = await inspectSync(config, { include: config.include, sessionDir }, undefined, async () => backend);
    assert.equal(result.localFiles, 2);
    assert.equal(result.localChanged, true);
    for (const [file, content] of files) assert.equal(await readFile(file, "utf8"), content);
  });
});

async function forbidden(): Promise<never> {
  throw new Error("Inspection attempted a non-head backend operation");
}
