import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import piStarshipRuntime from "../src/pi-starship.js";

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

test("session replacement disposes an open settings preview before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-stale-preview-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const oldContext = createMockContext({
      mode: "tui",
      custom: tui.custom,
      editor: async () => "format = 'draft'\n",
    });
    const newContext = createMockContext({ mode: "tui", cwd: "/work/replacement" });
    await emit(mock.events, "session_start", {}, oldContext.ctx);
    let settled = false;
    const command = Promise.resolve(mock.commands.get("starship")?.handler("settings", oldContext.ctx));
    void command.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    await emit(mock.events, "session_start", {}, newContext.ctx);
    await flushAsync();
    try {
      assert.equal(settled, true);
      assert.equal(tui.isOpen, false);
    } finally {
      if (!settled) tui.dispose();
      await command;
    }
    assert.equal(existsSync(join(root, "pi-starship.toml")), false);
    await emit(mock.events, "session_shutdown", {}, newContext.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session replacement disposes an open module browser before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-stale-modules-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const oldContext = createMockContext({ mode: "tui", custom: tui.custom });
    const newContext = createMockContext({ mode: "tui", cwd: "/work/replacement" });
    await emit(mock.events, "session_start", {}, oldContext.ctx);
    let settled = false;
    const command = Promise.resolve(mock.commands.get("starship")?.handler("", oldContext.ctx));
    void command.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    await emit(mock.events, "session_start", {}, newContext.ctx);
    await flushAsync();
    try {
      assert.equal(settled, true);
      assert.equal(tui.isOpen, false);
    } finally {
      if (!settled) tui.dispose();
      await command;
    }
    assert.equal(existsSync(join(root, "pi-starship.toml")), false);
    await emit(mock.events, "session_shutdown", {}, newContext.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session shutdown disposes an open module browser before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-shutdown-modules-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
    await emit(mock.events, "session_start", {}, context.ctx);
    let settled = false;
    const command = Promise.resolve(mock.commands.get("starship")?.handler("", context.ctx));
    void command.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    await emit(mock.events, "session_shutdown", {}, context.ctx);
    await flushAsync();
    try {
      assert.equal(settled, true);
      assert.equal(tui.isOpen, false);
    } finally {
      if (!settled) tui.dispose();
      await command;
    }
    assert.equal(existsSync(join(root, "pi-starship.toml")), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session shutdown disposes an open settings preview before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-shutdown-preview-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const context = createMockContext({
      mode: "tui",
      custom: tui.custom,
      editor: async () => "format = 'draft'\n",
    });
    await emit(mock.events, "session_start", {}, context.ctx);
    let settled = false;
    const command = Promise.resolve(mock.commands.get("starship")?.handler("settings", context.ctx));
    void command.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    await emit(mock.events, "session_shutdown", {}, context.ctx);
    await flushAsync();
    try {
      assert.equal(settled, true);
      assert.equal(tui.isOpen, false);
    } finally {
      if (!settled) tui.dispose();
      await command;
    }
    assert.equal(existsSync(join(root, "pi-starship.toml")), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("preset cursor preview swaps only the in-memory footer and Back restores it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-live-preset-footer-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
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
    assert.match(footer.render(80).join("\n"), /π/u);

    const command = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.doesNotMatch(footer.render(80).join("\n"), /π/u);
    assert.equal(existsSync(join(root, "pi-starship.toml")), false);

    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(footer.render(80).join("\n"), /π/u);
    tui.press("ctrl+c");
    await command;
    footer.dispose();
    await emit(mock.events, "session_shutdown", {}, context.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session replacement clears an open preset footer preview before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-replace-preset-preview-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const oldContext = createMockContext({ mode: "tui", custom: tui.custom });
    await emit(mock.events, "session_start", {}, oldContext.ctx);
    const oldFooter = (oldContext.footer as FooterFactory)(
      { requestRender() {} },
      {},
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => undefined,
      },
    );
    const command = mock.commands.get("starship")?.handler("", oldContext.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.doesNotMatch(oldFooter.render(80).join("\n"), /π/u);

    const newContext = createMockContext({ mode: "tui", cwd: "/work/replacement" });
    await emit(mock.events, "session_start", {}, newContext.ctx);
    await command;
    assert.match(oldFooter.render(80).join("\n"), /π/u);
    assert.equal(existsSync(join(root, "pi-starship.toml")), false);
    oldFooter.dispose();
    await emit(mock.events, "session_shutdown", {}, newContext.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session shutdown disposes an open preset preview without saving", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-shutdown-preset-preview-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const context = createMockContext({ mode: "tui", custom: tui.custom });
    await emit(mock.events, "session_start", {}, context.ctx);
    let settled = false;
    const command = Promise.resolve(mock.commands.get("starship")?.handler("", context.ctx));
    void command.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Presets · current:/u);
    await emit(mock.events, "session_shutdown", {}, context.ctx);
    await flushAsync();
    try {
      assert.equal(settled, true);
      assert.equal(tui.isOpen, false);
    } finally {
      if (!settled) tui.dispose();
      await command;
    }
    assert.equal(existsSync(join(root, "pi-starship.toml")), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session replacement disposes an open reload preview without applying stale work", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-replace-reload-preview-"));
  const path = join(root, "pi-starship.toml");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(path, "format = '$model'\n");
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const tui = createTuiHarness({ width: 52, rows: 18 });
    const oldContext = createMockContext({ mode: "tui", custom: tui.custom });
    await emit(mock.events, "session_start", {}, oldContext.ctx);
    const external = "format = '$provider'\nfuture = true\n";
    writeFileSync(path, external);
    const command = Promise.resolve(mock.commands.get("starship")?.handler("", oldContext.ctx));
    await tui.waitForOpen();
    for (let index = 0; index < 4; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Reload preview/u);

    const newContext = createMockContext({ mode: "tui", cwd: "/work/replacement" });
    await emit(mock.events, "session_start", {}, newContext.ctx);
    await command;
    assert.equal(tui.isOpen, false);
    assert.equal(readFileSync(path, "utf8"), external);
    assert.doesNotMatch(oldContext.notifications.map((item) => item.message).join("\n"), /reloaded and applied/u);
    await emit(mock.events, "session_shutdown", {}, newContext.ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session shutdown rejects a reload confirmation that resolves after ownership ends", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-shutdown-reload-confirm-"));
  const path = join(root, "pi-starship.toml");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(path, "format = '$model'\n");
  try {
    const mock = createMockPi();
    (mock.rawPi as typeof mock.rawPi & { exec: () => Promise<ExecResult> }).exec = async () => gitResult();
    piStarship(mock.pi);
    const confirmation = deferred<boolean>();
    const confirmationStarted = deferred<void>();
    const tui = createTuiHarness({ width: 52, rows: 18 });
    const context = createMockContext({
      mode: "tui",
      custom: tui.custom,
      confirm: async () => {
        confirmationStarted.resolve();
        return confirmation.promise;
      },
    });
    await emit(mock.events, "session_start", {}, context.ctx);
    const external = "format = '$provider'\n";
    writeFileSync(path, external);
    const command = Promise.resolve(mock.commands.get("starship")?.handler("", context.ctx));
    await tui.waitForOpen();
    for (let index = 0; index < 4; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await confirmationStarted.promise;

    await emit(mock.events, "session_shutdown", {}, context.ctx);
    confirmation.resolve(true);
    await command;
    assert.equal(readFileSync(path, "utf8"), external);
    assert.doesNotMatch(context.notifications.map((item) => item.message).join("\n"), /reloaded and applied/u);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
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

type FooterFactory = (
  tui: { requestRender(): void },
  theme: unknown,
  data: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    onBranchChange(callback: () => void): () => void;
  },
) => { render(width: number): string[]; dispose(): void };

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function gitResult(stdout = "## main\n"): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

async function flushAsync() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
