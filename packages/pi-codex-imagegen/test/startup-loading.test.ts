import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { showImagegenMenu } from "../src/menu.js";

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
  vi.useRealTimers();
  vi.doUnmock("../src/menu.js");
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture(menu?: typeof showImagegenMenu) {
  const root = await mkdtemp(join(tmpdir(), "imagegen-startup-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected network access"))),
  );
  vi.resetModules();
  const imported = deferred<void>();
  const module = deferred<{ showImagegenMenu: typeof showImagegenMenu }>();
  let imports = 0;
  vi.doMock("../src/menu.js", async () => {
    imports += 1;
    imported.resolve();
    return module.promise;
  });
  const { createImagegenExtension } = await import("../src/codex-imagegen.js");
  // Do not let the active-flow liveness poll introduce timing into import tests.
  vi.useFakeTimers();
  const mock = createMockPi();
  const show = vi.fn<typeof showImagegenMenu>(async () => {});
  const registration = createImagegenExtension(menu ? { menu } : {})(mock.pi);
  const ctx = createMockContext({ cwd: root, mode: "tui" }).ctx as ExtensionCommandContext;
  const emit = async (type: "session_start" | "session_shutdown", context: ExtensionContext = ctx) => {
    for (const handler of mock.events.get(type) ?? []) await handler({ type, reason: "reload" }, context);
  };
  const tasks: Promise<void>[] = [];
  const command = (context = ctx, args = "") => {
    const registered = mock.commands.get("codex-imagegen");
    if (!registered) throw new Error("Missing codex-imagegen command");
    const task = registered.handler(args, context) as Promise<void>;
    tasks.push(task);
    void task.catch(() => {});
    return task;
  };
  const finishImport = () => module.resolve({ showImagegenMenu: show });
  cleanup.push(async () => {
    finishImport();
    await emit("session_shutdown");
    await Promise.allSettled(tasks);
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...mock,
    ctx,
    root,
    show,
    registration,
    command,
    emit,
    imported: imported.promise,
    finishImport,
    failImport: () => module.reject(new Error("Menu import failed")),
    get imports() {
      return imports;
    },
  };
}

it("keeps the source startup graph free of menu, editor, settings UI, and Kit imports", async () => {
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
    "src/artifacts.ts",
    "src/codex-imagegen.ts",
    "src/image-client.ts",
    "src/index.ts",
    "src/settings.ts",
  ]);
  expect([...external].some((path) => path.startsWith("@narumitw/pi-tui-kit"))).toBe(false);
  expect(metafile.inputs["src/codex-imagegen.ts"]?.imports).toContainEqual(
    expect.objectContaining({ path: "src/menu.ts", kind: "dynamic-import" }),
  );
  for (const path of ["src/menu.ts", "src/prompt-editor.ts", "src/settings-screen.ts", "src/output-path-input.ts"])
    expect(Object.keys(metafile.inputs)).toContain(path);
});

it("registers synchronously, imports only on first menu use, and releases the tracked flow", async () => {
  const h = await fixture();
  expect(h.registration).toBeUndefined();
  expect([...h.commands.keys()]).toEqual(["codex-imagegen"]);
  expect(h.tools[0]).toMatchObject({ name: "codex_imagegen", exposure: "hidden" });
  expect(h.tools[0]?.renderCall).toBeTypeOf("function");
  expect(h.tools[0]?.renderResult).toBeTypeOf("function");
  expect([...h.messageRenderers.keys()]).toEqual(["codex-imagegen:result"]);
  expect(h.imports).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await h.emit("session_start");
  const definitions = [...h.tools];
  expect(h.imports).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const running = h.command();
  await h.imported;
  expect(h.show).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await expect(h.command()).rejects.toThrow("Wait for the current operation");
  h.finishImport();
  await running;
  expect(h.show).toHaveBeenCalledTimes(1);
  expect(h.show.mock.calls[0]?.[1].signal.aborted).toBe(false);
  expect(h.show.mock.calls[0]?.[1].isCurrent()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await h.command();
  expect(h.imports).toBe(1);
  expect(h.show).toHaveBeenCalledTimes(2);
  expect(h.tools).toEqual(definitions);
  expect(await readdir(h.root)).toEqual([]);
});

it("keeps injected menus on the same ownership path without importing the default menu", async () => {
  const menu = vi.fn<typeof showImagegenMenu>(async () => {});
  const h = await fixture(menu);
  await h.emit("session_start");
  await h.command();
  expect(menu).toHaveBeenCalledTimes(1);
  expect(menu.mock.calls[0]?.[1].isCurrent()).toBe(true);
  expect(h.imports).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["shutdown", "replacement"] as const)(
  "drains a delayed menu import on %s without opening stale UI",
  async (end) => {
    const h = await fixture();
    await h.emit("session_start");
    const running = h.command();
    await h.imported;
    let settled = false;
    const next = createMockContext({ cwd: h.root, mode: "tui" }).ctx as ExtensionCommandContext;
    const closing = (end === "shutdown" ? h.emit("session_shutdown") : h.emit("session_start", next)).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    h.finishImport();
    await Promise.all([running, closing]);
    expect(h.show).not.toHaveBeenCalled();
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    if (end === "replacement") {
      await h.command(next);
      expect(h.show).toHaveBeenCalledTimes(1);
      expect(h.show.mock.calls[0]?.[0]).toBe(next);
      await h.emit("session_shutdown", next);
    } else await h.emit("session_shutdown");
  },
);

it("revalidates public context liveness after import even before the disposal poll runs", async () => {
  const h = await fixture();
  await h.emit("session_start");
  const running = h.command();
  await h.imported;
  const descriptor = Object.getOwnPropertyDescriptor(h.ctx, "sessionManager");
  if (!descriptor) throw new Error("Missing session manager property");
  Object.defineProperty(h.ctx, "sessionManager", {
    configurable: true,
    get() {
      throw new Error("Runtime disposed");
    },
  });
  try {
    h.finishImport();
    await running;
    expect(h.show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    Object.defineProperty(h.ctx, "sessionManager", descriptor);
  }
});

it("propagates import failures and releases menu and watcher ownership before another attempt", async () => {
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
  expect(vi.getTimerCount()).toBe(0);
  await expect(h.command()).rejects.toMatchObject(loadFailure);
  expect(vi.getTimerCount()).toBe(0);
  await h.emit("session_shutdown");
});
