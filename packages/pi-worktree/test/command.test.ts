import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import { createWorktreeSettingsRuntime, type WorktreeSettingsRuntime } from "../src/settings.js";
import worktreeExtension from "../src/worktree.js";

const oid = "0123456789abcdef0123456789abcdef01234567";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function porcelain(
  records: Array<{
    path: string;
    branch?: string;
    detached?: boolean;
    head?: string;
    lockedReason?: string;
    prunableReason?: string;
  }>,
): string {
  return records
    .flatMap((record) => [
      `worktree ${record.path}`,
      `HEAD ${record.head ?? oid}`,
      record.detached ? "detached" : `branch refs/heads/${record.branch}`,
      ...(record.lockedReason !== undefined ? [`locked ${record.lockedReason}`] : []),
      ...(record.prunableReason !== undefined ? [`prunable ${record.prunableReason}`] : []),
      "",
    ])
    .join("\0");
}

test("/worktree registers one argument-free interactive command and no LLM tool", () => {
  const mock = createMockPi();
  worktreeExtension(mock.pi);
  const command = mock.commands.get("worktree");
  assert.ok(command);
  assert.equal(command.getArgumentCompletions, undefined);
  assert.deepEqual(mock.tools, []);
});

test("session_start reloads settings and warns through the replacement context", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-session-settings-"));
  const settingsPath = join(root, "pi-worktree.json");
  writeFileSync(settingsPath, '{"worktreeRoot":"/srv/worktrees"}\n');
  const settings = createWorktreeSettingsRuntime({
    path: settingsPath,
    home: "/home/alice",
    platform: "linux",
  });
  const mock = createMockPi();
  worktreeExtension(mock.pi, { settings });
  const sessionStart = mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  try {
    const first = createMockContext({ hasUI: true, mode: "tui" });
    await sessionStart({}, first.ctx);
    assert.equal(settings.get().effectiveRoot, "/srv/worktrees");
    assert.deepEqual(first.notifications, []);

    writeFileSync(settingsPath, "{broken\n");
    const replacement = createMockContext({ hasUI: true, mode: "tui" });
    await sessionStart({}, replacement.ctx);
    assert.equal(settings.get().effectiveRoot, "/srv/worktrees");
    assert.match(replacement.notifications.at(-1)?.message ?? "", /ignored/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session replacement drops a delayed settings reload continuation", async () => {
  let resolveFirst!: (value: Awaited<ReturnType<WorktreeSettingsRuntime["reload"]>>) => void;
  const firstReload = new Promise<Awaited<ReturnType<WorktreeSettingsRuntime["reload"]>>>((resolve) => {
    resolveFirst = resolve;
  });
  let reloads = 0;
  const state = {
    effectiveRoot: "/srv/worktrees",
    source: "user" as const,
    configuredRoot: "/srv/worktrees",
    canSave: true,
  };
  const settings: WorktreeSettingsRuntime = {
    get: () => state,
    getPath: () => "/agent/pi-worktree.json",
    reload: () => {
      reloads += 1;
      return reloads === 1 ? firstReload : Promise.resolve({ ...state, warning: "replacement warning" });
    },
    save: async () => state,
    flush: async () => undefined,
  };
  const mock = createMockPi();
  worktreeExtension(mock.pi, { settings });
  const sessionStart = mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  const first = createMockContext({ hasUI: true, mode: "tui" });
  const pending = sessionStart({}, first.ctx);
  const replacement = createMockContext({ hasUI: true, mode: "tui" });
  await sessionStart({}, replacement.ctx);
  resolveFirst({ ...state, warning: "stale warning" });
  await pending;

  assert.deepEqual(first.notifications, []);
  assert.match(replacement.notifications.at(-1)?.message ?? "", /replacement warning/);
});

test("/worktree rejects hidden text arguments and non-UI mode without Git calls", async () => {
  const mock = createMockPi();
  let execCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => {
    execCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  const ui = createMockContext({ hasUI: true, mode: "tui" });
  await mock.commands.get("worktree")?.handler("add feature", ui.ctx);
  assert.match(ui.notifications.at(-1)?.message ?? "", /does not accept arguments/i);
  const headless = createMockContext({ hasUI: false, mode: "print" });
  await mock.commands.get("worktree")?.handler("", headless.ctx);
  assert.equal(execCalls, 0);
});

test("/worktree waits for full idle before reading Git state or opening dialogs", async () => {
  const mock = createMockPi();
  const order: string[] = [];
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    order.push(`git:${args[0]}:${args[1]}`);
    return args[0] === "worktree" ? result(porcelain([{ path: "/repo", branch: "main" }])) : result("/repo\n");
  };
  worktreeExtension(mock.pi);
  const context = createMockContext({
    cwd: "/repo",
    hasUI: true,
    mode: "tui",
    waitForIdle: async () => order.push("idle"),
    select: async () => {
      order.push("select");
      return undefined;
    },
  });
  await mock.commands.get("worktree")?.handler("", context.ctx);
  assert.deepEqual(order, ["idle", "git:worktree:list", "git:rev-parse:--show-toplevel", "select"]);
});

test("/worktree menu exposes only actionable flows", async () => {
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      return result(porcelain([{ path: "/repo", branch: "main" }]));
    }
    return result("/repo\n");
  };
  worktreeExtension(mock.pi);
  let actions: string[] = [];
  const context = createMockContext({
    cwd: "/repo",
    hasUI: true,
    mode: "tui",
    select: async (_title: string, items: string[]) => {
      actions = items;
      return undefined;
    },
  });
  await mock.commands.get("worktree")?.handler("", context.ctx);
  assert.deepEqual(actions, [
    "Worktree status",
    "Add worktree",
    "Switch worktree",
    "Remove worktree",
    "Prune stale metadata",
    "Configure worktree root",
  ]);
});

