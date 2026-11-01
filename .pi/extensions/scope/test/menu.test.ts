import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeMenuOptions, ScopeView } from "../menu.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "scope-menu-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
const { showScopeMenu } = await import("../menu.ts");
initTheme("dark", false);
const originalKeys = getKeybindings();
const fixtures: Array<{ dispose(): Promise<void> }> = [];
beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  setKeybindings(originalKeys);
});
afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function setup(active = false) {
  const cwd = await mkdtemp(join(tmpdir(), "scope-menu-"));
  const first = join(cwd, "a.ts");
  const second = join(cwd, "b.ts");
  await writeFile(first, "a");
  await writeFile(second, "b");
  let view: ScopeView = {
    state: active ? "active" : "inactive",
    cwd,
    targets: active ? [{ path: first, canonical: first }] : [],
  };
  const settings = { showHiddenFiles: false };
  const owner = new AbortController();
  const tui = createTuiHarness({ width: 110, rows: 32 });
  const notify = vi.fn();
  const ctx = { mode: "tui", hasUI: true, ui: { custom: tui.custom, notify } } as unknown as ExtensionCommandContext;
  const options: ScopeMenuOptions = {
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
    getView: () => view,
    getSettings: () => ({ ...settings }),
    saveShowHiddenFiles: vi.fn(async (value) => {
      settings.showHiddenFiles = value;
    }),
    apply: vi.fn(async (targets) => {
      view = { state: "active", cwd, targets };
    }),
    off: vi.fn(async () => {
      view = { state: "inactive", cwd, targets: [] };
    }),
  };
  const running = showScopeMenu(ctx, options);
  const result = {
    cwd,
    first,
    second,
    owner,
    tui,
    notify,
    options,
    running,
    settings,
    text: () => stripVTControlCharacters(tui.render().join("\n")),
    async next() {
      const old = tui.resultPromise;
      tui.press("tui.select.confirm");
      await old;
      await tui.waitForOpen();
    },
    async back() {
      const old = tui.resultPromise;
      tui.press("tui.select.cancel");
      await old;
      await tui.waitForOpen();
    },
    down(count: number) {
      for (let index = 0; index < count; index += 1) tui.press("tui.select.down");
    },
    async dispose() {
      owner.abort();
      tui.dispose();
      await running;
      await rm(cwd, { recursive: true, force: true });
    },
  };
  fixtures.push(result);
  await tui.waitForOpen();
  return result;
}

