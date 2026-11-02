import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "./support.js";

const watches = vi.hoisted(
  () =>
    [] as Array<{
      listener(event: string, filename: string): void;
      close: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: vi.fn((_path: string, _options: unknown, listener: (event: string, filename: string) => void) => {
      const close = vi.fn();
      watches.push({ listener, close });
      return { on: vi.fn().mockReturnThis(), close };
    }),
  };
});

test("settings reload Node timers are unreferenced and cancel on debounce, replacement, and shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-timer-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  vi.resetModules();
  const { default: planMode } = await import("../src/plan-mode.js");
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { settingsPath: join(directory, "pi-plan-mode.json") });
  const context = createMockContext();
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    const firstWatch = watches.at(-1);
    assert.ok(firstWatch);
    firstWatch.listener("change", "pi-plan-mode.json");
    const first = timeout.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    assert.ok(first);
    assert.equal(first.hasRef(), false);

    firstWatch.listener("rename", "pi-plan-mode.json");
    const second = timeout.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.hasRef(), false);
    assert.equal(clear.mock.calls.filter(([handle]) => handle === first).length, 1);

    const replacement = createMockContext();
    await mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
    assert.equal(firstWatch.close.mock.calls.length, 1);
    assert.equal(clear.mock.calls.filter(([handle]) => handle === second).length, 1);
    const nextWatch = watches.at(-1);
    assert.ok(nextWatch);
    assert.notEqual(nextWatch, firstWatch);
    nextWatch.listener("change", "pi-plan-mode.json");
    const third = timeout.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;
    assert.ok(third);
    assert.equal(third.hasRef(), false);
    await mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
    await mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
    assert.equal(clear.mock.calls.filter(([handle]) => handle === third).length, 1);
    assert.equal(nextWatch.close.mock.calls.length, 1);
  } finally {
    await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
    timeout.mockRestore();
    clear.mockRestore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
});