test("remove deletes only a confirmed clean linked worktree and verifies deregistration", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  mkdirSync(linked);
  const mock = createMockPi();
  const calls: string[][] = [];
  let removed = false;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    calls.push(args);
    if (args[0] === "worktree" && args[1] === "list") {
      return result(
        porcelain([{ path: main, branch: "main" }, ...(!removed ? [{ path: linked, branch: "feature" }] : [])]),
      );
    }
    if (args[0] === "rev-parse") return result(`${main}\n`);
    if (args[0] === "status" || args[0] === "submodule") return result();
    if (args[0] === "worktree" && args[1] === "remove") {
      removed = true;
      return result();
    }
    return result();
  };
  worktreeExtension(mock.pi);
  let selectCount = 0;
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async (_title: string, items: string[]) => (selectCount++ === 0 ? "Remove worktree" : items[0]),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.deepEqual(
      calls.find((args) => args[0] === "worktree" && args[1] === "remove"),
      ["worktree", "remove", linked],
    );
    assert.match(context.notifications.at(-1)?.message ?? "", /branch was preserved/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remove refuses dirty, locked, and unreachable detached worktrees without mutation", async () => {
  for (const mode of ["dirty", "locked", "detached"] as const) {
    const root = mkdtempSync(join(tmpdir(), "pi-worktree-refuse-remove-"));
    const main = join(root, "repo");
    const linked = join(root, "repo-linked");
    mkdirSync(main);
    mkdirSync(linked);
    const mock = createMockPi();
    let removeCalls = 0;
    (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return result(
          porcelain([
            { path: main, branch: "main" },
            mode === "detached"
              ? { path: linked, detached: true }
              : {
                  path: linked,
                  branch: "feature",
                  lockedReason: mode === "locked" ? "CI owns this" : undefined,
                },
          ]),
        );
      }
      if (args[0] === "rev-parse") return result(`${main}\n`);
      if (args[0] === "status") return result(mode === "dirty" ? "?? local.txt\n" : "");
      if (args[0] === "submodule") return result();
      if (args[0] === "for-each-ref") return result("");
      if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
      return result();
    };
    worktreeExtension(mock.pi);
    let selectCount = 0;
    const context = createMockContext({
      cwd: main,
      hasUI: true,
      mode: "tui",
      select: async (_title: string, items: string[]) => (selectCount++ === 0 ? "Remove worktree" : items[0]),
      confirm: async () => true,
    });
    try {
      await mock.commands.get("worktree")?.handler("", context.ctx);
      assert.equal(removeCalls, 0);
      assert.match(
        context.notifications.at(-1)?.message ?? "",
        mode === "dirty" ? /local\.txt/ : mode === "locked" ? /CI owns this/ : /not reachable/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("remove explicitly confirms and discards reflog-only recovery history", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-history-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  const administrative = join(main, ".git", "worktrees", "repo-feature");
  mkdirSync(main);
  mkdirSync(linked);
  mkdirSync(join(administrative, "logs"), { recursive: true });
  const orphan = oid.replace(/^0/, "1");
  writeFileSync(
    join(administrative, "logs", "HEAD"),
    `${"0".repeat(40)} ${orphan} Test <test@example.invalid> 0 +0000\tcommit\n${orphan} ${oid} Test <test@example.invalid> 1 +0000\tcheckout\n`,
  );
  const mock = createMockPi();
  let removed = false;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(
        porcelain([{ path: main, branch: "main" }, ...(!removed ? [{ path: linked, branch: "feature" }] : [])]),
      );
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return result(`${main}\n`);
    }
    if (args[0] === "rev-parse" && args.includes("--git-dir")) {
      return result(`${administrative}\n`);
    }
    if (args[0] === "status" || args[0] === "submodule") return result();
    if (args.includes("for-each-ref")) return result();
    if (args[0] === "worktree" && args[1] === "remove") removed = true;
    return result();
  };
  worktreeExtension(mock.pi);
  let selects = 0;
  let confirmation = "";
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async (_title: string, items: string[]) => (selects++ === 0 ? "Remove worktree" : items[0]),
    confirm: async (_title: string, message: string) => {
      confirmation = message;
      return true;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(removed, true);
    assert.match(confirmation, new RegExp(orphan));
    assert.match(confirmation, /recovery pointers.*garbage-collected/i);
    assert.match(context.notifications.at(-1)?.message ?? "", /branch was preserved/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remove refuses administrative recovery history added during final validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-history-race-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  const administrative = join(main, ".git", "worktrees", "repo-feature");
  const logPath = join(administrative, "logs", "HEAD");
  mkdirSync(linked, { recursive: true });
  mkdirSync(join(administrative, "logs"), { recursive: true });
  const firstOrphan = oid.replace(/^0/, "1");
  const laterOrphan = oid.replace(/^0/, "2");
  writeFileSync(logPath, `${"0".repeat(40)} ${firstOrphan} Test <test@example.invalid> 0 +0000\tcommit\n`);
  const mock = createMockPi();
  let statusCalls = 0;
  let removeCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(
        porcelain([
          { path: main, branch: "main" },
          { path: linked, branch: "feature" },
        ]),
      );
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return result(`${main}\n`);
    if (args[0] === "rev-parse" && args.includes("--git-dir")) return result(`${administrative}\n`);
    if (args[0] === "status") {
      statusCalls += 1;
      if (statusCalls === 2) {
        writeFileSync(
          logPath,
          `${"0".repeat(40)} ${firstOrphan} Test <test@example.invalid> 0 +0000\tcommit\n${firstOrphan} ${laterOrphan} Test <test@example.invalid> 1 +0000\tcommit\n`,
        );
      }
      return result();
    }
    if (args[0] === "submodule" || args.includes("for-each-ref")) return result();
    if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  let selects = 0;
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async (_title: string, items: string[]) => (selects++ === 0 ? "Remove worktree" : items[0]),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(removeCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /history changed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remove refuses path reuse when the selected worktree identity changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-remove-race-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  mkdirSync(linked);
  const mock = createMockPi();
  let listCalls = 0;
  let removeCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      listCalls += 1;
      return result(
        porcelain([
          { path: main, branch: "main" },
          listCalls === 1
            ? { path: linked, branch: "feature" }
            : { path: linked, branch: "replacement", head: oid.replace(/^0/, "1") },
        ]),
      );
    }
    if (args[0] === "rev-parse") return result(`${main}\n`);
    if (args[0] === "status" || args[0] === "submodule") return result();
    if (args[0] === "worktree" && args[1] === "remove") removeCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  let selectCount = 0;
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async (_title: string, items: string[]) => (selectCount++ === 0 ? "Remove worktree" : items[0]),
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(removeCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /changed identity/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("switch action prepares a target-cwd session and uses the replacement context", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-command-switch-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  mkdirSync(linked);
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      return result(
        porcelain([
          { path: main, branch: "main" },
          { path: linked, branch: "feature" },
        ]),
      );
    }
    return result(`${main}\n`);
  };
  worktreeExtension(mock.pi);
  let selectCount = 0;
  let switchedCwd = "";
  let replacementNotice = "";
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
    select: async (_title: string, items: string[]) => (selectCount++ === 0 ? "Switch worktree" : items[0]),
    switchSession: async (path: string, options: { withSession?: (ctx: unknown) => Promise<void> }) => {
      const session = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(path);
      switchedCwd = session.getCwd();
      await options.withSession?.({
        cwd: linked,
        ui: { notify: (message: string) => (replacementNotice = message) },
      });
      return { cancelled: false };
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(switchedCwd, linked);
    assert.match(replacementNotice, /switched/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("switch selection searches branch and path while preserving raw worktree identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-search-choice-"));
  const main = join(root, "repo");
  const first = join(root, "worktrees", "frontend");
  const second = join(root, "worktrees", "zzzzzzzz");
  mkdirSync(main, { recursive: true });
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      return result(
        porcelain([
          { path: main, branch: "main" },
          { path: first, branch: "feature/ui" },
          { path: second, branch: "yyyyyyyy" },
        ]),
      );
    }
    return result(`${main}\n`);
  };
  worktreeExtension(mock.pi);
  const tui = createTuiHarness({ width: 160, rows: 20 });
  let customCalls = 0;
  let switchedCwd = "";
  let filteredFrame = "";
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
    custom: async (factory: Parameters<typeof tui.custom>[0], options?: unknown) => {
      customCalls += 1;
      const pending = tui.custom(factory, options as never);
      await tui.waitForOpen();
      if (customCalls === 1) {
        tui.press("tui.select.down");
        tui.press("tui.select.down");
        tui.press("tui.select.confirm");
      } else {
        tui.type("zzzzzzzz yyyyyyyy");
        filteredFrame = tui.render().join("\n");
        tui.press("tui.select.confirm");
        await tui.waitForPending();
      }
      return pending;
    },
    switchSession: async (path: string, options: { withSession?: (ctx: unknown) => Promise<void> }) => {
      const session = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(path);
      switchedCwd = session.getCwd();
      await options.withSession?.({ cwd: second, ui: { notify() {} } });
      return { cancelled: false };
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(customCalls, 2);
    assert.match(filteredFrame, /→ 2\..*zzzzzzzz/u);
    assert.doesNotMatch(filteredFrame, /frontend/u);
    assert.equal(switchedCwd, second, JSON.stringify(context.notifications));
  } finally {
    tui.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("switch choices use unique ordinals when sanitized worktree labels collide", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-label-collision-"));
  const main = join(root, "repo");
  const first = join(root, "wt-\nsame");
  const second = join(root, "wt-same");
  mkdirSync(main);
  mkdirSync(first);
  mkdirSync(second);
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      return result(
        porcelain([
          { path: main, branch: "main" },
          { path: first, detached: true },
          { path: second, detached: true },
        ]),
      );
    }
    return result(`${main}\n`);
  };
  worktreeExtension(mock.pi);
  let customCalls = 0;
  let switchedCwd = "";
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
    custom: async (factory: unknown) => {
      customCalls += 1;
      const harness = createCustomSelectorHarness(factory, 80);
      assert.equal(harness.isPiTuiKitScreen, true);
      if (customCalls === 1) {
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
      } else {
        assert.match(harness.render(240).join("\n"), /1\..*wt-.*same/);
        assert.match(harness.render(240).join("\n"), /2\..*wt-same/);
        harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
        await harness.waitForPending();
      }
      return harness.result;
    },
    switchSession: async (path: string, options: { withSession?: (ctx: unknown) => Promise<void> }) => {
      const session = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(path);
      switchedCwd = session.getCwd();
      await options.withSession?.({ cwd: second, ui: { notify() {} } });
      return { cancelled: false };
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(customCalls, 2);
    assert.equal(switchedCwd, second, JSON.stringify(context.notifications));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("switch refuses path reuse when the selected worktree identity changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-switch-race-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  mkdirSync(linked);
  const mock = createMockPi();
  let listCalls = 0;
  let switchCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") {
      listCalls += 1;
      return result(
        porcelain([
          { path: main, branch: "main" },
          listCalls === 1
            ? { path: linked, branch: "feature" }
            : { path: linked, branch: "replacement", head: oid.replace(/^0/, "1") },
        ]),
      );
    }
    return result(`${main}\n`);
  };
  worktreeExtension(mock.pi);
  let selectCount = 0;
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async (_title: string, items: string[]) => (selectCount++ === 0 ? "Switch worktree" : items[0]),
    switchSession: async () => {
      switchCalls += 1;
      return { cancelled: false };
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(switchCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /changed identity/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune refuses an unreachable prunable detached HEAD before preview", async () => {
  const mock = createMockPi();
  let previewCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(
        porcelain([
          { path: "/repo", branch: "main" },
          { path: "/missing", detached: true, prunableReason: "missing gitdir" },
        ]),
      );
    }
    if (args[0] === "rev-parse") return result("/repo\n");
    if (args[0] === "for-each-ref") return result("");
    if (args.includes("--dry-run")) previewCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  const context = createMockContext({
    cwd: "/repo",
    hasUI: true,
    mode: "tui",
    select: async () => "Prune stale metadata",
  });
  await mock.commands.get("worktree")?.handler("", context.ctx);
  assert.equal(previewCalls, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /not reachable/i);
});

test("prune refuses staged-only administrative index state omitted from porcelain", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-staged-command-"));
  const main = join(root, "repo");
  const admin = join(main, ".git", "worktrees", "hidden");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/feature\n");
  const mock = createMockPi();
  let actualPruneCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return result(`${main}\n`);
    }
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      return result(".git\n");
    }
    if (args[0]?.startsWith("--git-dir=") && args[1] === "diff") return result("", 1);
    if (args.includes("--dry-run")) return result("Removing worktrees/hidden: missing gitdir\n");
    if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Prune stale metadata",
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(actualPruneCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /staged-only index changes/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune refuses stale attached metadata whose branch ref is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-missing-ref-command-"));
  const main = join(root, "repo");
  const admin = join(main, ".git", "worktrees", "hidden");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/missing\n");
  const mock = createMockPi();
  let actualPruneCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return result(`${main}\n`);
    }
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      return result(".git\n");
    }
    if (args[0]?.startsWith("--git-dir=") && args[1] === "diff") return result();
    if (args[0] === "show-ref") return result("", 1);
    if (args.includes("--dry-run")) return result("Removing worktrees/hidden: missing gitdir\n");
    if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Prune stale metadata",
    confirm: async () => true,
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(actualPruneCalls, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /does not resolve.*durable ref/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune explicitly confirms and discards reflog-only recovery history", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-prune-history-"));
  const main = join(root, "repo");
  const admin = join(main, ".git", "worktrees", "hidden");
  mkdirSync(join(admin, "logs"), { recursive: true });
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/feature\n");
  const orphan = oid.replace(/^0/, "1");
  writeFileSync(
    join(admin, "logs", "HEAD"),
    `${"0".repeat(40)} ${orphan} Test <test@example.invalid> 0 +0000\tcommit\n${orphan} ${oid} Test <test@example.invalid> 1 +0000\tcheckout\n`,
  );
  const mock = createMockPi();
  let actualPruneCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return result(`${main}\n`);
    }
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      return result(".git\n");
    }
    if (args[0]?.startsWith("--git-dir=") && args[1] === "diff") return result();
    if (args.includes("for-each-ref")) return result();
    if (args.includes("--dry-run")) return result("Removing worktrees/hidden: missing gitdir\n");
    if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  let confirmation = "";
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Prune stale metadata",
    confirm: async (_title: string, message: string) => {
      confirmation = message;
      return true;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(actualPruneCalls, 1);
    assert.match(confirmation, new RegExp(orphan));
    assert.match(confirmation, /recovery pointers.*garbage-collected/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune refuses metadata that changes during recovery-history revalidation", async () => {
  const mock = createMockPi();
  let dryRuns = 0;
  let historyScans = 0;
  let actualPruneCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: "/repo", branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      historyScans += 1;
      return result("/repo/.git\n");
    }
    if (args[0] === "rev-parse") return result("/repo\n");
    if (args.includes("--dry-run")) {
      dryRuns += 1;
      return result(
        historyScans < 2 ? "Removing worktrees/first: missing gitdir\n" : "Removing worktrees/second: missing gitdir\n",
      );
    }
    if (args[0] === "worktree" && args[1] === "prune") actualPruneCalls += 1;
    return result();
  };
  worktreeExtension(mock.pi);
  const context = createMockContext({
    cwd: "/repo",
    hasUI: true,
    mode: "tui",
    select: async () => "Prune stale metadata",
    confirm: async () => true,
  });
  await mock.commands.get("worktree")?.handler("", context.ctx);
  assert.equal(dryRuns, 2);
  assert.equal(actualPruneCalls, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /metadata changed/i);
});

test("prune always previews and cancellation prevents mutation", async () => {
  for (const confirm of [false, true]) {
    const mock = createMockPi();
    const calls: string[][] = [];
    (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return result(porcelain([{ path: "/repo", branch: "main" }]));
      }
      if (args[0] === "rev-parse") return result("/repo\n");
      if (args[0] === "worktree" && args.includes("--dry-run")) {
        return result("Removing worktrees/stale: gitdir file points to non-existent location\n");
      }
      if (args[0] === "worktree" && args[1] === "prune") return result("Pruned\n");
      return result();
    };
    worktreeExtension(mock.pi);
    const context = createMockContext({
      cwd: "/repo",
      hasUI: true,
      mode: "tui",
      select: async () => "Prune stale metadata",
      confirm: async () => confirm,
    });
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.deepEqual(
      calls.find((args) => args.includes("--dry-run")),
      ["worktree", "prune", "--dry-run", "--verbose"],
    );
    assert.equal(
      calls.filter((args) => args[0] === "worktree" && args[1] === "prune" && !args.includes("--dry-run")).length,
      confirm ? 1 : 0,
    );
  }
});

// Structural type used only to make mock assignment concise.
type ExecFunction = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;
