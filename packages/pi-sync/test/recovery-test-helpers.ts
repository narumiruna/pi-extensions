import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { ContinuousClock } from "../src/sync/continuous-sync.js";
import { enableContinuous } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

/** Keep filesystem fixture creation outside the five-second operation test budget. */
export function recoveryFixture() {
  let current: {
    agentDir: string;
    f: Awaited<ReturnType<typeof createMergeFixture>>;
    config: Awaited<ReturnType<typeof enableContinuous>>;
  };
  let release: () => void;
  let home: Promise<void>;
  beforeAll(async () => {
    await import("../src/sync/agent-plan.js");
    await import("../src/sync/agent-store.js");
    await import("../src/sync/agent-runner.js");
    await import("../src/sync/sync-operations.js");
  });
  beforeEach(async () => {
    const ready = deferred();
    const stop = deferred();
    release = () => stop.resolve();
    home = withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      const config = await enableContinuous();
      current = { agentDir, f, config };
      ready.resolve();
      await stop.promise;
    });
    await Promise.race([ready.promise, home]);
  });
  afterEach(async () => {
    release();
    await home;
  });
  return () => current;
}

export class RecoveryClock implements ContinuousClock {
  value = Date.now();
  tasks = new Set<{ at: number; run(): void }>();
  now = () => this.value;
  random = () => 0;
  schedule = (ms: number, run: () => void) => {
    const task = { at: this.value + ms, run };
    this.tasks.add(task);
    return () => {
      this.tasks.delete(task);
    };
  };
  advance(ms: number) {
    this.value += ms;
    for (const task of [...this.tasks]) {
      if (task.at > this.value) continue;
      this.tasks.delete(task);
      task.run();
    }
  }
}

export async function waitRecoveryStatus(statuses: ReadonlyMap<string, string | undefined>, expected: RegExp) {
  await vi.waitFor(
    () => {
      if (!expected.test(statuses.get("sync") ?? ""))
        throw new Error(`Expected ${expected}; received ${statuses.get("sync")}`);
    },
    { timeout: 2500, interval: 5 },
  );
}
