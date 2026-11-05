import {
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayFilePath, displayPath } from "../src/display.js";
import type { ScopeMenuOptions, ScopeView } from "../src/menu.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "scope-menu-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
const { showScopeMenu } = await import("../src/menu.js");
initTheme("dark", false);
const originalKeys = getKeybindings();
const fixtures: Array<{ dispose(): Promise<void> }> = [];
beforeEach(() => {
  vi.unstubAllEnvs();
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});
afterEach(async () => {
  try {
    const outcomes = await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.dispose()));
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setKeybindings(originalKeys);
  }
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "scope-menu-")));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(cwd);
  await mkdir(home);
  vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
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
  const customOptions: unknown[] = [];
  // Component tests inspect factory output; native overlay geometry has its own host tests.
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) => {
    customOptions.push(options);
    return tui.custom(factory);
  };
  const ctx = { mode: "tui", hasUI: true, ui: { custom, notify } } as unknown as ExtensionCommandContext;
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
    root,
    home,
    cwd,
    first,
    second,
    owner,
    tui,
    notify,
    customOptions,
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
      try {
        owner.abort();
        tui.dispose();
        await running;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
  fixtures.push(result);
  await tui.waitForOpen();
  return result;
}

type MenuHarness = Awaited<ReturnType<typeof setup>>;

async function fixtureFile(base: string, name: string) {
  const path = join(base, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "fixture original\n");
  return { path, canonical: await realpath(path) };
}

async function submitPath(h: MenuHarness, raw: string) {
  h.tui.send("\x0f");
  h.tui.send("\x15");
  h.tui.type(raw);
  h.tui.press("tui.input.submit");
  await h.tui.waitForPending();
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
    h.tui.press("tui.input.tab");
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
    expect(h.text()).toContain(`[x] ${displayFilePath(relative(h.cwd, h.first))}`);
    h.tui.press("tui.input.tab");
    await h.back();
    expect(h.text()).toContain("Editing limited to 1 file");
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.off).not.toHaveBeenCalled();
    h.tui.press("tui.select.cancel");
    await h.running;
    expect(h.options.off).not.toHaveBeenCalled();
  });
  it("keeps an empty checked draft open without applying or releasing the restriction", async () => {
    const h = await setup();
    await h.next();
    await h.tui.waitForPending();
    h.tui.press("tui.select.confirm");
    expect(h.text()).toContain("Select at least one file first.");
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.off).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    await h.back();
    expect(h.text()).toContain("Select files…");
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
  it.each(["inside", "canonical-outside", "lexical-outside"] as const)(
    "labels both new-file locations for %s directory redirects without creating content",
    async (location) => {
      const h = await setup(true);
      const outside = join(h.root, "outside");
      await mkdir(outside);
      const linkPath = location === "lexical-outside" ? join(outside, "link") : join(h.cwd, "link");
      const destination = location === "canonical-outside" ? outside : h.cwd;
      await symlink(destination, linkPath, "dir");
      const raw = join(linkPath, "new.txt");
      const canonical = join(destination, "new.txt");
      h.down(1);
      await h.next();
      h.tui.type(raw);
      const closed = h.tui.resultPromise;
      h.tui.press("tui.input.submit");
      await closed;
      await h.tui.waitForOpen();
      const review = h.text();
      h.tui.send("\x03");
      await h.running;
      expect(review).toContain(`Path: ${displayPath(raw)}`);
      expect(review).toContain(`Canonical target: ${displayPath(canonical)}`);
      expect(review.includes("Outside the current directory.")).toBe(location !== "inside");
      expect(h.options.apply).not.toHaveBeenCalled();
      expect(h.options.off).not.toHaveBeenCalled();
      await expect(access(canonical)).rejects.toMatchObject({ code: "ENOENT" });
      expect(h.customOptions.length).toBeGreaterThanOrEqual(3);
      expect(
        h.customOptions.every(
          (options) =>
            JSON.stringify(options) ===
            JSON.stringify({
              overlay: true,
              overlayOptions: { anchor: "bottom-left", width: "100%", maxHeight: "100%", margin: 0 },
            }),
        ),
      ).toBe(true);
    },
  );
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
      h.tui.press("tui.input.tab");
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
    expect(h.text()).toContain("Edit Scope Status");
    expect(h.text()).toContain(h.first);
    expect(h.text()).toContain("not an OS sandbox");
    await h.back();
    h.down(1);
    await h.next();
    expect(h.text()).toContain("Edit Scope Help");
    expect(h.text()).toContain("/edit-scope off");
    await h.back();
    h.tui.press("tui.select.cancel");
    await h.running;
  });
});

