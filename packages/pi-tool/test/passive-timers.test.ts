import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const directory = mkdtempSync(join(tmpdir(), "tool-passive-timers-"));
vi.stubEnv("PI_CODING_AGENT_DIR", directory);
vi.resetModules();
const { ACTIVE_TOOL_WIDGET_KEY, createActiveToolStatusController } = await import("../src/active-tool-status.js");
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test("active-tool refresh stays unreferenced after re-enabling and session replacement", () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const mock = createMockPi({ activeTools: ["read", "bash"] });
  const current = createMockContext({ mode: "rpc" });
  const replacement = createMockContext({ mode: "rpc" });
  const controller = createActiveToolStatusController(mock.pi);
  const latestTimer = () => intervals.mock.results.at(-1)?.value as NodeJS.Timeout;
  try {
    expect(intervals).not.toHaveBeenCalled();
    controller.start(current.ctx, true);
    expect(intervals).toHaveBeenLastCalledWith(expect.any(Function), 500);
    const first = latestTimer();
    expect(first.hasRef()).toBe(false);

    mock.rawPi.setActiveTools(["read"]);
    intervals.mock.calls[0]?.[0]();
    expect(current.widgets.get(ACTIVE_TOOL_WIDGET_KEY)).toEqual(["Tools (1)", "Built-in (1): read"]);
    expect(first.hasRef()).toBe(false);
    controller.setEnabled(current.ctx, false);
    expect(clear).toHaveBeenCalledWith(first);
    expect(current.widgets.get(ACTIVE_TOOL_WIDGET_KEY)).toBeUndefined();

    controller.setEnabled(current.ctx, true);
    const second = latestTimer();
    expect(second).not.toBe(first);
    expect(second.hasRef()).toBe(false);
    controller.start(replacement.ctx, true);
    const third = latestTimer();
    expect(third).not.toBe(second);
    expect(third.hasRef()).toBe(false);
    expect(clear).toHaveBeenCalledWith(second);
    expect(current.widgets.get(ACTIVE_TOOL_WIDGET_KEY)).toBeUndefined();

    controller.shutdown(current.ctx);
    expect(clear).not.toHaveBeenCalledWith(third);
    controller.shutdown(replacement.ctx);
    controller.shutdown(replacement.ctx);
    expect(clear).toHaveBeenCalledWith(third);
    expect(replacement.widgets.get(ACTIVE_TOOL_WIDGET_KEY)).toBeUndefined();
    expect(intervals).toHaveBeenCalledTimes(3);
  } finally {
    controller.shutdown(replacement.ctx);
    controller.shutdown(current.ctx);
    for (const result of intervals.mock.results) if (result.type === "return") clearInterval(result.value);
    vi.restoreAllMocks();
  }
});
