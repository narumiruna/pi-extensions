import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import worktreeExtension from "../src/worktree.js";
import { type ExecFunction, oid, porcelain, result } from "./command-test-support.js";

test("worktree status loads on demand and renders width-safe TUI cards with details", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-status-menu-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  mkdirSync(linked);
  const mock = createMockPi();
  let statusCalls = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args, options) => {
    if (args[0] === "worktree") {
      return result(
        porcelain([
          { path: main, branch: "main" },
          { path: linked, branch: "feature" },
        ]),
      );
    }
    if (args[0] === "rev-parse") return result(`${main}\n`);
    if (args[0] === "status") {
      statusCalls += 1;
      return result(
        [
          `# branch.oid ${oid}`,
          `# branch.head ${options?.cwd === main ? "main" : "feature"}`,
          ...(options?.cwd === main ? ["# branch.upstream origin/main", "# branch.ab +2 -1"] : ["? draft.txt"]),
          "",
        ].join("\0"),
      );
    }
    if (args[0] === "show") return result("2026-08-10T01:02:03+00:00\0Initial commit\n");
    return result();
  };
  worktreeExtension(mock.pi);
  let initialRender = "";
  let narrowLines: string[] = [];
  let listRender = "";
  let detailRender = "";
  let statusCallsBeforeSelection = -1;
  let openedStatus = false;
  const allRenders: string[] = [];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 120, undefined, 18);
      const rendered = harness.render().join("\n");
      allRenders.push(rendered);
      if (rendered.includes("Inspecting worktrees")) return harness.resultPromise;
      if (!openedStatus) {
        initialRender = rendered;
        statusCallsBeforeSelection = statusCalls;
        harness.handleInput(initialRender.includes("Worktree status") ? "tui.select.confirm" : "\u0003");
        openedStatus = initialRender.includes("Worktree status");
        return harness.result;
      }
      if (rendered.includes("Local Git snapshot")) {
        narrowLines = harness.render(42);
        listRender = harness.render(120).join("\n");
        harness.handleInput("tui.select.confirm");
        detailRender = harness.render(120).join("\n");
        harness.handleInput("tui.select.cancel");
        harness.handleInput("tui.select.cancel");
        return harness.result;
      }
      harness.handleInput("\u0003");
      return harness.result;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.match(initialRender, /Worktree status/);
    assert.equal(statusCallsBeforeSelection, 0);
    assert.equal(statusCalls, 2);
    assert.ok(
      narrowLines.every((line) => visibleWidth(line) <= 42),
      JSON.stringify(narrowLines),
    );
    assert.match(allRenders.join("\n---\n"), /Local Git snapshot/, JSON.stringify(context.notifications));
    assert.match(listRender, /main.*current.*main.*clean/i);
    assert.match(detailRender, /Upstream: origin\/main.*ahead 2.*behind 1/i);
    assert.match(detailRender, new RegExp(oid));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree status keeps successful cards when one worktree probe fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-status-partial-"));
  const main = join(root, "repo");
  const linked = join(root, "repo-feature");
  mkdirSync(main);
  mkdirSync(linked);
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args, options) => {
    if (args[0] === "worktree") {
      return result(
        porcelain([
          { path: main, branch: "main" },
          { path: linked, branch: "feature" },
        ]),
      );
    }
    if (args[0] === "rev-parse") return result(`${main}\n`);
    if (args[0] === "status" && options?.cwd === linked) {
      return result("", 1, "feature status failed");
    }
    if (args[0] === "status") {
      return result([`# branch.oid ${oid}`, "# branch.head main", ""].join("\0"));
    }
    if (args[0] === "show") return result("2026-08-10T01:02:03+00:00\0Initial commit\n");
    return result();
  };
  worktreeExtension(mock.pi);
  let browseRender = "";
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 100);
      const rendered = harness.render().join("\n");
      if (rendered.includes("Inspecting worktrees")) return harness.resultPromise;
      if (rendered.includes("Worktree status") && !rendered.includes("Local Git snapshot")) {
        harness.handleInput("tui.select.confirm");
        return harness.result;
      }
      if (rendered.includes("Local Git snapshot")) browseRender = rendered;
      harness.handleInput("\u0003");
      return harness.result;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.match(browseRender, /main.*clean/i);
    assert.match(browseRender, /feature.*unavailable/i);
    assert.deepEqual(context.notifications, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree status exposes deterministic read-only details in RPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-status-rpc-"));
  const main = join(root, "repo");
  mkdirSync(main);
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") return result(porcelain([{ path: main, branch: "main" }]));
    if (args[0] === "rev-parse") return result(`${main}\n`);
    if (args[0] === "status") {
      return result([`# branch.oid ${oid}`, "# branch.head main", ""].join("\0"));
    }
    if (args[0] === "show") return result("2026-08-10T01:02:03+00:00\0Initial commit\n");
    return result();
  };
  worktreeExtension(mock.pi);
  let call = 0;
  const dialogs: Array<{ title: string; choices: string[] }> = [];
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "rpc",
    select: async (title: string, choices: string[]) => {
      call += 1;
      dialogs.push({ title, choices });
      if (call === 1) return choices.find((choice) => choice.includes("Worktree status"));
      if (call === 2) return choices.find((choice) => choice.includes("main"));
      if (call === 3) return choices.find((choice) => choice.startsWith("Back"));
      if (call === 4) return choices.find((choice) => choice.startsWith("Back"));
      return undefined;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(call, 5);
    assert.match(dialogs.map((dialog) => dialog.title).join("\n"), /Working tree: clean/i);
    assert.match(dialogs.map((dialog) => dialog.title).join("\n"), /no fetch performed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session replacement aborts status loading without publishing stale UI", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-status-replace-"));
  const main = join(root, "repo");
  mkdirSync(main);
  const mock = createMockPi();
  let statusStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    statusStarted = resolve;
  });
  let statusAborted = false;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args, options) => {
    if (args[0] === "worktree") return result(porcelain([{ path: main, branch: "main" }]));
    if (args[0] === "rev-parse") return result(`${main}\n`);
    if (args[0] === "status") {
      statusStarted();
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            statusAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { ...result(), killed: true };
    }
    return result();
  };
  worktreeExtension(mock.pi);
  const sessionStart = mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);
  const replacement = createMockContext({ cwd: main, hasUI: true, mode: "tui" });
  let sawStatusAction = false;
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 100);
      const rendered = harness.render().join("\n");
      if (rendered.includes("Inspecting worktrees")) return harness.resultPromise;
      sawStatusAction = rendered.includes("Worktree status");
      harness.handleInput(sawStatusAction ? "tui.select.confirm" : "\u0003");
      return harness.result;
    },
  });
  try {
    const pending = mock.commands.get("worktree")?.handler("", context.ctx);
    await started;
    await sessionStart({}, replacement.ctx);
    await pending;
    assert.equal(sawStatusAction, true);
    assert.equal(statusAborted, true);
    assert.deepEqual(context.notifications, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
