import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStarshipCommand } from "../src/commands.js";
import { BUILT_IN_EXAMPLE, loadStarshipConfig, settingsFilePath } from "../src/config.js";
import piStarshipRuntime from "../src/pi-starship.js";

initTheme("dark", false);

async function driveTuiCustom(factory: unknown, inputs: readonly string[], width: number) {
  const tui = createTuiHarness({ width, rows: 24 });
  const running = (tui.custom as unknown as (customFactory: unknown) => Promise<unknown>)(factory);
  await tui.waitForOpen();
  const renders = [Array.from(tui.render())];
  for (const input of inputs) renders.push(Array.from(tui.send(input)));
  return { renders, result: await running };
}

function piStarship(pi: Parameters<typeof piStarshipRuntime>[0]) {
  return piStarshipRuntime(pi, {
    githubPrExec: (command, args, options) =>
      pi.exec(command, args, {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout,
      }),
  });
}

test("/starship keeps direct routes and opens a stateful narrow TUI menu", async () => {
  const mock = createMockPi();
  const fallback = loadStarshipConfig("/tmp/missing-pi-starship-main-menu.toml");
  const loaded = { ...fallback, source: "user" as const, rawDocument: BUILT_IN_EXAMPLE };
  registerStarshipCommand(mock.pi, {
    getLoaded: () => loaded,
    apply() {},
    settingsPath: "/tmp/missing-pi-starship-main-menu.toml",
  });
  const command = mock.commands.get("starship");
  assert.ok(command);
  assert.ok(command.getArgumentCompletions);
  assert.deepEqual(
    (command.getArgumentCompletions("") as Array<{ value: string }>).map((item) => item.value),
    ["settings", "status", "help"],
  );
  assert.deepEqual(
    (command.getArgumentCompletions("st") as Array<{ value: string }>).map((item) => item.value),
    ["status"],
  );

  const renders: string[][] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const driven = await driveTuiCustom(factory, ["\u001b"], 28);
      renders.push(...driven.renders);
      return driven.result;
    },
  });
  await command.handler("", context.ctx);
  const screen = renders.flat().join("\n");
  assert.match(screen, /pi-starship/u);
  assert.match(screen, /Saved built-in configuration/u);
  assert.match(screen, /Healthy/u);
  assert.match(screen, /Customize footer/u);
  assert.match(screen, /Presets/u);
  assert.match(screen, /Configuration/u);
  assert.match(screen, /Help/u);
  assert.match(screen, /Restore built-in…/u);
  assert.doesNotMatch(screen, /Advanced/u);
  assert.ok(renders.flat().every((line) => visibleWidth(line) <= 28));
});

