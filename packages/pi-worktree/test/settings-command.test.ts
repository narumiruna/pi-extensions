import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createWorktreeSettingsRuntime } from "../src/settings.js";
import worktreeExtension from "../src/worktree.js";
import { type ExecFunction, oid, porcelain, result } from "./command-test-support.js";

test("interactive root configuration saves, applies to the next Add, and resets without subcommands", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-configure-"));
  const main = join(root, "repo");
  const settingsPath = join(root, "agent", "pi-worktree.json");
  mkdirSync(main);
  const settings = createWorktreeSettingsRuntime({
    path: settingsPath,
    home: "/home/alice",
    platform: "linux",
  });
  const mock = createMockPi();
  let mutations = 0;
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree" && args[1] === "add") mutations += 1;
    if (args[0] === "worktree" && args[1] === "list") {
      return result(porcelain([{ path: main, branch: "main" }]));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(`${main}\n`);
    if (args[0] === "check-ref-format") return result("feat/login\n");
    if (args[0] === "show-ref") return result("", 1);
    if (args[0] === "symbolic-ref") return result("main\n");
    if (args[0] === "rev-parse" && args[1] === "--verify") return result(`${oid}\n`);
    return result();
  };
  worktreeExtension(mock.pi, { settings });

  try {
    const configure = createMockContext({
      cwd: main,
      hasUI: true,
      mode: "tui",
      select: async () => "Configure worktree root",
      input: async () => "/srv/worktrees",
    });
    await mock.commands.get("worktree")?.handler("", configure.ctx);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      worktreeRoot: "/srv/worktrees",
    });
    assert.equal(settings.get().effectiveRoot, "/srv/worktrees");

    const inputs = ["feat/login", "", undefined];
    const menuTitles: string[] = [];
    const pathPlaceholders: string[] = [];
    const add = createMockContext({
      cwd: main,
      hasUI: true,
      mode: "tui",
      select: async (title: string) => {
        menuTitles.push(title);
        return "Add worktree";
      },
      input: async (title: string, placeholder: string) => {
        if (title.startsWith("Worktree path")) pathPlaceholders.push(placeholder);
        return inputs.shift();
      },
    });
    await mock.commands.get("worktree")?.handler("", add.ctx);
    assert.match(menuTitles[0] ?? "", /Worktree root: \/srv\/worktrees \(user\)/);
    assert.deepEqual(pathPlaceholders, ["/srv/worktrees/repo/feat-login"]);
    assert.equal(mutations, 0);

    const reset = createMockContext({
      cwd: main,
      hasUI: true,
      mode: "tui",
      select: async () => "Configure worktree root",
      input: async () => "   ",
    });
    await mock.commands.get("worktree")?.handler("", reset.ctx);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {});
    assert.equal(settings.get().effectiveRoot, "/home/alice/.worktrees");
    assert.equal(settings.get().source, "default");

    const defaultInputs = ["feat/login", "", undefined];
    let defaultPlaceholder = "";
    const addWithDefault = createMockContext({
      cwd: main,
      hasUI: true,
      mode: "tui",
      select: async () => "Add worktree",
      input: async (title: string, placeholder: string) => {
        if (title.startsWith("Worktree path")) defaultPlaceholder = placeholder;
        return defaultInputs.shift();
      },
    });
    await mock.commands.get("worktree")?.handler("", addWithDefault.ctx);
    assert.equal(defaultPlaceholder, "/home/alice/.worktrees/repo/feat-login");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive root configuration cancels cleanly and never overwrites invalid settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-configure-invalid-"));
  const main = join(root, "repo");
  const settingsPath = join(root, "pi-worktree.json");
  mkdirSync(main);
  const settings = createWorktreeSettingsRuntime({
    path: settingsPath,
    home: "/home/alice",
    platform: "linux",
  });
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") return result(porcelain([{ path: main, branch: "main" }]));
    return result(`${main}\n`);
  };
  worktreeExtension(mock.pi, { settings });
  let inputs = 0;
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Configure worktree root",
    input: async () => {
      inputs += 1;
      return undefined;
    },
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(inputs, 1);
    assert.equal(settings.get().source, "default");

    writeFileSync(settingsPath, "{broken\n");
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(inputs, 1);
    assert.equal(readFileSync(settingsPath, "utf8"), "{broken\n");
    assert.match(context.notifications.at(-1)?.message ?? "", /ignored.*without overwriting/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive root configuration keeps runtime state when atomic publication fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-configure-failure-"));
  const main = join(root, "repo");
  const settingsPath = join(root, "agent", "pi-worktree.json");
  mkdirSync(main);
  const settings = createWorktreeSettingsRuntime({
    path: settingsPath,
    home: "/home/alice",
    platform: "linux",
    operations: {
      rename: async () => {
        throw new Error("publish failed");
      },
    },
  });
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (_command, args) => {
    if (args[0] === "worktree") return result(porcelain([{ path: main, branch: "main" }]));
    return result(`${main}\n`);
  };
  worktreeExtension(mock.pi, { settings });
  const context = createMockContext({
    cwd: main,
    hasUI: true,
    mode: "tui",
    select: async () => "Configure worktree root",
    input: async () => "/srv/worktrees",
  });
  try {
    await mock.commands.get("worktree")?.handler("", context.ctx);
    assert.equal(settings.get().effectiveRoot, "/home/alice/.worktrees");
    assert.equal(settings.get().source, "default");
    assert.match(context.notifications.at(-1)?.message ?? "", /publish failed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
