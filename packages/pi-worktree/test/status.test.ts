import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import type { WorktreeRecord } from "../src/git.js";
import { formatWorktreeStatusCard, loadWorktreeStatusCards, parseWorktreeStatusPorcelain } from "../src/status.js";

const oid = "0123456789abcdef0123456789abcdef01234567";

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    path: "/repo-feature",
    head: oid,
    branchRef: "refs/heads/feature",
    branch: "feature",
    isMain: false,
    bare: false,
    detached: false,
    ...overrides,
  };
}

function result(stdout = "", code = 0, stderr = ""): ExecResult {
  return { stdout, stderr, code, killed: false };
}

test("porcelain-v2 status parsing summarizes clean upstream state", () => {
  const parsed = parseWorktreeStatusPorcelain(
    [`# branch.oid ${oid}`, "# branch.head feature", "# branch.upstream origin/feature", "# branch.ab +3 -2", ""].join(
      "\0",
    ),
  );
  assert.deepEqual(parsed, {
    headOid: oid,
    branch: "feature",
    detached: false,
    upstream: "origin/feature",
    ahead: 3,
    behind: 2,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
  });
});

test("porcelain-v2 status parsing counts staged, unstaged, untracked, conflicts, and renames", () => {
  const parsed = parseWorktreeStatusPorcelain(
    [
      `# branch.oid ${oid}`,
      "# branch.head feature",
      "1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb staged.txt",
      "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb modified.txt",
      "1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb both.txt",
      "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed.txt",
      "old-name.txt",
      "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.txt",
      "? untracked.txt",
      "",
    ].join("\0"),
  );
  assert.equal(parsed.staged, 3);
  assert.equal(parsed.unstaged, 2);
  assert.equal(parsed.untracked, 1);
  assert.equal(parsed.conflicts, 1);
});

test("porcelain-v2 status parsing handles detached HEAD without upstream", () => {
  const parsed = parseWorktreeStatusPorcelain([`# branch.oid ${oid}`, "# branch.head (detached)", ""].join("\0"));
  assert.equal(parsed.detached, true);
  assert.equal(parsed.branch, undefined);
  assert.equal(parsed.upstream, undefined);
  assert.equal(parsed.ahead, undefined);
  assert.equal(parsed.behind, undefined);
});

test("status cards do not invent divergence counts when upstream has no branch.ab header", () => {
  const snapshot = parseWorktreeStatusPorcelain(
    [`# branch.oid ${oid}`, "# branch.head feature", "# branch.upstream origin/feature", ""].join("\0"),
  );
  const card = formatWorktreeStatusCard(record(), "/main", {
    kind: "available",
    snapshot,
    lastCommit: { committedAt: "2026-08-10T01:02:03+00:00", subject: "Initial" },
  });
  const upstream = card.details.find((line) => line.startsWith("Upstream:")) ?? "";
  assert.match(upstream, /origin\/feature.*ahead\/behind unavailable/i);
  assert.doesNotMatch(upstream, /ahead 0|behind 0/i);
});

test("porcelain-v2 status parsing rejects malformed and truncated records", () => {
  for (const output of [
    `# branch.oid ${oid}`,
    [`# branch.oid ${oid}`, "# branch.ab +x -1", ""].join("\0"),
    [`# branch.oid ${oid}`, "2 R. malformed", ""].join("\0"),
    [`# branch.oid ${oid}`, "x unknown", ""].join("\0"),
  ]) {
    assert.throws(() => parseWorktreeStatusPorcelain(output), /malformed|unknown|terminated/i);
  }
});

test("status cards use semantic text, preserve no-upstream uncertainty, and strip controls", () => {
  const card = formatWorktreeStatusCard(
    record({
      path: "/repo\u001b]8;;bad\u0007-feature",
      branch: "feat\u009b2Jure",
    }),
    "/main",
    {
      kind: "available",
      snapshot: {
        headOid: oid,
        branch: "feat\u009b2Jure",
        detached: false,
        staged: 2,
        unstaged: 1,
        untracked: 3,
        conflicts: 0,
      },
      lastCommit: {
        committedAt: "2026-08-10T01:02:03+00:00",
        subject: "Fix\u001b[2J status",
      },
    },
  );
  assert.match(card.statusText, /2 staged.*1 unstaged.*3 untracked/i);
  assert.ok(card.details.some((line) => /Upstream: not configured/i.test(line)));
  assert.ok(card.details.some((line) => /Last commit: 2026-08-10T01:02:03\+00:00.*Fix\[2J status/i.test(line)));
  for (const value of [card.label, card.description, card.statusText, ...card.details]) {
    assert.equal(
      [...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      }),
      false,
    );
  }
});

test("status cards expose locked, prunable, missing, and partial-error states", () => {
  const locked = formatWorktreeStatusCard(record({ lockedReason: "CI owns this" }), "/main", {
    kind: "available",
    snapshot: {
      headOid: oid,
      branch: "feature",
      detached: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
    },
    lastCommit: { committedAt: "2026-08-10T01:02:03+00:00", subject: "Initial" },
  });
  assert.match(locked.statusText, /clean/i);
  assert.ok(locked.details.some((line) => /Locked: CI owns this/i.test(line)));

  for (const [candidate, expected] of [
    [record({ prunableReason: "gitdir missing" }), /prunable.*gitdir missing/i],
    [record(), /path is missing/i],
    [record(), /status failed/i],
  ] as const) {
    const reason = expected.source.includes("prunable")
      ? "Prunable: gitdir missing"
      : expected.source.includes("missing")
        ? "Worktree path is missing"
        : "Status failed";
    const card = formatWorktreeStatusCard(candidate, "/main", {
      kind: "unavailable",
      reason,
    });
    assert.match(card.statusText, /unavailable/i);
    assert.ok(card.details.some((line) => expected.test(line)));
  }
});

test("status loading is bounded, keeps partial failures, and resolves commits from snapshot OIDs", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worktree-status-load-"));
  const records = Array.from({ length: 6 }, (_, index) => {
    const path = join(temporary, `repo-${index}`);
    mkdirSync(path);
    return record({ path, branch: `feature-${index}` });
  });
  let active = 0;
  let maximumActive = 0;
  const showArguments: string[][] = [];
  try {
    const cards = await loadWorktreeStatusCards(
      {
        exec: async (_command, args, options) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          if (options?.cwd === records[4]?.path && args[0] === "status") {
            return result("", 1, "status failed");
          }
          if (args[0] === "status") {
            return result([`# branch.oid ${oid}`, "# branch.head feature", ""].join("\0"));
          }
          showArguments.push(args);
          return result("2026-08-10T01:02:03+00:00\0Snapshot subject\n");
        },
      },
      records,
      records[0]?.path ?? "",
      undefined,
      { concurrency: 2 },
    );
    assert.equal(maximumActive, 2);
    assert.equal(cards.length, 6);
    assert.match(cards[4]?.statusText ?? "", /unavailable/i);
    assert.equal(showArguments.length, 5);
    assert.ok(showArguments.every((args) => args.at(-1) === oid));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("status loading aborts instead of publishing cards", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-worktree-status-abort-"));
  const controller = new AbortController();
  try {
    const pending = loadWorktreeStatusCards(
      {
        exec: async () => {
          controller.abort();
          return { ...result(), killed: true };
        },
      },
      [record({ path: temporary })],
      "/main",
      controller.signal,
    );
    await assert.rejects(pending, /abort/i);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
