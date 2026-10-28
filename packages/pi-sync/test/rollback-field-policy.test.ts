import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { portableSnapshot } from "../src/sync/local-fields.js";
import { push, rollback, syncBoth } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions as options } from "./merge-options.js";

async function fixture(root: string, policy: string[] | undefined) {
  await fs.mkdir(root, { recursive: true });
  const settings = v3S3Settings();
  if (policy !== undefined) Object.assign(settings.syncSetups.home.sync, { localFields: policy });
  await fs.writeFile(localConfigPath(), JSON.stringify({ ...settings, version: policy === undefined ? 3 : 4 }));
  const bytes = '{"theme":"base","machine":"local-value"}';
  await fs.writeFile(path.join(root, "settings.json"), bytes);
  const context = createMockContext({ hasUI: true, mode: "rpc" });
  const backend = new MemorySyncBackend();
  await push(context.ctx, options, undefined, () => backend);
  const config = await loadConfig();
  const head = await backend.readHead();
  assert.ok(head);
  return {
    ...context,
    ctx: context.ctx as ExtensionCommandContext,
    backend,
    config,
    bytes,
    head,
    state: await readStateForConfig(config),
  };
}

for (const decision of [
  "accept",
  "decline",
  "abort",
  "local-edit",
  "settings-edit",
  "head-edit",
  "same-policy",
] as const) {
  test(`rollback --yes authorizes the current head's policy: ${decision}`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root, []);
      const historical = await f.backend.readSnapshot(f.head.snapshotRef);
      const newHead = (
        await f.backend.publishSnapshot(
          { ...portableSnapshot(historical, decision === "same-policy" ? [] : ["machine"]), id: "current-head" },
          expectedRemoteHead(f.head),
        )
      ).head;
      const controller = new AbortController();
      const reviews: string[] = [];
      f.ctx.ui.confirm = async (title, message, input) => {
        if (title === "Reload Pi resources now?") return false;
        reviews.push(`${title}\n${message}`);
        assert.equal(input?.signal, controller.signal);
        if (decision === "abort") controller.abort();
        if (decision === "local-edit") await fs.writeFile(path.join(root, "settings.json"), '{"machine":"newer"}');
        if (decision === "settings-edit") {
          const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
          settings.syncSetups.home.sync.localFields = ["machine"];
          await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        }
        if (decision === "head-edit")
          await f.backend.publishSnapshot({ ...historical, id: "racing-head" }, expectedRemoteHead(newHead));
        return decision !== "decline";
      };
      const publication = vi.spyOn(f.backend, "publishSnapshot");
      const operation = rollback(
        f.ctx,
        { ...options, args: [f.head.snapshotRef], signal: controller.signal },
        () => f.backend,
      );
      if (decision === "abort") await assert.rejects(operation, { name: "AbortError" });
      else if (decision === "local-edit") await assert.rejects(operation, /Local bytes changed/);
      else if (decision === "settings-edit") await assert.rejects(operation, /Settings changed/);
      else if (decision === "head-edit") await assert.rejects(operation, /Remote changed/);
      else await operation;
      assert.equal(reviews.length, decision === "same-policy" ? 0 : 1);
      assert.doesNotMatch(reviews.join("\n"), /local-value/);
      if (reviews.length) {
        const review = reviews[0];
        assert.ok(review);
        assert.match(review, /Migrate portable settings policy.*required even with --yes/s);
      }
      const applied = decision === "accept" || decision === "same-policy";
      assert.equal(publication.mock.calls.length, applied || decision === "head-edit" ? 1 : 0);
      if (applied) {
        const head = await f.backend.readHead();
        assert.ok(head);
        assert.deepEqual((await f.backend.readSnapshot(head.snapshotRef)).localFields, []);
        await syncBoth(f.ctx, options, () => f.backend);
      } else {
        assert.deepEqual(await readStateForConfig(f.config), f.state);
        if (decision !== "head-edit") assert.deepEqual(await f.backend.readHead(), newHead);
      }
      if (decision !== "local-edit") assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), f.bytes);
    }));
}

for (const [historyPolicy, configured] of [
  [["machine"], []],
  [[], ["machine"]],
  [undefined, []],
  [[], undefined],
  [["machine"], ["other"]],
] as const) {
  test(`rollback refuses mismatched historical policy ${JSON.stringify(historyPolicy)} -> ${JSON.stringify(configured)} without losing newly portable fields`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root, configured === undefined ? undefined : [...configured]);
      const historical = portableSnapshot(
        {
          ...snapshot([{ path: "settings.json", content: Buffer.from('{"theme":"old","machine":"old-value"}') }]),
          id: "historical",
        },
        historyPolicy === undefined ? undefined : [...historyPolicy],
      );
      const target = (await f.backend.publishSnapshot(historical, expectedRemoteHead(f.head))).head;
      const publication = vi.spyOn(f.backend, "publishSnapshot");
      let prompts = 0;
      f.ctx.ui.confirm = async () => {
        prompts++;
        return true;
      };
      await assert.rejects(
        rollback(f.ctx, { ...options, force: true, args: [target.snapshotRef] }, () => f.backend),
        /historical snapshot.*policy.*match/,
      );
      assert.equal(prompts, 0);
      assert.equal(publication.mock.calls.length, 0);
      assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), f.bytes);
      assert.deepEqual(await readStateForConfig(f.config), f.state);
      assert.deepEqual(await f.backend.readHead(), target);
    }));
}
