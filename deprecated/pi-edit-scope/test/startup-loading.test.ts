import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { showScopeMenu } from "../src/menu.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.doUnmock("../src/menu.js");
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "edit-scope-startup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected network access"))),
  );
  vi.resetModules();
  const imported = deferred<void>();
  const module = deferred<{ showScopeMenu: typeof showScopeMenu }>();
  let imports = 0;
  vi.doMock("../src/menu.js", async () => {
    imports += 1;
    imported.resolve();
    return module.promise;
  });
  const { createEditScopeExtension } = await import("../src/edit-scope.js");
  const mock = createMockPi();
  const show = vi.fn<typeof showScopeMenu>(async () => {});
  const registration = createEditScopeExtension()(mock.pi);
  const ctx = createMockContext({ cwd: root, mode: "tui" }).ctx as ExtensionCommandContext;
  const emit = async (type: "session_start" | "session_shutdown") => {
    for (const handler of mock.events.get(type) ?? []) await handler({ type, reason: "reload" }, ctx);
  };
  const tasks: Promise<void>[] = [];
  const command = (name = "edit-scope", args = "") => {
    const registered = mock.commands.get(name);
    if (!registered) throw new Error(`Missing ${name} command`);
    const task = registered.handler(args, ctx) as Promise<void>;
    tasks.push(task);
    void task.catch(() => {});
    return task;
  };
  const finishImport = () => module.resolve({ showScopeMenu: show });
  cleanup.push(async () => {
    finishImport();
    await emit("session_shutdown");
    await Promise.allSettled(tasks);
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...mock,
    root,
    show,
    registration,
    emit,
    command,
    imported: imported.promise,
    finishImport,
    failImport: () => module.reject(new Error("Menu import failed")),
    get imports() {
      return imports;
    },
  };
}

it("keeps enforcement, contracts, and display text eager without loading Kit root or menu framing", async () => {
  const { metafile } = await build({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    treeShaking: false,
    metafile: true,
    write: false,
  });
  const files = new Set<string>();
  const external = new Set<string>();
  const visit = (path: string) => {
    if (files.has(path)) return;
    files.add(path);
    const input = metafile.inputs[path];
    if (!input) throw new Error(`Missing source graph input: ${path}`);
    for (const dependency of input.imports) {
      if (dependency.kind === "dynamic-import") continue;
      if (dependency.external) external.add(dependency.path);
      else visit(dependency.path);
    }
  };
  visit("src/index.ts");
  expect([...files].sort()).toEqual([
    "src/contracts.ts",
    "src/display.ts",
    "src/edit-scope.ts",
    "src/index.ts",
    "src/paths.ts",
    "src/policy.ts",
    "src/settings.ts",
    "src/state.ts",
  ]);
  expect([...external].filter((path) => path.startsWith("@narumitw/pi-tui-kit")).sort()).toEqual([
    "@narumitw/pi-tui-kit/editor-status-widget",
    "@narumitw/pi-tui-kit/terminal-text",
  ]);
  expect(metafile.inputs["src/edit-scope.ts"]?.imports).toContainEqual(
    expect.objectContaining({ path: "src/menu.ts", kind: "dynamic-import" }),
  );
  for (const path of ["src/input.ts", "src/picker.ts"])
    expect(metafile.inputs[path]?.imports).toContainEqual(
      expect.objectContaining({ path: "src/ui.ts", kind: "import-statement" }),
    );
  expect(metafile.inputs["src/display.ts"]?.imports).toEqual([
    expect.objectContaining({ path: "@narumitw/pi-tui-kit/terminal-text", external: true }),
  ]);
});

it("registers both commands and completions synchronously and imports UI only on first menu use", async () => {
  const h = await fixture();
  expect(h.registration).toBeUndefined();
  expect([...h.commands.keys()]).toEqual(["edit-scope", "scope"]);
  for (const command of h.commands.values())
    expect(command.getArgumentCompletions?.("o")).toEqual([
      { value: "off", label: "off", description: "End the editing restriction" },
    ]);
  expect(h.tools).toEqual([]);
  expect(h.imports).toBe(0);
  await h.emit("session_start");
  expect(h.imports).toBe(0);
  const running = h.command();
  await h.imported;
  expect(h.show).not.toHaveBeenCalled();
  await expect(h.command("scope")).rejects.toThrow("already open");
  h.finishImport();
  await running;
  expect(h.show).toHaveBeenCalledTimes(1);
  expect(h.show.mock.calls[0]?.[1].isCurrent()).toBe(false);
  expect(h.show.mock.calls[0]?.[1].signal.aborted).toBe(true);
  await h.command("scope");
  expect(h.show).toHaveBeenCalledTimes(2);
  expect(h.imports).toBe(1);
  expect(h.entries).toEqual([]);
  expect(h.sentMessages).toEqual([]);
  expect(await readdir(h.root)).toEqual([]);
});

it.each(["session_shutdown", "session_start"] as const)(
  "drains the pending lazy import during %s and never opens a replaced flow",
  async (event) => {
    const h = await fixture();
    await h.emit("session_start");
    const running = h.command();
    await h.imported;
    let settled = false;
    const closing = h.emit(event).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.finishImport();
    await Promise.all([running, closing]);
    expect(h.show).not.toHaveBeenCalled();
    expect(settled).toBe(true);
    if (event === "session_start") {
      await h.command();
      expect(h.show).toHaveBeenCalledTimes(1);
    } else await h.emit("session_shutdown");
  },
);

it("propagates an import failure without retaining the command flow", async () => {
  const h = await fixture();
  await h.emit("session_start");
  const running = h.command();
  // Vitest wraps a rejected mock-module factory and retains its original cause.
  const loadFailure = { cause: expect.objectContaining({ message: "Menu import failed" }) };
  const failure = expect(running).rejects.toMatchObject(loadFailure);
  await h.imported;
  h.failImport();
  await failure;
  expect(h.show).not.toHaveBeenCalled();
  await expect(h.command("scope")).rejects.toMatchObject(loadFailure);
  await h.emit("session_shutdown");
});
