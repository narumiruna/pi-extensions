import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

for (const exit of ["no", "protocol-cancel", "details", "failure", "abort"] as const) {
  test(`${exit} confirmation applies no local files and publishes no remote snapshot`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"local"}\n');
      await f.remoteEdit("AGENTS.md", "remote instructions\n");
      const beforeState = await readStateForConfig(f.config);
      const beforeHead = await f.backend.readHead();
      const publication = vi.spyOn(f.backend, "publishSnapshot");
      const controller = new AbortController();
      let calls = 0;
      const context = createMockContext({
        mode: "rpc",
        select: async (_title: string, choices: string[]) => {
          calls++;
          if (exit === "failure") throw new Error("dialog failed");
          if (exit === "abort") {
            controller.abort();
            return choices.find((choice) => choice.startsWith("Yes,"));
          }
          if (exit === "protocol-cancel") return undefined;
          if (exit === "details" && calls === 1) return "View details";
          if (!choices.includes("View details")) return choices.includes("Next") ? "Next" : "Back";
          return "No, cancel";
        },
      });
      try {
        const operation = syncBoth(
          context.ctx,
          { ...mergeOptions, yes: false, signal: controller.signal },
          () => f.backend,
        );
        if (exit === "failure") await assert.rejects(operation, /no transfer was performed/);
        else assert.equal(await operation, "cancelled");
        assert.equal(publication.mock.calls.length, 0);
        assert.deepEqual(await f.backend.readHead(), beforeHead);
        assert.deepEqual(await readStateForConfig(f.config), beforeState);
        assert.equal(await readMergeJournal(f.config), undefined);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
        assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"local"}\n');
        if (exit === "details") assert.ok(calls >= 3);
      } finally {
        publication.mockRestore();
      }
    }));
}

test("APPEND_SYSTEM remote update is approved directly through the new summary", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
    settings.syncSetups.home.sync.include.push("APPEND_SYSTEM.md");
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(agentDir, "APPEND_SYSTEM.md"), "old appendix\n");
    await push(f.ctx, { ...mergeOptions, force: true }, undefined, () => f.backend);
    await f.remoteEdit("APPEND_SYSTEM.md", "new appendix\n");
    const beforeHead = await f.backend.readHead();
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    const titles: string[] = [];
    const choicesSeen: string[][] = [];
    const context = createMockContext({
      mode: "rpc",
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        choicesSeen.push(choices);
        return "Yes, update local file";
      },
    });
    try {
      assert.equal(await syncBoth(context.ctx, { ...mergeOptions, yes: false }, () => f.backend), "applied");
      assert.equal(titles.length, 1);
      assert.match(titles[0], /^Update 1 local file\?/);
      assert.match(titles[0], /Update APPEND_SYSTEM.md from remote/);
      assert.match(titles[0], /Remote file changes: none/);
      assert.match(titles[0], /Remote snapshot publication: no/);
      assert.doesNotMatch(titles[0], /No file changes|conditional-required|baselines/);
      assert.equal(choicesSeen[0][0], "No, cancel");
      assert.ok(choicesSeen[0].includes("View details"));
      assert.equal(publication.mock.calls.length, 0);
      assert.deepEqual(await f.backend.readHead(), beforeHead);
      assert.equal(await fs.readFile(path.join(agentDir, "APPEND_SYSTEM.md"), "utf8"), "new appendix\n");
    } finally {
      publication.mockRestore();
    }
  }));

test("a remote edit during optional details invalidates later approval", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await f.remoteEdit("AGENTS.md", "remote instructions\n");
    let opened = false;
    const context = createMockContext({
      mode: "rpc",
      select: async (_title: string, choices: string[]) => {
        if (choices.includes("View details")) {
          if (!opened) {
            opened = true;
            return "View details";
          }
          return "Yes, update local file";
        }
        await f.remoteEdit("AGENTS.md", "newer remote writer\n");
        return "Back";
      },
    });
    await assert.rejects(
      syncBoth(context.ctx, { ...mergeOptions, yes: false }, () => f.backend),
      /Remote changed during review/,
    );
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "original instructions\n");
    assert.equal(await readMergeJournal(f.config), undefined);
  }));
