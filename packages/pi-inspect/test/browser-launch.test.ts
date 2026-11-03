import assert from "node:assert/strict";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

vi.mock("../src/server.js", () => ({ startServer: vi.fn() }));
const { registerInspector } = await import("../src/extension.js");
const { startServer } = await import("../src/server.js");

afterEach(() => vi.clearAllMocks());

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "", stderr: "", code: 0, killed: false, truncated: false, ...overrides };
}

function harness(exec: ExtensionAPI["exec"]) {
  const mock = createMockPi();
  Object.assign(mock.rawPi, { exec });
  const server = {
    origin: "http://127.0.0.1:1",
    token: "private",
    url: "http://127.0.0.1:1/#token=private",
    invalidate: vi.fn(),
    close: vi.fn(async () => {}),
  };
  vi.mocked(startServer).mockResolvedValue(server);
  registerInspector(mock.pi as ExtensionAPI);
  const { ctx, notifications } = createMockContext({
    mode: "tui",
    sessionManager: SessionManager.inMemory(process.cwd()),
    getSystemPromptOptions: () => ({ cwd: process.cwd(), skills: [] }),
  });
  const run = async () => mock.commands.get("inspect")?.handler("", ctx);
  const stop = async () => mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  return { run, stop, server, notifications };
}

test.each([
  { name: "success", value: result(), launched: true },
  { name: "overflow", value: result({ code: 1, killed: true, truncated: true }), launched: false },
  { name: "incomplete success", value: result({ truncated: true }), launched: false },
  { name: "timeout", value: result({ killed: true }), launched: false },
  { name: "spawn failure", value: result({ code: 1, stderr: "spawn xdg-open ENOENT" }), launched: false },
])("browser launcher bounds output and handles $name", async ({ value, launched }) => {
  const execute = vi.fn<ExtensionAPI["exec"]>(async () => ({ ...value, stderr: "private diagnostic" }));
  const h = harness(execute);
  try {
    await h.run();
    assert.equal(execute.mock.calls.length, 1);
    const [command, args, options] = execute.mock.calls[0] ?? [];
    assert.equal(
      command,
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open",
    );
    assert.deepEqual(args, [h.server.url]);
    assert.equal(options?.timeout, 5_000);
    assert.equal(options?.maxBuffer, 16 * 1024);
    assert.equal(options?.signal?.aborted, false);
    assert.equal(h.notifications.length, 1);
    assert.equal(
      h.notifications[0]?.message.startsWith(launched ? "Session Inspector:" : "Browser unavailable; open privately:"),
      true,
    );
    assert.equal(h.notifications[0]?.message.includes("private diagnostic"), false);
  } finally {
    await h.stop();
  }
  assert.equal(h.server.close.mock.calls.length, 1);
  assert.equal(execute.mock.calls[0]?.[2]?.signal?.aborted, true);
});

test("browser launcher exceptions keep the private URL fallback", async () => {
  const h = harness(async () => {
    throw new Error("private spawn failure");
  });
  try {
    await h.run();
    assert.match(h.notifications[0]?.message ?? "", /^Browser unavailable; open privately:/u);
    assert.doesNotMatch(h.notifications[0]?.message ?? "", /spawn failure/u);
  } finally {
    await h.stop();
  }
});

test("shutdown aborts default browser execution and suppresses stale notifications", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let signal: AbortSignal | undefined;
  const h = harness(async (_command, _args, options) => {
    signal = options?.signal;
    assert.ok(signal);
    ready();
    return new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(result({ killed: true })), { once: true });
    });
  });
  const opening = h.run();
  await started;
  await h.stop();
  await opening;
  assert.equal(signal?.aborted, true);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.server.close.mock.calls.length, 1);
});