test("Explain consumes the current snapshot without starting collection work", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-explain-snapshot-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    let execCalls = 0;
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => {
      execCalls += 1;
      return gitResult();
    };
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 60, rows: 18 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    await emit(mock.events, "session_start", {}, context.ctx);
    const footer = (context.footer as FooterFactory)(
      { requestRender() {} },
      {},
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => undefined,
      },
    );
    footer.render(60);
    await flushAsyncWork();
    const callsBeforeExplain = execCalls;

    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Explain footer/u);
    await flushAsyncWork();
    assert.equal(execCalls, callsBeforeExplain);
    assert.equal(existsSync(settingsFilePath(root)), false);
    tui.press("ctrl+c");
    await running;
    footer.dispose();
    await emit(mock.events, "session_shutdown", {}, context.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings opens the raw TOML in TUI, saves atomically, and applies immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    let initial = "";
    let preview = "";
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async (_title: string, value: string) => {
        initial = value;
        return "format = 'saved'\n";
      },
      custom: async (factory: unknown) => {
        const driven = await driveTuiCustom(factory, ["\r"], 40);
        preview = driven.renders.flat().join("\n");
        return driven.result;
      },
      confirm: async () => true,
    });
    await emit(mock.events, "session_start", {}, context.ctx);
    const footer = (context.footer as FooterFactory)(
      { requestRender() {} },
      {},
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => undefined,
      },
    );
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(initial, BUILT_IN_EXAMPLE);
    assert.match(preview, /preview/iu);
    assert.match(preview, /saved/u);
    assert.match(preview, /Apply changes…/u);
    assert.equal(readFileSync(settingsFilePath(root), "utf8"), "format = 'saved'\n");
    assert.match(context.notifications.at(-1)?.message ?? "", /saved/i);

    assert.deepEqual(footer.render(80), ["saved"]);
    footer.dispose();
    await emit(mock.events, "session_shutdown", {}, context.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview failure remains explicit and offers edit or discard recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preview-failure-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    let preview = "";
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
      renderPreview() {
        throw new Error("renderer unavailable");
      },
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'draft'\n",
      custom: async (factory: unknown) => {
        const driven = await driveTuiCustom(factory, ["\u001b"], 60);
        preview = driven.renders.flat().join("\n");
        return driven.result;
      },
    });
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.match(preview, /Preview unavailable: renderer unavailable/u);
    assert.match(preview, /Draft validation: Healthy/u);
    assert.match(preview, /Apply changes…/u);
    assert.match(preview, /Continue editing/u);
    assert.match(preview, /Discard draft/u);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("warning drafts remain applicable and report their warning count", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-warning-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
      },
      settingsPath: path,
      renderPreview: () => ["warning preview"],
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'warning'\nfuture = true\n",
      custom: async (factory: unknown) => (await driveTuiCustom(factory, ["\r"], 40)).result,
      confirm: async () => true,
    });
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(readFileSync(path, "utf8"), "format = 'warning'\nfuture = true\n");
    assert.match(context.notifications.at(-1)?.message ?? "", /1 warning/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid and cancelled edits keep the old file and effective config", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "format = 'old'\n");
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let applied = 0;
    let nextEdit: string | undefined = "format = [";
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
        applied += 1;
      },
      settingsPath: path,
    });
    let invalidReview = "";
    const context = createMockContext({
      mode: "tui",
      editor: async () => nextEdit,
      custom: async (factory: unknown) => {
        const driven = await driveTuiCustom(factory, ["\u001b"], 40);
        invalidReview = driven.renders.flat().join("\n");
        return driven.result;
      },
    });
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(readFileSync(path, "utf8"), "format = 'old'\n");
    assert.equal(loaded.config.format, "old");
    assert.equal(applied, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /parse/i);
    assert.match(invalidReview, /Continue editing/u);
    assert.match(invalidReview, /Discard draft/u);
    assert.match(invalidReview, /current footer has not changed/iu);

    nextEdit = undefined;
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(applied, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save failures retain current state and report the error", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "format = 'old'\n");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    let applied = false;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {
        applied = true;
      },
      settingsPath: path,
      save() {
        throw new Error("disk full");
      },
    });
    let previewCalls = 0;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'new'\n",
      custom: async (factory: unknown) => {
        const inputs = previewCalls++ === 0 ? ["\r"] : ["\u001b"];
        return (await driveTuiCustom(factory, inputs, 40)).result;
      },
      confirm: async () => true,
    });
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(previewCalls, 2);
    assert.equal(applied, false);
    assert.equal(readFileSync(path, "utf8"), "format = 'old'\n");
    assert.match(context.notifications.at(-1)?.message ?? "", /disk full/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime apply failures restore the previous file and effective configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "format = 'old'\n");
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let previewCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        if (next.config.format === "new") throw new Error("renderer rejected config");
        loaded = next;
      },
      settingsPath: path,
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'new'\n",
      custom: async (factory: unknown) => {
        const inputs = previewCalls++ === 0 ? ["\r"] : ["\u001b"];
        return (await driveTuiCustom(factory, inputs, 36)).result;
      },
      confirm: async () => true,
    });
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(readFileSync(path, "utf8"), "format = 'old'\n");
    assert.equal(loaded.config.format, "old");
    assert.match(context.notifications.at(-1)?.message ?? "", /previous.*restored/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed first runtime apply restores the missing Starship settings file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-first-save-"));
  const path = settingsFilePath(root);
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let previewCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        if (next.source === "user") throw new Error("renderer rejected config");
        loaded = next;
      },
      settingsPath: path,
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'new'\n",
      custom: async (factory: unknown) => {
        const inputs = previewCalls++ === 0 ? ["\r"] : ["\u001b"];
        return (await driveTuiCustom(factory, inputs, 36)).result;
      },
      confirm: async () => true,
    });

    assert.equal(existsSync(path), false);
    await mock.commands.get("starship")?.handler("settings", context.ctx);

    assert.equal(existsSync(path), false);
    assert.equal(loaded.source, "built-in");
    assert.match(context.notifications.at(-1)?.message ?? "", /previous.*restored/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed first runtime apply preserves settings replaced concurrently", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-first-save-race-"));
  const path = settingsFilePath(root);
  const concurrent = "format = 'concurrent'\n";
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let previewCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        if (next.source === "user") {
          writeFileSync(path, concurrent);
          throw new Error("renderer rejected config");
        }
        loaded = next;
      },
      settingsPath: path,
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'new'\n",
      custom: async (factory: unknown) => {
        const inputs = previewCalls++ === 0 ? ["\r"] : ["\u001b"];
        return (await driveTuiCustom(factory, inputs, 36)).result;
      },
      confirm: async () => true,
    });

    await mock.commands.get("starship")?.handler("settings", context.ctx);

    assert.equal(readFileSync(path, "utf8"), concurrent);
    assert.match(context.notifications.at(-1)?.message ?? "", /rollback failed|restoring.*also failed/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed Starship update preserves existing settings replaced before rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-update-race-"));
  const path = settingsFilePath(root);
  const original = "format = 'original'\n";
  const concurrent = "format = 'concurrent'\n";
  writeFileSync(path, original);
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    let previewCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        if (next.rawDocument !== original) {
          writeFileSync(path, concurrent);
          throw new Error("renderer rejected config");
        }
      },
      settingsPath: path,
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'new'\n",
      custom: async (factory: unknown) => {
        const inputs = previewCalls++ === 0 ? ["\r"] : ["\u001b"];
        return (await driveTuiCustom(factory, inputs, 36)).result;
      },
      confirm: async () => true,
    });

    await mock.commands.get("starship")?.handler("settings", context.ctx);

    assert.equal(readFileSync(path, "utf8"), concurrent);
    assert.match(context.notifications.at(-1)?.message ?? "", /restoring.*failed.*newer file was preserved/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-TUI settings never opens an editor and status/help are protocol-safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(settingsFilePath(root));
    let editorCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: settingsFilePath(root),
    });
    const rpc = createMockContext({
      mode: "rpc",
      hasUI: true,
      editor: async () => {
        editorCalls += 1;
        return undefined;
      },
    });
    await mock.commands.get("starship")?.handler("settings", rpc.ctx);
    assert.equal(editorCalls, 0);
    assert.match(rpc.notifications.at(-1)?.message ?? "", /pi-starship\.toml/);
    await mock.commands.get("starship")?.handler("", rpc.ctx);
    assert.match(rpc.notifications.at(-1)?.message ?? "", /explain.*inspect.*TUI mode/iu);

    const print = createMockContext({ mode: "print", hasUI: false });
    await mock.commands.get("starship")?.handler("status", print.ctx);
    await mock.commands.get("starship")?.handler("help", print.ctx);
    assert.deepEqual(print.notifications, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct routes reject unknown and trailing arguments in UI-capable modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-routes-"));
  const path = settingsFilePath(root);
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    let editorCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
    });
    for (const mode of ["tui", "rpc"] as const) {
      const context = createMockContext({
        mode,
        hasUI: true,
        editor: async () => {
          editorCalls += 1;
          return undefined;
        },
      });
      for (const args of ["settings extra", "status typo", "help now", "unknown"]) {
        await mock.commands.get("starship")?.handler(args, context.ctx);
        assert.match(
          context.notifications.at(-1)?.message ?? "",
          /Usage: \/starship \[settings\|status\|help\]/u,
          `${mode}: ${args}`,
        );
      }
    }
    assert.equal(editorCalls, 0);

    for (const mode of ["print", "json"] as const) {
      const context = createMockContext({ mode, hasUI: false });
      await mock.commands.get("starship")?.handler("status typo", context.ctx);
      assert.deepEqual(context.notifications, []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview and confirmation cancellation preserve the previous document and runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "format = 'old'\nfuture = 'preserved'\n");
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let applied = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
        applied += 1;
      },
      settingsPath: path,
    });

    let customCalls = 0;
    let confirmations = 0;
    const previewCancel = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'new'\nfuture = 'preserved'\n",
      custom: async (factory: unknown) => {
        customCalls += 1;
        return (await driveTuiCustom(factory, ["\u001b"], 30)).result;
      },
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    await mock.commands.get("starship")?.handler("settings", previewCancel.ctx);
    assert.equal(customCalls, 1);
    assert.equal(confirmations, 0);
    assert.equal(applied, 0);
    assert.equal(readFileSync(path, "utf8"), "format = 'old'\nfuture = 'preserved'\n");

    customCalls = 0;
    const confirmationCancel = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => "format = 'new'\nfuture = 'preserved'\n",
      custom: async (factory: unknown) => {
        const inputs = customCalls++ === 0 ? ["\r"] : ["\u001b"];
        return (await driveTuiCustom(factory, inputs, 30)).result;
      },
      confirm: async () => false,
    });
    await mock.commands.get("starship")?.handler("settings", confirmationCancel.ctx);
    assert.equal(customCalls, 2);
    assert.equal(applied, 0);
    assert.equal(readFileSync(path, "utf8"), "format = 'old'\nfuture = 'preserved'\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main and Configuration menus expose current state and a clear Back path", async () => {
  const mock = createMockPi();
  const loaded = loadStarshipConfig("/tmp/missing-pi-starship-menu.toml");
  registerStarshipCommand(mock.pi, {
    getLoaded: () => loaded,
    apply() {},
    settingsPath: "/tmp/missing-pi-starship-menu.toml",
  });
  let call = 0;
  const screens: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const inputs =
        call === 0 ? ["\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\r"] : call === 1 ? ["\r"] : ["\u001b"];
      const driven = await driveTuiCustom(factory, inputs, 26);
      screens[call++] = driven.renders.flat().join("\n");
      assert.ok(driven.renders.flat().every((line) => visibleWidth(line) <= 26));
      return driven.result;
    },
  });
  await mock.commands.get("starship")?.handler("", context.ctx);
  assert.equal(call, 5);
  assert.match(screens[1] ?? "", /Configuration/u);
  assert.match(screens[2] ?? "", /State: Built-in defaults/u);
  assert.match(screens[2] ?? "", /Source: No settings file/u);
  assert.match(screens[4] ?? "", /Customize footer/u);
});

