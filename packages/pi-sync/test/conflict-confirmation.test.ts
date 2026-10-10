import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { showConflicts } from "../src/sync/conflict-review.js";
import { mergeSync } from "../src/sync/merged-sync.js";
import { withTempHome } from "./helpers.js";
import { fixture, options, publish } from "./partial-sync-fixture.js";

test("conflict review offers optional exact versions and retains resolution choices", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const before = await readStateForConfig(f.config);
    const head = await f.backend.readHead();
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    const pages: string[] = [];
    const offered: string[][] = [];
    let reviewed = false;
    let reachedResolution = false;
    const context = createMockContext({
      mode: "rpc",
      select: async (title: string, choices: string[]) => {
        pages.push(title);
        offered.push(choices);
        if (title === "Review unresolved dependency group") return choices[0];
        if (title === "Resolve the entire reviewed group") {
          reachedResolution = true;
          return "Keep unresolved";
        }
        if (choices.includes("View details")) {
          if (!reviewed) {
            reviewed = true;
            return "View details";
          }
          return "Yes, Continue to resolution choices";
        }
        return choices.includes("Next") ? "Next" : "Back";
      },
    });
    try {
      await showConflicts(context.ctx, options, () => f.backend);
      assert.equal(reachedResolution, true);
      assert.ok(offered.some((choices) => choices.includes("Yes, Continue to resolution choices")));
      assert.match(pages.join("\n"), /Local:\n.*\nLOCAL/s);
      assert.match(pages.join("\n"), /Remote:\n.*\nREMOTE/s);
      assert.equal(publication.mock.calls.length, 0);
      assert.deepEqual(await readStateForConfig(f.config), before);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "LOCAL\nb\nc\n");
    } finally {
      publication.mockRestore();
    }
  }));