describe("manual existing-file selection", () => {
  it.each([
    [
      "home project",
      "home/src/another_project/AGENTS.md",
      (_root: string): string => "~/src/another_project/AGENTS.md",
    ],
    ["hidden home plan", "home/.plan/PLAN_A.md", (_root: string): string => "~/.plan/PLAN_A.md"],
    [
      "absolute config",
      "config/editor settings.json",
      (root: string): string => join(root, "config/editor settings.json"),
    ],
    ["relative external config", "config/editor.json", (_root: string): string => "../config/editor.json"],
    [
      "file URL",
      "config/a\u202fb.json",
      (root: string): string => pathToFileURL(join(root, "config/a\u202fb.json")).href,
    ],
    ["@ absolute config", "config/editor.json", (root: string): string => `@${join(root, "config/editor.json")}`],
  ] as const)("adds %s only to the checked draft until Enter applies", async (_name, name, input) => {
    const h = await setup(true);
    const target = await fixtureFile(h.root, name);
    const raw = input(h.root);
    const live = h.options.getView();
    h.tui.resize({ width: 240, rows: 40 });
    await h.next();
    await h.tui.waitForPending();
    h.tui.type("b.ts");
    h.tui.press("tui.input.tab");
    h.tui.send("\x15");
    h.tui.send("\x0f");
    h.tui.type(raw);
    expect(h.text()).toContain("Add existing file");
    expect(h.text()).toContain(`Path: ${displayPath(raw)}`);
    expect(h.options.apply).not.toHaveBeenCalled();
    h.tui.press("tui.input.submit");
    await h.tui.waitForPending();
    const draft = h.text();
    expect(draft).toContain(`→ [x] (outside) ${displayFilePath(target.path)}`);
    expect(draft).toContain("Outside the current directory");
    expect(draft).toContain(`[x] ${displayFilePath(relative(h.cwd, h.first))}`);
    expect(draft).toContain(`[x] ${displayFilePath(relative(h.cwd, h.second))}`);
    expect(draft).not.toContain(`> ${raw}`);
    expect(h.options.getView()).toEqual(live);
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.off).not.toHaveBeenCalled();
    expect(h.options.saveShowHiddenFiles).not.toHaveBeenCalled();
    expect(h.settings.showHiddenFiles).toBe(false);
    expect(await readFile(target.path, "utf8")).toBe("fixture original\n");
    h.tui.press("tui.select.confirm");
    await h.running;
    expect(h.options.apply).toHaveBeenCalledOnce();
    expect(h.options.apply).toHaveBeenCalledWith(
      [live.targets[0], { path: h.second, canonical: h.second, exists: true }, expect.objectContaining(target)],
      false,
      expect.any(AbortSignal),
    );
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("adds hidden and excluded cwd files without changing discovery preferences", async () => {
    const h = await setup(true);
    const names = [".plan/PLAN_A.md", "node_modules/example/settings.json", ".git/config"];
    const targets = await Promise.all(names.map((name) => fixtureFile(h.cwd, name)));
    h.tui.resize({ width: 240, rows: 44 });
    await h.next();
    await h.tui.waitForPending();
    for (const target of targets) expect(h.text()).not.toContain(displayFilePath(relative(h.cwd, target.path)));
    for (const [index, name] of names.entries()) {
      await submitPath(h, `./${name}`);
      expect(h.text()).toContain(`→ [x] ${displayFilePath(relative(h.cwd, targets[index].path))}`);
      expect(h.options.apply).not.toHaveBeenCalled();
    }
    expect(h.text()).toContain(`[x] ${displayFilePath(relative(h.cwd, h.first))}`);
    expect(h.settings.showHiddenFiles).toBe(false);
    expect(h.options.saveShowHiddenFiles).not.toHaveBeenCalled();
    h.tui.press("tui.select.confirm");
    await h.running;
    expect(vi.mocked(h.options.apply).mock.calls[0]?.[0]).toMatchObject([
      { path: h.first, canonical: h.first },
      ...targets,
    ]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", /does not exist/u],
    ["directory", /regular file/u],
    ["hard link", /hard-linked/u],
    ["dangling link", /ENOENT/u],
    ["malformed URL", /URI malformed/u],
  ] as const)("rejects a %s without creating files or losing the independent drafts", async (kind, error) => {
    const h = await setup(true);
    let raw = join(h.root, "missing", "nested", "target.json");
    if (kind === "directory") {
      raw = join(h.root, "directory");
      await mkdir(raw);
    } else if (kind === "hard link") {
      raw = (await fixtureFile(h.root, "hard-linked.json")).path;
      await link(raw, join(h.root, "hard-alias.json"));
    } else if (kind === "dangling link") {
      raw = join(h.root, "dangling.json");
      await symlink(join(h.root, "absent.json"), raw, "file");
    } else if (kind === "malformed URL") raw = "file:///bad%xx";
    const inventory = (await readdir(h.root, { recursive: true })).sort();
    const live = h.options.getView();
    h.tui.resize({ width: 240, rows: 40 });
    await h.next();
    await h.tui.waitForPending();
    h.tui.type("b.ts");
    h.tui.press("tui.input.tab");
    await submitPath(h, raw);
    expect(h.text()).toMatch(error);
    expect(h.text()).toContain(`> ${raw}`);
    expect(h.text()).toContain("Add existing file");
    expect(h.options.getView()).toEqual(live);
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.off).not.toHaveBeenCalled();
    expect((await readdir(h.root, { recursive: true })).sort()).toEqual(inventory);
    await expect(access(join(h.root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    h.tui.press("tui.select.cancel");
    expect(h.text()).toContain("> b.ts");
    expect(h.text()).toContain("2 selected");
    h.tui.send("\x15");
    expect(h.text()).toContain(`[x] ${displayFilePath(relative(h.cwd, h.first))}`);
    expect(h.text()).toContain(`[x] ${displayFilePath(relative(h.cwd, h.second))}`);
    h.tui.press("tui.select.confirm");
    await h.running;
    expect(vi.mocked(h.options.apply).mock.calls[0]?.[0].map((target) => target.path)).toEqual([h.first, h.second]);
    expect(await readFile(h.first, "utf8")).toBe("a");
    expect(await readFile(h.second, "utf8")).toBe("b");
  });

  it("checks normalized duplicates once without toggling an existing check", async () => {
    const h = await setup(true);
    const target = await fixtureFile(h.home, "src/another_project/AGENTS.md");
    h.tui.resize({ width: 240, rows: 40 });
    await h.next();
    await h.tui.waitForPending();
    await submitPath(h, "./b.ts");
    expect(h.text()).toContain(`→ [x] ${displayFilePath(relative(h.cwd, h.second))}`);
    await submitPath(h, "~/src/another_project/AGENTS.md");
    for (const raw of [
      target.path,
      "~/src/another_project/./AGENTS.md",
      pathToFileURL(target.path).href,
      `@${target.path}`,
    ]) {
      await submitPath(h, raw);
      const draft = h.text();
      expect(draft).toContain(`→ [x] (outside) ${displayFilePath(target.path)}`);
      expect(draft).toContain("3 selected");
      expect(
        draft.split("\n").filter((line) => line.includes(`[x] (outside) ${displayFilePath(target.path)}`)),
      ).toHaveLength(1);
      expect(h.options.apply).not.toHaveBeenCalled();
    }
    h.tui.press("tui.select.confirm");
    await h.running;
    expect(vi.mocked(h.options.apply).mock.calls[0]?.[0].map((entry) => entry.path)).toEqual([
      h.first,
      h.second,
      target.path,
    ]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each([
    ["removed file", /does not exist|ENOENT/u],
    ["directory replacement", /regular file/u],
    ["symlink redirect", /changed|not an allowed file/u],
  ] as const)("does not silently reserve a manual target after a %s", async (kind, error) => {
    const h = await setup(true);
    const target = await fixtureFile(h.root, "external-target.json");
    const other = await fixtureFile(h.root, "other.json");
    const live = h.options.getView();
    h.tui.resize({ width: 240, rows: 40 });
    await h.next();
    await h.tui.waitForPending();
    await submitPath(h, target.path);
    await unlink(target.path);
    if (kind === "directory replacement") await mkdir(target.path);
    else if (kind === "symlink redirect") await symlink(other.path, target.path, "file");
    h.tui.type("external-target");
    h.tui.press("tui.select.confirm");
    await h.tui.waitForPending();
    const rejected = h.text();
    expect(h.tui.isOpen).toBe(true);
    expect(rejected).toMatch(error);
    expect(rejected).toContain("> external-target");
    expect(rejected).toContain(`[x] (outside) ${displayFilePath(target.path)}`);
    expect(rejected).toContain("2 selected");
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.getView()).toEqual(live);
    expect(await readFile(other.path, "utf8")).toBe("fixture original\n");
    if (kind === "removed file") await expect(access(target.path)).rejects.toMatchObject({ code: "ENOENT" });
    await h.back();
    h.tui.press("tui.select.cancel");
    await h.running;
    expect(h.options.off).not.toHaveBeenCalled();
  });

  it.each([
    ["retargeted alias", /changed|not an allowed file/u],
    ["removed canonical file", /does not exist|ENOENT/u],
    ["hard-linked canonical file", /hard-linked/u],
  ] as const)("revalidates the pinned manual reservation after a %s", async (kind, error) => {
    const h = await setup(true);
    const original = await fixtureFile(h.root, "external/original.txt");
    const other = await fixtureFile(h.root, "external/other.txt");
    const alias = join(h.root, "external/selected-link.txt");
    await symlink(original.path, alias, "file");
    const live = h.options.getView();
    h.tui.resize({ width: 240, rows: 44 });
    await h.next();
    await h.tui.waitForPending();
    await submitPath(h, alias);
    expect(h.text()).toContain(`→ [x] (outside) ${displayFilePath(alias)}`);
    expect(h.text()).toContain(`Canonical target: ${displayFilePath(original.canonical)}`);
    await submitPath(h, original.path);
    if (kind === "retargeted alias") {
      await unlink(alias);
      await symlink(other.path, alias, "file");
    } else if (kind === "removed canonical file") await unlink(original.path);
    else await link(original.path, join(h.root, "external/hard-alias.txt"));
    h.tui.type("selected-link");
    h.tui.press("tui.select.confirm");
    await h.tui.waitForPending();
    const rejected = h.text();
    expect(rejected).toMatch(error);
    expect(rejected).toContain("> selected-link");
    expect(rejected).toContain(`[x] (outside) ${displayFilePath(alias)}`);
    expect(rejected).toContain("3 selected");
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.getView()).toEqual(live);
    expect(await readFile(other.path, "utf8")).toBe("fixture original\n");
    h.tui.send("\x15");
    expect(h.text()).toContain(`[x] ${displayFilePath(relative(h.cwd, h.first))}`);
    expect(h.text()).toContain(`[x] (outside) ${displayFilePath(original.path)}`);
    await h.back();
    h.tui.press("tui.select.cancel");
    await h.running;
    expect(h.options.off).not.toHaveBeenCalled();
  });
});