test("Restore previews, confirms, and atomically applies the built-in footer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "format = 'custom'\nfuture = true\n");
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let applied = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
        applied += 1;
      },
      settingsPath: path,
      renderPreview: (draft, width) => [draft.config.format.slice(0, width)],
    });
    let call = 0;
    let restorePreview = "";
    let confirmation = "";
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const inputs =
          call === 0 ? ["\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\r"] : ["\r"];
        const driven = await driveTuiCustom(factory, inputs, 32);
        if (call === 1) restorePreview = driven.renders.flat().join("\n");
        call += 1;
        return driven.result;
      },
      confirm: async (_title: string, message: string) => {
        confirmation = message;
        return true;
      },
    });
    await mock.commands.get("starship")?.handler("", context.ctx);
    assert.match(restorePreview, /Restore preview/u);
    assert.match(restorePreview, /Current: Custom configuration/u);
    assert.match(restorePreview, /entire settings document/iu);
    assert.match(restorePreview, /unknown fields/iu);
    assert.match(restorePreview, /No backup/iu);
    assert.match(restorePreview, /\$brand\$model/u);
    assert.match(confirmation, /All custom settings, unknown fields, and comments will be removed/u);
    assert.match(confirmation, /No backup is kept after success/u);
    assert.doesNotMatch(restorePreview, /░▒▓|/u);
    assert.equal(applied, 1);
    assert.equal(readFileSync(path, "utf8"), BUILT_IN_EXAMPLE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Restore recovers a malformed settings document", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-malformed-restore-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "format = [\n");
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let applied = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
        applied += 1;
      },
      settingsPath: path,
      renderPreview: (draft) => [draft.config.format],
    });
    let call = 0;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const inputs =
          call++ === 0 ? ["\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\r"] : ["\r"];
        return (await driveTuiCustom(factory, inputs, 60)).result;
      },
      confirm: async () => true,
    });
    await mock.commands.get("starship")?.handler("", context.ctx);
    assert.equal(applied, 1);
    assert.equal(readFileSync(path, "utf8"), BUILT_IN_EXAMPLE);
    assert.equal(loaded.source, "user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid drafts can return to editing before preview and atomic apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "format = 'old'\nfuture = 'preserved'\n");
  try {
    const mock = createMockPi();
    let loaded = loadStarshipConfig(path);
    let editorCalls = 0;
    let menuCalls = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply(next) {
        loaded = next;
      },
      settingsPath: path,
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => {
        editorCalls += 1;
        return editorCalls === 1 ? "format = [" : "format = 'new'\nfuture = 'preserved'\n";
      },
      custom: async (factory: unknown) => {
        assert.equal(readFileSync(path, "utf8"), "format = 'old'\nfuture = 'preserved'\n");
        menuCalls += 1;
        return (await driveTuiCustom(factory, ["\r"], 34)).result;
      },
      confirm: async () => true,
    });
    await mock.commands.get("starship")?.handler("settings", context.ctx);
    assert.equal(editorCalls, 2);
    assert.equal(menuCalls, 2);
    assert.equal(readFileSync(path, "utf8"), "format = 'new'\nfuture = 'preserved'\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Configuration and Help stay shallow and fit narrow terminals", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "future = true\n");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
    });
    const choices = ["Configuration", "Overview", undefined, undefined, "Help", undefined, undefined];
    const screens: string[] = [];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async (title: string) => {
        screens.push(title);
        return choices.shift();
      },
    });
    await mock.commands.get("starship")?.handler("", context.ctx);
    assert.equal(screens.length, 7);
    assert.match(screens.join("\n"), /1 warning/u);
    assert.match(screens.join("\n"), /Configuration/u);
    assert.match(screens.join("\n"), /pi-starship help/u);
    assert.match(screens.join("\n"), /Path:/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore preview cancellation preserves exact settings and runtime in a narrow terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-restore-cancel-"));
  const path = settingsFilePath(root);
  const original = "format = 'custom'\nfuture = true\n";
  writeFileSync(path, original);
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    let applied = 0;
    let confirmations = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {
        applied += 1;
      },
      settingsPath: path,
      renderPreview: (draft) => [draft.config.format],
    });
    const tui = createTuiHarness({ width: 20, rows: 8 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    for (let index = 0; index < 6; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const preview = tui.render();
    assert.ok(preview.length <= 5);
    assert.ok(preview.every((line) => visibleWidth(line) <= 20));
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.equal(confirmations, 0);
    assert.equal(applied, 0);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(loaded.config.format, "custom");
    tui.press("ctrl+c");
    await running;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status reports source/path/warnings and help reports manual configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-"));
  const path = settingsFilePath(root);
  writeFileSync(path, "future = true\n");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
    });
    const context = createMockContext({ mode: "tui", hasUI: true });
    await mock.commands.get("starship")?.handler("status", context.ctx);
    const status = context.notifications.at(-1)?.message ?? "";
    assert.match(status, /source: user/i);
    assert.match(status, /pi-starship\.toml/i);
    assert.match(status, /future/i);
    await mock.commands.get("starship")?.handler("help", context.ctx);
    assert.match(context.notifications.at(-1)?.message ?? "", /settings.*status.*help/is);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function emit(
  events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
  name: string,
  ...args: unknown[]
) {
  for (const handler of events.get(name) ?? []) await handler(...args);
}

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
function gitResult(): ExecResult {
  return { stdout: "## main\n", stderr: "", code: 0, killed: false };
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type FooterFactory = (
  tui: { requestRender(): void },
  theme: unknown,
  data: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    onBranchChange(callback: () => void): () => void;
  },
) => { render(width: number): string[]; dispose(): void };
