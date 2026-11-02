import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

const directory = mkdtempSync(join(tmpdir(), "ticker-passive-timers-"));
vi.stubEnv("PI_CODING_AGENT_DIR", directory);
vi.resetModules();
const { default: stockTicker, WIDGET_KEY } = await import("../src/ticker.js");
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

// Let the detached cycle's promise continuations finish without advancing timers.
const settleCycle = () => new Promise<void>((resolve) => setImmediate(resolve));

function quoteResponse(): Response {
  return {
    ok: true,
    json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 110, previousClose: 100 } }] } }),
  } as Response;
}

test("detached requests and every rearmed poll use unreferenced Node timers and shutdown cancels work", async () => {
  const timeouts = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const requests: Array<{ resolve(response: Response): void; signal: AbortSignal }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing request signal");
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        requests.push({
          signal,
          resolve(response) {
            signal.removeEventListener("abort", abort);
            resolve(response);
          },
        });
      });
    }),
  );
  const mock = createMockPi();
  const context = createMockContext({ mode: "rpc", cwd: directory });
  const emit = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
  };
  const timers = (delay: number) =>
    timeouts.mock.calls.flatMap((call, index) =>
      call[1] === delay ? [{ callback: call[0], handle: timeouts.mock.results[index]?.value as NodeJS.Timeout }] : [],
    );
  try {
    stockTicker(mock.pi, {
      loadSettings: async () => ({ settings: { symbols: ["NVDA"], widgetEnabled: true } }),
    });
    expect(timeouts).not.toHaveBeenCalled();
    await emit("session_start");
    const requestTimeout = timers(10_000)[0];
    expect(requestTimeout).toBeDefined();
    expect(requestTimeout?.handle.hasRef()).toBe(false);
    expect(requests).toHaveLength(1);

    requests[0]?.resolve(quoteResponse());
    await settleCycle();
    expect(clear).toHaveBeenCalledWith(requestTimeout?.handle);
    const firstPoll = timers(30_000)[0];
    expect(firstPoll).toBeDefined();
    expect(firstPoll?.handle.hasRef()).toBe(false);

    clearTimeout(firstPoll?.handle);
    firstPoll?.callback();
    expect(timers(10_000)[1]?.handle.hasRef()).toBe(false);
    expect(requests).toHaveLength(2);
    requests[1]?.resolve(quoteResponse());
    await settleCycle();
    const secondPoll = timers(30_000)[1];
    expect(secondPoll).toBeDefined();
    expect(secondPoll?.handle).not.toBe(firstPoll?.handle);
    expect(secondPoll?.handle.hasRef()).toBe(false);

    await emit("session_shutdown");
    expect(clear).toHaveBeenCalledWith(secondPoll?.handle);
    expect(context.widgets.get(WIDGET_KEY)).toBeUndefined();
    secondPoll?.callback();
    expect(requests).toHaveLength(2);

    await emit("session_start");
    const pendingTimeout = timers(10_000)[2];
    expect(pendingTimeout?.handle.hasRef()).toBe(false);
    expect(requests).toHaveLength(3);
    await emit("session_shutdown");
    await settleCycle();
    await emit("session_shutdown");
    expect(requests[2]?.signal.aborted).toBe(true);
    expect(clear).toHaveBeenCalledWith(secondPoll?.handle);
    expect(clear).toHaveBeenCalledWith(pendingTimeout?.handle);
    expect(context.widgets.get(WIDGET_KEY)).toBeUndefined();
    expect(timers(30_000)).toHaveLength(2);
    expect(timers(10_000)).toHaveLength(3);
  } finally {
    await emit("session_shutdown");
    await settleCycle();
    for (const result of timeouts.mock.results) if (result.type === "return") clearTimeout(result.value);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
