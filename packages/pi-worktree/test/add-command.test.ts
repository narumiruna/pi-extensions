import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import worktreeExtension from "../src/worktree.js";
import { type ExecFunction, oid, porcelain, result } from "./command-test-support.js";

test("add creates a new branch with safe argv, verifies it, and can leave the session unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  const mock = createMockPi();
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  let added = false;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args, options) => {
    calls.push({ args, cwd: options?.cwd });
    if (args[0] === "worktree" && args[1] === "list") {
      return result(
        porcelain([{ path: main, branch: "main" }, ...(added ? [{ path: linked, branch: "feature" }] : [])]),
      );
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") return result("", 1);
    if (args[0] === "symbolic-ref") return result("main\n");
    if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
    if (args[0] === "worktree" && args[1] === "add") {
      added = true;
      return result();
    }
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", "", linked];
  const confirms = [true, false];
  let creationPreview = "";
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async () => inputs.shift(),
    confirm: async (title: string, message: string) => {
      if (title === "Create Git worktree") creationPreview = message;
      return confirms.shift() ?? false;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.match(creationPreview, /Branch: "feature" \(new local branch\)/i);
    assert.match(creationPreview, /Base: current branch "main"/i);
    assert.match(creationPreview, new RegExp(`Base commit: ${oid}`));
    assert.ok(creationPreview.includes(`Path: "${linked}"`));
    assert.deepEqual(calls.find(({ args }) => args[0] === "worktree" && args[1] === "add")?.args, [
      "worktree",
      "add",
      "-b",
      "feature",
      linked,
      oid,
    ]);
    assert.match(context.notifications.at(-1)?.message ?? "", /created.*repo-feature/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add previews explicit and existing local branch provenance with exact OIDs", async () => {
  for (const mode of ["explicit", "existing"] as const) {
    const root = mkdtempSync(join(tmpdir(), `pi-worktree-add-${mode}-`));
    const main = join(root, "repo");
    const linked = join(root, "repo-feature");
    mkdirSync(main);
    const mock = createMockPi();
    let added = false;
    (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return result(
          porcelain([
            { path: main, branch: "main" },
            ...(added ? [{ path: linked, branch: "feature", head: oid }] : []),
          ]),
        );
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
      if (args[0] === "check-ref-format") return result("feature\n");
      if (args[0] === "show-ref") return result("", mode === "existing" ? 0 : 1);
      if (args[0] === "symbolic-ref") return result("main\n");
      if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
      if (args[0] === "worktree" && args[1] === "add") added = true;
      return result();
    };
    worktreeExtension(mock.pi);
    const inputs = mode === "explicit" ? ["feature", "release", linked] : ["feature", linked];
    let preview = "";
    const context = createMockContext({
      cwd: main,
      hasUI: true,
      mode: "tui",
      select: async () => "Add worktree",
      input: async () => inputs.shift(),
      confirm: async (title: string, message: string) => {
        if (title === "Create Git worktree") preview = message;
        return title === "Create Git worktree";
      },
    });
    try {
      await mock.commands.get("worktree")?.handler("", context.ctx);
      assert.match(
        preview,
        mode === "explicit"
          ? /Branch: "feature" \(new local branch\)[\s\S]*Base: explicit commit-ish "release"/i
          : /Branch: "feature" \(existing local branch\)[\s\S]*Base: existing local branch "feature"/i,
      );
      assert.match(preview, new RegExp(`Base commit: ${oid}`));
      assert.equal(added, true, JSON.stringify(context.notifications));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("add refuses an existing branch that moves after confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-moving-branch-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  const movedOid = oid.replace(/^0/, "1");
  const mock = createMockPi();
  let resolveCalls = 0;
  let addCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      if (args[1] === "add") addCalls += 1;
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") return result();
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      resolveCalls += 1;
      return result(`${resolveCalls === 1 ? oid : movedOid}\n`);
    }
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", linked];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async () => inputs.shift(),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(addCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /branch feature moved.*select it again/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add rechecks a replaced symbolic-link ancestor immediately before mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-ancestor-race-"));
  const main = join(root, "repo");
  const safeParent = join(root, "safe-parent");
  const linked = join(safeParent, "nested", "repo-feature");
  mkdirSync(main);
  mkdirSync(safeParent);
  const mock = createMockPi();
  let resolveCalls = 0;
  let addCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      if (args[1] === "add") addCalls += 1;
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") return result();
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      resolveCalls += 1;
      if (resolveCalls === 2) {
        rmSync(safeParent, { recursive: true });
        symlinkSync("missing-parent", safeParent);
      }
      return result(`${oid}\n`);
    }
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", linked];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async () => inputs.shift(),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(addCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /symbolic-link ancestor/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add refuses a new branch name that appears after confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-appearing-branch-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  const mock = createMockPi();
  let showRefCalls = 0;
  let addCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      if (args[1] === "add") addCalls += 1;
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") {
      showRefCalls += 1;
      return result("", showRefCalls === 1 ? 1 : 0);
    }
    if (args[0] === "symbolic-ref") return result("main\n");
    if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", "", linked];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async () => inputs.shift(),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(addCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /branch feature changed.*select it again/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add retains but reports an existing worktree whose HEAD mismatches the approved preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-head-mismatch-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  const movedOid = oid.replace(/^0/, "1");
  const mock = createMockPi();
  let added = false;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(
        porcelain([
          { path: main, branch: "main" },
          ...(added ? [{ path: linked, branch: "feature", head: movedOid }] : []),
        ]),
      );
    }
    if (args[0] === "worktree" && args[1] === "add") {
      added = true;
      return result();
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") return result();
    if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", linked];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async () => inputs.shift(),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(added, true);
    assert.match(context.notifications.at(-1)?.message ?? "", /retained.*verification failed.*HEAD/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add strips terminal controls from branch-derived prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-add-controls-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  const control = "; Path: /fake\u009b2J";
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result(`feat${control}spoof\n`);
    if (args[0] === "show-ref") return result("", 1);
    if (args[0] === "symbolic-ref") return result(`main${control}spoof\n`);
    if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", "", linked];
  const dialogs: string[] = [];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async (title: string, placeholder: string) => {
      dialogs.push(title, placeholder);
      return inputs.shift();
    },
    confirm: async (title: string, message: string) => {
      dialogs.push(title, message);
      return false;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(dialogs.length, 8);
    const preview = dialogs.at(-1) ?? "";
    assert.match(preview, /Branch: "feat; Path: \/fake\\u009b2Jspoof"/i);
    assert.match(preview, /Base: current branch "main; Path: \/fake\\u009b2Jspoof"/i);
    assert.equal(
      dialogs.every((value) =>
        [...value].every((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code > 0x1f && (code < 0x7f || code > 0x9f);
        }),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add refuses a broken symlink target before creating the branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-symlink-add-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  symlinkSync("missing-target", linked);
  const mock = createMockPi();
  let mutations = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "add") mutations += 1;
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") return result("", 1);
    if (args[0] === "symbolic-ref") return result("main\n");
    if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", "", linked];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async () => inputs.shift(),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(mutations, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /target path already exists/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add refuses a broken symlink ancestor before creating the branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-symlink-parent-add-"));
  const main = join(root, "repo");
  const brokenParent = join(root, "broken-parent");
  const linked = join(brokenParent, "nested", "repo-feature");
  mkdirSync(main);
  symlinkSync("missing-parent", brokenParent);
  const mock = createMockPi();
  let mutations = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "add") mutations += 1;
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feature\n");
    if (args[0] === "show-ref") return result("", 1);
    if (args[0] === "symbolic-ref") return result("main\n");
    if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
    return result();
  };
  worktreeExtension(mock.pi);
  const inputs = ["feature", "", linked];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Add worktree",
    input: async () => inputs.shift(),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(mutations, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /symbolic-link ancestor/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add cancellation and occupied branches never execute worktree add", async () => {
  for (const mode of ["cancel", "occupied"] as const) {
    const root = mkdtempSync(join(tmpdir(), "pi-worktree-refuse-add-"));
    const main = join(root, "repo");
    const other = join(root, "other");
    mkdirSync(main);
    const mock = createMockPi();
    let mutations = 0;
    (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
      if (args[0] === "worktree" && args[1] === "add") mutations += 1;
      if (args[0] === "worktree" && args[1] === "list") {
        return result(
          porcelain([
            { path: main, branch: "main" },
            ...(mode === "occupied" ? [{ path: other, branch: "feature" }] : []),
          ]),
        );
      }
      if (args[0] === "rev-parse") return result(`${main}\n`);
      if (args[0] === "check-ref-format") return result("feature\n");
      if (args[0] === "show-ref") return result("", mode === "occupied" ? 0 : 1);
      return result();
    };
    worktreeExtension(mock.pi);
    const context = createMockContext({
      cwd: main,
      hasUI: true,
      mode: "tui",
      select: async () => "Add worktree",
      input: async () => (mode === "cancel" ? undefined : "feature"),
    });
    try {
      await mock.commands.get("worktree")?.handler("", context.ctx);
      assert.equal(mutations, 0);
      if (mode === "occupied") {
        assert.match(context.notifications.at(-1)?.message ?? "", /already checked out/i);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
