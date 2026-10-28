import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function emit(
  events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
  name: string,
  ...args: unknown[]
) {
  for (const handler of events.get(name) ?? []) await handler(...args);
}

async function withRuntime(run: (root: string, mock: ReturnType<typeof createMockPi>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-profile-lifecycle-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    vi.resetModules();
    const { default: extension } = await import("../src/pi-starship.js");
    const mock = createMockPi();
    mock.rawPi.getThinkingLevel = () => "off";
    extension(mock.pi);
    await run(root, mock);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("a pending configuration editor prevents a second workflow but leaves status available", async () => {
  await withRuntime(async (root, mock) => {
    const ready = deferred<void>();
    const draft = deferred<string | undefined>();
    let editorCalls = 0;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => {
        editorCalls += 1;
        ready.resolve();
        return editorCalls === 1 ? draft.promise : undefined;
      },
    });
    await emit(mock.events, "session_start", {}, context.ctx);
    const command = mock.commands.get("starship");
    assert.ok(command);
    const running = command.handler("settings", context.ctx);
    try {
      await ready.promise;
      await command.handler("settings", context.ctx);
      assert.equal(editorCalls, 1);
      assert.match(context.notifications.at(-1)?.message ?? "", /already open/u);
      await command.handler("status", context.ctx);
      assert.match(context.notifications.at(-1)?.message ?? "", /pi-starship source/u);
      draft.resolve(undefined);
      await running;
      await command.handler("settings", context.ctx);
      assert.equal(editorCalls, 2);
      assert.equal(existsSync(join(root, "pi-starship.toml")), false);
      assert.equal(existsSync(join(root, "pi-starship")), false);
    } finally {
      draft.resolve(undefined);
      await running;
      await emit(mock.events, "session_shutdown", {}, context.ctx);
    }
  });
});

test("a stale editor cannot release a replacement session's workflow gate or save its draft", async () => {
  await withRuntime(async (root, mock) => {
    const oldReady = deferred<void>();
    const newReady = deferred<void>();
    const oldDraft = deferred<string | undefined>();
    const newDraft = deferred<string | undefined>();
    let editorCalls = 0;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      editor: async () => {
        editorCalls += 1;
        if (editorCalls === 1) {
          oldReady.resolve();
          return oldDraft.promise;
        }
        newReady.resolve();
        return newDraft.promise;
      },
    });
    await emit(mock.events, "session_start", {}, context.ctx);
    const command = mock.commands.get("starship");
    assert.ok(command);
    const oldCommand = command.handler("settings", context.ctx);
    let newCommand: ReturnType<typeof command.handler> | undefined;
    try {
      await oldReady.promise;
      // Pi can replace runtime state while retaining the same sessionManager object.
      await emit(mock.events, "session_start", {}, context.ctx);
      newCommand = command.handler("settings", context.ctx);
      await newReady.promise;
      oldDraft.resolve("format = 'stale draft'\n");
      await oldCommand;
      await command.handler("settings", context.ctx);
      assert.equal(editorCalls, 2);
      assert.match(context.notifications.at(-1)?.message ?? "", /already open/u);
      assert.equal(existsSync(join(root, "pi-starship.toml")), false);
    } finally {
      oldDraft.resolve(undefined);
      newDraft.resolve(undefined);
      await oldCommand;
      await newCommand;
      await emit(mock.events, "session_shutdown", {}, context.ctx);
    }
  });
});
