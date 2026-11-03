import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import worktreeExtension from "../src/worktree.js";
import { oid, porcelain, result } from "./command-test-support.js";

for (const target of ["status", "ls-files", "submodule status", "submodule foreach"]) {
  test(`remove does not confirm or mutate after truncated ${target} inventory`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-overflow-"));
    const main = join(root, "repo");
    const linked = join(root, "linked");
    mkdirSync(main);
    mkdirSync(linked);
    writeFileSync(join(linked, "precious.txt"), "retain\n");
    const mock = createMockPi();
    let confirmations = 0;
    let mutations = 0;
    (mock.rawPi as typeof mock.rawPi & { exec: ExtensionAPI["exec"] }).exec = async (_command, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return result(
          porcelain([
            { path: main, branch: "main" },
            { path: linked, branch: "feature" },
          ]),
        );
      }
      if (args[0] === "worktree") mutations += 1;
      if (args[0] === "rev-parse") return result(`${main}\n`);
      const key = args[0] === "submodule" ? args.slice(0, 2).join(" ") : args[0];
      if (key === target) {
        // Each prefix can look safe if it is mistaken for a complete result.
        const prefix =
          target === "status"
            ? "!! cache/\n"
            : target === "ls-files"
              ? "H tracked.txt\0"
              : target === "submodule status"
                ? `-${oid} deps/uninitialized\n`
                : "";
        return { ...result(prefix), truncated: true };
      }
      return result();
    };
    worktreeExtension(mock.pi);
    let selections = 0;
    const context = createMockContext({
      cwd: main,
      mode: "rpc",
      select: async (_title: string, choices: string[]) =>
        selections++ === 0 ? choices.find((choice) => choice.includes("Remove worktree")) : choices[0],
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    try {
      await mock.commands.get("worktree")?.handler("", context.ctx);
      assert.equal(confirmations, 0);
      assert.equal(mutations, 0);
      assert.equal(readFileSync(join(linked, "precious.txt"), "utf8"), "retain\n");
      assert.match(context.notifications.at(-1)?.message ?? "", /output exceeded/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("prune does not confirm or delete metadata after a truncated preview", async () => {
  const main = mkdtempSync(join(tmpdir(), "pi-worktree-prune-overflow-"));
  const mock = createMockPi();
  let confirmations = 0;
  let previews = 0;
  let mutations = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExtensionAPI["exec"] }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args.includes("--dry-run")) {
      previews += 1;
      return { ...result("Removing worktrees/stale: missing gitdir\n"), truncated: true };
    }
    if (args[0] === "worktree") mutations += 1;
    if (args[0] === "rev-parse") return result(`${main}\n`);
    return result();
  };
  worktreeExtension(mock.pi);
  const context = createMockContext({
    cwd: main,
    mode: "rpc",
    select: async (_title: string, choices: string[]) => choices.find((choice) => choice.includes("Prune stale")),
    confirm: async () => {
      confirmations += 1;
      return true;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(previews, 1);
    assert.equal(confirmations, 0);
    assert.equal(mutations, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /output exceeded/i);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

for (const phase of ["mutation", "verification"]) {
  test(`add retains worktree files without cleanup or switching after truncated ${phase} output`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-overflow-"));
    const main = join(root, "repo");
    const linked = join(root, "linked");
    mkdirSync(main);
    const mock = createMockPi();
    let added = false;
    let verificationQueries = 0;
    let cleanupCalls = 0;
    let switchQuestions = 0;
    (mock.rawPi as typeof mock.rawPi & { exec: ExtensionAPI["exec"] }).exec = async (_command, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        const listing = result(
          porcelain([{ path: main, branch: "main" }, ...(added ? [{ path: linked, branch: "feature" }] : [])]),
        );
        if (added) {
          verificationQueries += 1;
          return { ...listing, truncated: true };
        }
        return listing;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        added = true;
        mkdirSync(linked);
        writeFileSync(join(linked, "precious.txt"), "retain\n");
        return { ...result("Preparing worktree\n"), truncated: phase === "mutation" };
      }
      if (args[0] === "worktree") cleanupCalls += 1;
      if (args[0] === "rev-parse") return result(args.includes("--show-toplevel") ? `${main}\n` : `${oid}\n`);
      if (args[0] === "check-ref-format") return result("feature\n");
      return result();
    };
    worktreeExtension(mock.pi);
    const inputs = ["feature", linked];
    const context = createMockContext({
      cwd: main,
      mode: "rpc",
      select: async (_title: string, choices: string[]) => choices.find((choice) => choice.includes("Add worktree")),
      input: async () => inputs.shift(),
      confirm: async (title: string) => {
        if (title === "Switch Pi workspace?") switchQuestions += 1;
        return title === "Create Git worktree";
      },
    });
    try {
      await mock.commands.get("worktree")?.handler("", context.ctx);
      assert.equal(added, true);
      assert.equal(existsSync(linked), true);
      assert.equal(readFileSync(join(linked, "precious.txt"), "utf8"), "retain\n");
      assert.equal(cleanupCalls, 0);
      assert.equal(verificationQueries, phase === "mutation" ? 0 : 1);
      assert.equal(switchQuestions, 0);
      assert.match(
        context.notifications.at(-1)?.message ?? "",
        phase === "mutation" ? /output exceeded/i : /retained.*verification failed.*output exceeded/i,
      );
      assert.equal(
        context.notifications.some(({ message }) => message.startsWith("Created worktree")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
