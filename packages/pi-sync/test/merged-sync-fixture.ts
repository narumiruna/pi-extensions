import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { push } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions } from "./merge-options.js";

export { mergeOptions };

export async function createMergeFixture(agentDir: string, backend = new MemorySyncBackend(), sessions = false) {
  await fs.mkdir(agentDir, { recursive: true });
  const settings = v3S3Settings({ include: ["settings.json", "AGENTS.md", "prompts"] });
  Object.assign(settings.syncSetups.home.sync, { mergeSettings: true });
  if (sessions) {
    settings.syncSetups.home.sync.include.push("sessions");
    Object.assign(settings.syncSetups.home.sync, { automaticTransfer: true });
    await fs.mkdir(path.join(agentDir, "sessions/project"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "sessions/project/unchanged.jsonl"), '{"session":"preserved"}\n');
  }
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"original"}\n');
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), "original instructions\n");
  const { ctx, notifications } = createMockContext({ hasUI: true });
  await push(ctx, mergeOptions, undefined, () => backend);
  const baseHead = await backend.readHead();
  assert.ok(baseHead);
  const base = await backend.readSnapshot(baseHead.snapshotRef);
  async function remoteEdit(filePath: string, content?: string) {
    const head = await backend.readHead();
    assert.ok(head);
    const current = await backend.readSnapshot(head.snapshotRef);
    const changed = snapshot(content === undefined ? [] : [{ path: filePath, content: Buffer.from(content) }]).files;
    return backend.publishSnapshot(
      regenerateSnapshotIdentity({
        ...current,
        files: [...current.files.filter((file) => file.path !== filePath), ...changed],
      }),
      { kind: "revision", revision: head.revision },
    );
  }
  return { backend, ctx, notifications, base, baseHead, remoteEdit, config: await loadConfig() };
}
