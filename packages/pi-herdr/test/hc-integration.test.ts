import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { HerdrWidgetObserver } from "../src/herdr-observer.js";

let directory: string;
let previous: string | undefined;
let integration: typeof import("../src/hc-integration.js");
let backend: typeof import("../src/herdr-integration.js");
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-hc-lifecycle-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  integration = await import("../src/hc-integration.js");
  backend = await import("../src/herdr-integration.js");
});
afterAll(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(directory, { force: true, recursive: true });
});
async function emit(mock: ReturnType<typeof createMockPi>, name: string, ctx: unknown) {
  for (const handler of mock.events.get(name) ?? []) await handler({ type: name }, ctx);
}
function fixture() {
  const counts = { starts: 0, shutdowns: 0 };
  const observer: HerdrWidgetObserver = {
    start() {
      counts.starts += 1;
    },
    restore: () => false,
    async shutdown() {
      counts.shutdowns += 1;
    },
  };
  const mock = createMockPi();
  const factory = integration.createHcIntegration({
    environment: { terminalId: "t1", socketEndpoint: "/unused" },
    observer,
    settingsPath: join(directory, "pi-herdr.json"),
  });
  return { mock, counts, observer, factory };
}

test("hc inherited identity takes priority, and partial/invalid bindings never fall through to legacy", () => {
  const legacy = { HERDR_ENV: "1", HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: "/legacy" };
  assert.deepEqual(backend.selectIntegrationBackend(legacy), { kind: "herdr" });
  assert.deepEqual(
    backend.selectIntegrationBackend({ ...legacy, HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/native" }),
    { kind: "hc", environment: { terminalId: "t1", socketEndpoint: "/native" } },
  );
  for (const env of [
    { HC_TERMINAL_ID: "t1" },
    { HC_TERMINAL_SOCKET: "/native" },
    { HC_TERMINAL_ID: "", HC_TERMINAL_SOCKET: "/native" },
    { HC_TERMINAL_ID: " t1 ", HC_TERMINAL_SOCKET: "/native" },
    { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "  " },
    { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "bad\u001bendpoint" },
  ])
    assert.deepEqual(backend.selectIntegrationBackend({ ...legacy, ...env }), { kind: "disabled" });
});

test("hc factory registers only widget lifecycle, never competes with Pi's native OSC reporter", async () => {
  const f = fixture();
  f.factory(f.mock.pi);
  assert.deepEqual([...f.mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
  assert.deepEqual([...f.mock.commands.keys()], ["herdr"]);
  assert.equal(f.counts.starts, 0);
  const ctx = createMockContext({ mode: "tui", hasUI: true });
  await emit(f.mock, "session_start", ctx.ctx);
  assert.equal(f.counts.starts, 1);
  await emit(f.mock, "session_shutdown", ctx.ctx);
  await emit(f.mock, "session_shutdown", ctx.ctx);
  assert.equal(f.counts.shutdowns, 1);
});

test("hc copies claim one runtime, release it, and reacquire for a replacement session", async () => {
  const f = fixture();
  f.factory(f.mock.pi);
  const duplicate = createMockPi();
  duplicate.rawPi.events = f.mock.eventBus;
  f.factory(duplicate.pi);
  assert.equal(duplicate.commands.size, 0);
  assert.equal(duplicate.events.size, 0);
  const old = createMockContext({ mode: "tui", hasUI: true });
  await emit(f.mock, "session_start", old.ctx);
  await emit(f.mock, "session_shutdown", old.ctx);
  const replacement = createMockContext({ mode: "tui", hasUI: true });
  await emit(f.mock, "session_start", replacement.ctx);
  const late = createMockPi();
  late.rawPi.events = f.mock.eventBus;
  f.factory(late.pi);
  assert.equal(late.commands.size, 0);
  await emit(f.mock, "session_shutdown", old.ctx);
  assert.equal(f.counts.shutdowns, 1);
  await emit(f.mock, "session_shutdown", replacement.ctx);
  assert.equal(f.counts.shutdowns, 2);
});

test("hc repeat shutdown joins the same in-flight widget teardown", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.observer.shutdown = async () => {
    f.counts.shutdowns += 1;
    await gate;
  };
  f.factory(f.mock.pi);
  const ctx = createMockContext({ mode: "tui", hasUI: true });
  await emit(f.mock, "session_start", ctx.ctx);
  let settled = 0;
  const first = emit(f.mock, "session_shutdown", ctx.ctx).then(() => {
    settled += 1;
  });
  const second = emit(f.mock, "session_shutdown", ctx.ctx).then(() => {
    settled += 1;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(f.counts.shutdowns, 1);
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`hc lifecycle leaves native reporting/widget untouched in ${mode} mode`, async () => {
    const f = fixture();
    f.factory(f.mock.pi);
    const ctx = createMockContext({ mode, hasUI: mode === "rpc" });
    await emit(f.mock, "session_start", ctx.ctx);
    assert.equal(f.counts.starts, 0);
    if (mode !== "rpc") {
      await assert.rejects(
        f.mock.commands.get("herdr")?.handler("", ctx.ctx) as Promise<unknown>,
        /requires TUI or RPC/u,
      );
    }
    await emit(f.mock, "session_shutdown", ctx.ctx);
  });
}
