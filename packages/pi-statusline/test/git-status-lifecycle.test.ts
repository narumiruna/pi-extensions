import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const directory = mkdtempSync(join(tmpdir(), "statusline-bounded-git-"));
vi.stubEnv("PI_CODING_AGENT_DIR", directory);
vi.resetModules();
const { default: statusline } = await import("../src/statusline.js");
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const success = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false, truncated: false });
type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

async function emit(mock: Mock, name: string, context: Context) {
  for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
}

function mountFooter(context: Context) {
  const requestRender = vi.fn();
  const unsubscribe = vi.fn();
  const footer = (context.footer as FooterFactory)(
    { requestRender } as never,
    { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: () => unsubscribe,
    },
  );
  return { footer, requestRender, unsubscribe, render: () => footer.render(500).join("\n") };
}

function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

test.each([
  { code: 1, killed: true },
  { code: 0, killed: false },
])("a current truncated Git status (%j) clears cached counts and polling can recover", async (fixture) => {
  fakeTimers();
  const mock = createMockPi();
  let statusCalls = 0;
  const exec: ExtensionAPI["exec"] = async (_command, args) => {
    if (args[0] === "rev-parse") return success(`${directory}\n`);
    statusCalls += 1;
    if (statusCalls === 2) {
      return { stdout: "## main\n?? incomplete.ts\n", stderr: "warning", ...fixture, truncated: true };
    }
    return success(statusCalls === 1 ? "## main\n M previous.ts\n" : "## main\n?? current.ts\n");
  };
  Object.assign(mock.rawPi, { exec });
  statusline(mock.pi);
  const context = createMockContext({ mode: "tui", cwd: directory });
  await emit(mock, "session_start", context);
  const mounted = mountFooter(context);
  try {
    await vi.advanceTimersByTimeAsync(0);
    assert.match(mounted.render(), /~1/u);

    await emit(mock, "turn_end", context);
    await emit(mock, "agent_end", context);
    await vi.advanceTimersByTimeAsync(249);
    assert.equal(statusCalls, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(statusCalls, 2);
    assert.doesNotMatch(mounted.render(), /~1|\?1/u);
    assert.ok(mounted.requestRender.mock.calls.length > 0);
    assert.deepEqual(context.notifications, []);

    await vi.advanceTimersByTimeAsync(29_750);
    assert.equal(statusCalls, 3);
    assert.match(mounted.render(), /\?1/u);
    assert.doesNotMatch(mounted.render(), /~1/u);

    mounted.footer.dispose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(statusCalls, 3);
    assert.equal(mounted.unsubscribe.mock.calls.length, 1);
  } finally {
    await emit(mock, "session_shutdown", context);
  }
});

test("a replaced session's truncated response cannot publish stale counts or disrupt the replacement", async () => {
  fakeTimers();
  const mock = createMockPi();
  let finishOld!: (result: ExecResult) => void;
  const oldResult = new Promise<ExecResult>((resolve) => {
    finishOld = resolve;
  });
  let oldSignal: AbortSignal | undefined;
  let statusCalls = 0;
  const exec: ExtensionAPI["exec"] = async (_command, args, options) => {
    if (args[0] === "rev-parse") return success(`${directory}\n`);
    statusCalls += 1;
    if (statusCalls === 1) {
      oldSignal = options?.signal;
      return oldResult;
    }
    return success("## main\n?? current.ts\n");
  };
  Object.assign(mock.rawPi, { exec });
  statusline(mock.pi);
  const previous = createMockContext({ mode: "tui", cwd: directory });
  const current = createMockContext({ mode: "tui", cwd: directory });
  await emit(mock, "session_start", previous);
  const oldFooter = mountFooter(previous);
  let currentFooter: ReturnType<typeof mountFooter> | undefined;
  try {
    assert.ok(oldSignal);
    await emit(mock, "session_start", current);
    currentFooter = mountFooter(current);
    oldFooter.footer.dispose?.();
    assert.equal(oldSignal.aborted, true);
    assert.equal(statusCalls, 1);

    finishOld({ stdout: "## main\n M stale.ts\n", stderr: "", code: 0, killed: false, truncated: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(statusCalls, 2);
    assert.match(currentFooter.render(), /\?1/u);
    assert.doesNotMatch(currentFooter.render(), /~1/u);

    await emit(mock, "session_shutdown", previous);
    await emit(mock, "tool_execution_end", previous);
    await vi.advanceTimersByTimeAsync(250);
    assert.equal(statusCalls, 2);
    assert.match(currentFooter.render(), /\?1/u);
    await vi.advanceTimersByTimeAsync(29_750);
    assert.equal(statusCalls, 3);
  } finally {
    finishOld(success("## main\n"));
    oldFooter.footer.dispose?.();
    currentFooter?.footer.dispose?.();
    await emit(mock, "session_shutdown", current);
  }
});

test.each(["footer disposal", "session shutdown"])(
  "%s aborts both probes and ignores a late truncated response",
  async (cleanup) => {
    fakeTimers();
    const mock = createMockPi();
    let finish!: (result: ExecResult) => void;
    const pending = new Promise<ExecResult>((resolve) => {
      finish = resolve;
    });
    const signals: Array<AbortSignal | undefined> = [];
    let statusCalls = 0;
    const exec: ExtensionAPI["exec"] = async (_command, args, options) => {
      signals.push(options?.signal);
      if (args[0] === "rev-parse") return success(`${directory}\n`);
      statusCalls += 1;
      return pending;
    };
    Object.assign(mock.rawPi, { exec });
    statusline(mock.pi);
    const context = createMockContext({ mode: "tui", cwd: directory });
    await emit(mock, "session_start", context);
    const mounted = mountFooter(context);
    try {
      assert.ok(signals[0]);
      assert.equal(signals[0], signals[1]);
      await emit(mock, "turn_end", context);
      await vi.advanceTimersByTimeAsync(250);
      assert.equal(statusCalls, 1);

      if (cleanup === "footer disposal") mounted.footer.dispose?.();
      else {
        await emit(mock, "session_shutdown", context);
        assert.equal(signals[0].aborted, true);
        // Pi disposes the mounted footer when setFooter(undefined) is called; the context mock does not.
        mounted.footer.dispose?.();
      }
      assert.equal(signals[0].aborted, true);
      const rendersAtCleanup = mounted.requestRender.mock.calls.length;
      finish({ stdout: "## main\n M incomplete.ts\n", stderr: "", code: 0, killed: false, truncated: true });
      await vi.advanceTimersByTimeAsync(30_000);
      assert.equal(statusCalls, 1);
      assert.equal(mounted.requestRender.mock.calls.length, rendersAtCleanup);
      assert.deepEqual(context.notifications, []);
    } finally {
      finish(success("## main\n"));
      mounted.footer.dispose?.();
      await emit(mock, "session_shutdown", context);
    }
  },
);