describe("scope current-state manager", () => {
  it("starts on file selection and closes directly after a single explicit apply", async () => {
    const h = await setup();
    const initial = h.text();
    for (const label of ["Select files…", "New file…", "Settings", "Status", "Help", "Close", "Not restricted"])
      expect(initial).toContain(label);
    expect(initial).not.toContain("End restriction");
    await h.next();
    await h.tui.waitForPending();
    h.tui.type("a.ts");
    h.tui.press("tui.select.confirm");
    h.down(1);
    h.tui.press("tui.select.confirm");
    await h.running;
    expect(h.options.apply).toHaveBeenCalledWith(
      [{ path: h.first, canonical: h.first, exists: true }],
      false,
      expect.any(AbortSignal),
    );
    expect(h.tui.isOpen).toBe(false);
    expect(h.tui.openCount).toBe(3); // Manager, picker, and transient cancellable commit loader.
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("prechecks the live set and keeps cancellation distinct from ending restriction", async () => {
    const h = await setup(true);
    expect(h.text()).toContain("Change allowed files…");
    expect(h.text()).toContain("Use only a new file…");
    expect(h.text()).toContain("End restriction");
    await h.next();
    await h.tui.waitForPending();
    expect(h.text()).toContain(`[x] ${JSON.stringify(h.first)}`);
    h.tui.press("tui.select.confirm");
    await h.back();
    expect(h.text()).toContain("Editing limited to 1 file");
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.off).not.toHaveBeenCalled();
    h.tui.press("tui.select.cancel");
    await h.running;
    expect(h.options.off).not.toHaveBeenCalled();
  });
  it("returns an empty selection to the manager without applying or releasing it", async () => {
    const h = await setup();
    await h.next();
    await h.tui.waitForPending();
    h.tui.press("tui.select.up");
    h.tui.press("tui.select.confirm");
    await h.tui.waitForOpen();
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.off).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.text()).toContain("Select files…"));
    expect(h.notify).toHaveBeenCalledWith("No files selected. The restriction is unchanged.", "info");
    h.tui.press("tui.select.cancel");
    await h.running;
  });
  it("retains an invalid new-path draft, reviews the exact replacement, and reserves without creating", async () => {
    const h = await setup(true);
    h.down(1);
    await h.next();
    h.tui.type("a.ts");
    h.tui.press("tui.input.submit");
    await h.tui.waitForPending();
    expect(h.text()).toContain('Draft: "a.ts"');
    expect(h.text()).toContain("already exists");
    h.tui.send("\x15");
    h.tui.type("new-file.ts");
    const closed = h.tui.resultPromise;
    h.tui.press("tui.input.submit");
    await closed;
    await h.tui.waitForOpen();
    expect(h.text()).toContain("Review new file");
    expect(h.text()).toContain("replaces the complete");
    expect(h.text()).toContain(join(h.cwd, "new-file.ts"));
    h.tui.press("tui.select.confirm");
    await h.running;
    expect(h.options.apply).toHaveBeenCalledWith(
      [expect.objectContaining({ path: join(h.cwd, "new-file.ts") })],
      true,
      expect.any(AbortSignal),
    );
    await expect(access(join(h.cwd, "new-file.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("shows outside/canonical target notices and hard-cancel never clears the live scope", async () => {
    const h = await setup(true);
    h.down(1);
    await h.next();
    h.tui.type(join(h.cwd, "..", "outside-new"));
    const closed = h.tui.resultPromise;
    h.tui.press("tui.input.submit");
    await closed;
    await h.tui.waitForOpen();
    expect(h.text()).toContain("Outside the current directory");
    h.tui.send("\x03");
    await h.running;
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.off).not.toHaveBeenCalled();
  });
  it("saves the picker preference immediately and Back does not undo it", async () => {
    const h = await setup();
    h.down(2);
    await h.next();
    expect(h.text()).toContain("saved immediately");
    const closed = h.tui.resultPromise;
    h.tui.press("tui.select.confirm");
    await closed;
    await h.tui.waitForOpen();
    expect(h.options.saveShowHiddenFiles).toHaveBeenCalledWith(true);
    expect(h.settings.showHiddenFiles).toBe(true);
    await h.back();
    expect(h.text()).toContain("Scope");
    h.tui.press("tui.select.cancel");
    await h.running;
    expect(h.settings.showHiddenFiles).toBe(true);
    expect(h.options.apply).not.toHaveBeenCalled();
  });
  it("rolls back a rejected setting, reports the failure, and keeps navigation usable", async () => {
    const h = await setup();
    h.options.saveShowHiddenFiles = vi.fn(async () => {
      throw new Error("save failed");
    });
    h.down(2);
    await h.next();
    h.tui.press("tui.select.confirm");
    await h.tui.waitForPending();
    expect(h.settings.showHiddenFiles).toBe(false);
    expect(h.text()).toContain("false");
    expect(h.notify).toHaveBeenCalledWith("save failed", "error");
    await h.back();
    h.tui.press("tui.select.cancel");
    await h.running;
  });
  it("ends only from the explicit action and returns straight to the prompt", async () => {
    const h = await setup(true);
    h.down(5);
    h.tui.press("tui.select.confirm");
    await h.running;
    expect(h.options.off).toHaveBeenCalledOnce();
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.tui.openCount).toBe(1);
  });
  it("allows Ctrl+C to abort and drain final apply validation instead of committing after close", async () => {
    const h = await setup();
    const entered = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    let applied = false;
    h.options.apply = vi.fn(async (_targets, _newFile, operation) => {
      signal = operation;
      entered.resolve();
      await release.promise;
      operation?.throwIfAborted();
      applied = true;
    });
    try {
      await h.next();
      await h.tui.waitForPending();
      h.tui.press("tui.select.confirm");
      h.tui.press("tui.select.up");
      h.tui.press("tui.select.confirm");
      await entered.promise;
      await h.tui.waitForOpen();
      h.tui.send("\x03");
      expect(signal?.aborted).toBe(true);
      release.resolve();
      await vi.waitFor(() => expect(h.text()).toContain("Select files…"));
      expect(applied).toBe(false);
      expect(h.options.off).not.toHaveBeenCalled();
      h.tui.press("tui.select.cancel");
      await h.running;
    } finally {
      release.resolve();
    }
  });
  it("exposes full Status and Help without making read-only paths selectable", async () => {
    const h = await setup(true);
    h.down(3);
    await h.next();
    expect(h.text()).toContain("Scope Status");
    expect(h.text()).toContain(h.first);
    expect(h.text()).toContain("not an OS sandbox");
    await h.back();
    h.down(1);
    await h.next();
    expect(h.text()).toContain("Scope Help");
    expect(h.text()).toContain("/scope off");
    await h.back();
    h.tui.press("tui.select.cancel");
    await h.running;
  });
});
