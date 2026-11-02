import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const directory = mkdtempSync(join(tmpdir(), "github-pr-passive-timers-"));
vi.stubEnv("PI_CODING_AGENT_DIR", directory);
vi.stubEnv("GH_HOST", undefined);
vi.resetModules();
const { default: githubPr } = await import("../src/github-pr.js");
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test.each(["CLOSED", "MERGED"])("%s expiry and its replacements use unreferenced Node timers", async (state) => {
  const now = 1_800_000_000_000;
  const hour = 60 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const timeouts = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const mock = createMockPi();
  const terminalAt = new Date(now - 23 * hour).toISOString();
  Object.assign(mock.rawPi, {
    exec: vi.fn(async (command: string, args: string[]) => {
      if (command === "git") return { stdout: "", stderr: "not a repository", code: 128, killed: false };
      const payload =
        args[0] === "pr"
          ? {
              number: 123,
              url: "https://github.com/narumiruna/pi-extensions/pull/123",
              state,
              closedAt: terminalAt,
              mergedAt: state === "MERGED" ? terminalAt : null,
            }
          : { data: { repository: { pullRequest: { comments: { totalCount: 0 }, reviews: { totalCount: 0 } } } } };
      return { stdout: JSON.stringify(payload), stderr: "", code: 0, killed: false };
    }),
  });
  const context = createMockContext({ mode: "tui", cwd: directory });
  const emit = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
  };
  const expiries = () =>
    timeouts.mock.calls.flatMap((call, index) =>
      call[1] === hour ? [{ callback: call[0], handle: timeouts.mock.results[index]?.value as NodeJS.Timeout }] : [],
    );
  try {
    githubPr(mock.pi);
    expect(timeouts).not.toHaveBeenCalled();
    await emit("session_start");
    // Initialization uses only the resolved exec fixture; drain its detached continuation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const first = expiries()[0];
    expect(first).toBeDefined();
    expect(first?.handle.hasRef()).toBe(false);
    expect(context.statuses.get("github-pr")).toContain("#123");

    await emit("agent_end");
    const second = expiries()[1];
    expect(second).toBeDefined();
    expect(second?.handle).not.toBe(first?.handle);
    expect(second?.handle.hasRef()).toBe(false);
    expect(clear).toHaveBeenCalledWith(first?.handle);

    clearTimeout(second?.handle);
    second?.callback();
    expect(context.statuses.get("github-pr")).toBeUndefined();
    await emit("agent_end");
    const third = expiries()[2];
    expect(third?.handle.hasRef()).toBe(false);
    expect(context.statuses.get("github-pr")).toContain("#123");
    await emit("session_shutdown");
    await emit("session_shutdown");
    expect(clear).toHaveBeenCalledWith(third?.handle);
    expect(context.statuses.get("github-pr")).toBeUndefined();
    const count = timeouts.mock.calls.length;
    await emit("agent_end");
    expect(timeouts).toHaveBeenCalledTimes(count);
  } finally {
    await emit("session_shutdown");
    for (const result of timeouts.mock.results) if (result.type === "return") clearTimeout(result.value);
    vi.restoreAllMocks();
  }
});
