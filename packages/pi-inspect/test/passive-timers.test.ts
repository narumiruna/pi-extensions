import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const directory = mkdtempSync(join(tmpdir(), "inspect-passive-timers-"));
vi.stubEnv("PI_CODING_AGENT_DIR", directory);
vi.resetModules();
const { SessionFeed } = await import("../src/feed.js");
const { Collector } = await import("../src/collector.js");
const { fixture, skills, tools } = await import("./fixtures.js");
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test("feed poll and rearmed notifications use unreferenced Node timers and abort clears both", () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const timeouts = vi.spyOn(globalThis, "setTimeout");
  const clearPoll = vi.spyOn(globalThis, "clearInterval");
  const clearNotification = vi.spyOn(globalThis, "clearTimeout");
  const f = fixture();
  const mock = createMockPi({ allTools: tools, activeTools: ["read"] });
  const context = createMockContext({ sessionManager: f.manager });
  const controller = new AbortController();
  const invalidate = vi.fn();
  const feed = new SessionFeed({
    pi: mock.pi,
    context: () => context.ctx,
    collector: new Collector(),
    skills,
    signal: controller.signal,
    generation: "passive-timers",
    invalidate,
  });
  try {
    expect(intervals).not.toHaveBeenCalled();
    expect(timeouts).not.toHaveBeenCalled();
    feed.start();
    feed.start();
    expect(intervals).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1000);
    const poll = intervals.mock.results[0]?.value as NodeJS.Timeout;
    expect(poll.hasRef()).toBe(false);

    f.manager.appendSessionInfo("Changed session");
    intervals.mock.calls[0]?.[0]();
    expect(timeouts).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 250);
    const first = timeouts.mock.results[0]?.value as NodeJS.Timeout;
    expect(first.hasRef()).toBe(false);
    feed.changed(false);
    expect(timeouts).toHaveBeenCalledTimes(1);

    // Dispatch the captured callback without waiting for wall-clock time.
    clearTimeout(first);
    timeouts.mock.calls[0]?.[0]();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(1);
    feed.changed(false);
    const second = timeouts.mock.results[1]?.value as NodeJS.Timeout;
    expect(second).not.toBe(first);
    expect(second.hasRef()).toBe(false);
    expect(poll.hasRef()).toBe(false);

    controller.abort();
    feed.close();
    expect(clearPoll).toHaveBeenCalledWith(poll);
    expect(clearNotification).toHaveBeenCalledWith(second);
    const count = timeouts.mock.calls.length;
    feed.changed(true);
    intervals.mock.calls[0]?.[0]();
    timeouts.mock.calls[1]?.[0]();
    expect(timeouts).toHaveBeenCalledTimes(count);
    expect(invalidate).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    feed.close();
    for (const result of intervals.mock.results) if (result.type === "return") clearInterval(result.value);
    for (const result of timeouts.mock.results) if (result.type === "return") clearTimeout(result.value);
    vi.restoreAllMocks();
  }
});
