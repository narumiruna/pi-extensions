import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const directory = mkdtempSync(join(tmpdir(), "statusline-passive-timers-"));
vi.stubEnv("PI_CODING_AGENT_DIR", directory);
vi.resetModules();
const { default: statusline } = await import("../src/statusline.js");
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test("footer clock and replacement Git debounces use unreferenced Node timers and retain cleanup", async () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const timeouts = vi.spyOn(globalThis, "setTimeout");
  const clearClock = vi.spyOn(globalThis, "clearInterval");
  const clearDebounce = vi.spyOn(globalThis, "clearTimeout");
  const mock = createMockPi();
  const context = createMockContext({ mode: "tui", cwd: directory });
  const emit = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
  };
  type Factory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
  let footer: ReturnType<Factory> | undefined;
  const unsubscribe = vi.fn();
  try {
    statusline(mock.pi);
    expect(intervals).not.toHaveBeenCalled();
    expect(timeouts).not.toHaveBeenCalled();
    await emit("session_start");
    footer = (context.footer as Factory)(
      { requestRender() {} } as never,
      { fg: (_role: string, text: string) => text, bold: (text: string) => text } as never,
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 0,
        onBranchChange: () => unsubscribe,
      },
    );
    const clockIndex = intervals.mock.calls.findIndex(([, delay]) => delay === 30_000);
    expect(clockIndex).toBeGreaterThanOrEqual(0);
    const clock = intervals.mock.results[clockIndex]?.value as NodeJS.Timeout;
    expect(clock.hasRef()).toBe(false);

    await emit("turn_end");
    const firstIndex = timeouts.mock.calls.findIndex(([, delay]) => delay === 250);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    const first = timeouts.mock.results[firstIndex]?.value as NodeJS.Timeout;
    expect(first.hasRef()).toBe(false);
    await emit("agent_end");
    const second = timeouts.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(second).not.toBe(first);
    expect(second.hasRef()).toBe(false);
    expect(clearDebounce).toHaveBeenCalledWith(first);

    footer.dispose?.();
    footer = undefined;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearClock).toHaveBeenCalledWith(clock);
    expect(clearDebounce).toHaveBeenCalledWith(second);
    await emit("session_shutdown");
    await emit("session_shutdown");
    const timerCount = timeouts.mock.calls.length;
    await emit("turn_end");
    expect(timeouts).toHaveBeenCalledTimes(timerCount);
  } finally {
    footer?.dispose?.();
    await emit("session_shutdown");
    for (const result of intervals.mock.results) if (result.type === "return") clearInterval(result.value);
    for (const result of timeouts.mock.results) if (result.type === "return") clearTimeout(result.value);
    vi.restoreAllMocks();
  }
});
