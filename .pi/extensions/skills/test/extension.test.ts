import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createSkillsExtension as Factory } from "../skills-extension.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(show: Parameters<typeof Factory>[0] = async () => false) {
  const agent = await mkdtemp(join(tmpdir(), "skills-lifecycle-"));
  dirs.push(agent);
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.resetModules();
  const { createSkillsExtension } = await import("../skills-extension.ts");
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const api = {
    on: vi.fn((event, handler) => {
      hooks.set(event, handler);
    }),
    registerCommand: vi.fn((_name, options) => {
      command = options;
    }),
  } as unknown as ExtensionAPI;
  createSkillsExtension(show)(api);
  const ui = { notify: vi.fn() };
  const context = (mode = "rpc", sessionManager = {}) =>
    ({
      cwd: agent,
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      ui,
      sessionManager,
      isProjectTrusted: () => true,
      reload: vi.fn(async () => {}),
    }) as unknown as ExtensionCommandContext;
  return { api, hooks, context, command: command as NonNullable<typeof command>, agent };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("skills lifecycle", () => {
  it("registers one command and only session hooks without action APIs at factory load", async () => {
    const fixture = await setup();
    expect(fixture.api.registerCommand).toHaveBeenCalledTimes(1);
    expect([...fixture.hooks.keys()]).toEqual(["session_start", "session_shutdown"]);
    expect(fixture.command.getArgumentCompletions?.("re")).toEqual([{ value: "remove", label: "remove" }]);
  });
  it.each(["print", "json"])("rejects %s observably before UI/network/filesystem work", async (mode) => {
    const show = vi.fn(async () => false);
    const f = await setup(show);
    await expect(f.command.handler("add a/b", f.context(mode))).rejects.toThrow("requires");
    expect(show).not.toHaveBeenCalled();
  });
  it.each(["tui", "rpc"])("forwards routes in %s with the actual agent directory", async (mode) => {
    const show = vi.fn<NonNullable<Parameters<typeof Factory>[0]>>(async () => false);
    const f = await setup(show);
    await f.command.handler("move", f.context(mode));
    expect(show.mock.calls[0]?.[1]).toEqual({ kind: "move" });
    expect(show.mock.calls[0]?.[2]).toMatchObject({ agentDir: f.agent });
  });
  it("rejects a second flow for the same session, not a shared headless UI", async () => {
    const gate = deferred<boolean>();
    const show = vi.fn(() => gate.promise);
    const f = await setup(show);
    const a = f.context();
    const b = f.context();
    const first = f.command.handler("", a);
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    await expect(f.command.handler("remove", a)).rejects.toThrow("already open");
    const second = f.command.handler("", b);
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    gate.resolve(false);
    await Promise.all([first, second]);
  });
  it("aborts and drains owned work on shutdown, with idempotent repeated cleanup", async () => {
    const entered = deferred<void>();
    let aborted = false;
    const f = await setup(async (_ctx, _route, _env, guard) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        guard.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      guard.check();
      return false;
    });
    const ctx = f.context();
    const command = f.command.handler("", ctx);
    await entered.promise;
    await f.hooks.get("session_shutdown")?.({}, ctx);
    await command;
    await f.hooks.get("session_shutdown")?.({}, ctx);
    expect(aborted).toBe(true);
  });
  it("a repeated session_start invalidates and drains the previous generation", async () => {
    const entered = deferred<void>();
    let first = true;
    const f = await setup(async (_ctx, _route, _env, guard) => {
      if (!first) return false;
      first = false;
      entered.resolve();
      await new Promise<void>((resolve) => guard.signal.addEventListener("abort", () => resolve(), { once: true }));
      guard.check();
      return false;
    });
    const ctx = f.context();
    await f.hooks.get("session_start")?.({}, ctx);
    const old = f.command.handler("", ctx);
    await entered.promise;
    await f.hooks.get("session_start")?.({}, ctx);
    await old;
    await f.command.handler("", ctx);
  });
  it("clears owned command work before reload and never uses the old context afterward", async () => {
    const f = await setup(async () => true);
    const ctx = f.context();
    let invalid = false;
    ctx.reload = vi.fn(async () => {
      await f.hooks.get("session_shutdown")?.({}, ctx);
      invalid = true;
    });
    ctx.isProjectTrusted = () => {
      if (invalid) throw new Error("Old context used");
      return true;
    };
    await f.command.handler("", ctx);
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });
  it("does not reuse a context when shutdown overtakes session startup", async () => {
    const f = await setup();
    const ctx = f.context();
    const key = ctx.sessionManager;
    let stale = false;
    Object.defineProperty(ctx, "sessionManager", {
      get() {
        if (stale) throw new Error("Stale context used");
        return key;
      },
    });
    const starting = f.hooks.get("session_start")?.({}, ctx);
    const shutting = f.hooks.get("session_shutdown")?.({}, ctx);
    stale = true;
    await Promise.all([starting, shutting]);
  });
  it("propagates ordinary errors instead of hiding failures", async () => {
    const f = await setup(async () => {
      throw new Error("test failure");
    });
    await expect(f.command.handler("", f.context())).rejects.toThrow("test failure");
  });
});
