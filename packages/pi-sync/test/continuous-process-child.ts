import "./engine-process-host.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { inspectSync } from "@narumitw/pi-sync-daemon/engine/sync/sync-inspection";
import { type ContinuousClock, createContinuousSync } from "../src/sync/continuous-sync.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { createEngineTestLoaders as createSyncLoaders } from "./engine-loaders.js";

// Drive only scheduler time. Real fetch and lock-renewal timers must not be faked.
let now = Date.now();
const timers = new Set<{ at: number; waiting: boolean; run(): void }>();
let wake: (() => void) | undefined;
const clock: ContinuousClock = {
  now: () => now,
  random: () => 0,
  schedule: (ms, run, kind) => {
    const timer = { at: now + ms, waiting: kind === "wait", run };
    timers.add(timer);
    if (timer.waiting) wake?.();
    return () => {
      timers.delete(timer);
    };
  },
};
const tick = (ms: number) => {
  now += ms;
  for (const timer of [...timers])
    if (timer.at <= now) {
      timers.delete(timer);
      timer.run();
    }
};
const context = agentContext(selectRemote, { cwd: getAgentDir() });
let checks = 0;
let inFlight = 0;
let ready = false;
const status = context.ctx.ui.setStatus.bind(context.ctx.ui);
context.ctx.ui.setStatus = (key, value) => {
  status(key, value);
  if (!ready && (value?.includes("waiting") || value?.includes("blocked") || value?.includes("retry scheduled"))) {
    ready = true;
    process.send?.({ event: "ready", status: value });
  }
};
const service = createContinuousSync(
  createSyncLoaders({
    loadSyncInspection: async () => ({
      inspectSync: async (...args) => {
        checks++;
        inFlight++;
        try {
          return await inspectSync(...args);
        } finally {
          inFlight--;
          wake?.();
        }
      },
    }),
    loadSyncOperations: async () => ({
      ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
      syncBoth: async (...args) => {
        inFlight++;
        try {
          return await syncBoth(...args);
        } finally {
          inFlight--;
          wake?.();
        }
      },
    }),
  }),
  clock,
);
async function waitForScheduler() {
  while (inFlight || ![...timers].some((timer) => timer.waiting)) {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }
}

let queue = Promise.resolve();
process.on("message", (value) => {
  queue = queue.then(async () => {
    const message = value as { id: number; command: "advance" | "state" | "stop"; ms?: number };
    try {
      if (message.command === "advance") {
        const end = now + (message.ms ?? 0);
        await waitForScheduler();
        while (now < end) {
          const next = Math.min(end, ...[...timers].map(({ at }) => at));
          tick(next - now);
          await waitForScheduler();
        }
      } else if (message.command === "stop") await service.stop();
      process.send?.({
        id: message.id,
        status: context.statuses.get("sync"),
        checks,
        requests: context.requests.length,
      });
      if (message.command === "stop") process.disconnect?.();
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) });
    }
  });
});
service.start(context.ctx, new AbortController().signal);
