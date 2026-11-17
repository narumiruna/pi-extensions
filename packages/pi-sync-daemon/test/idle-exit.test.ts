import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleExit, IDLE_EXIT_GRACE_MS, type IdleExitPolicy } from "../src/idle-exit.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture() {
  const state = { live: false, policy: "exit" as IdleExitPolicy };
  const hooks = {
    live: vi.fn(() => state.live),
    policy: vi.fn(async (): Promise<IdleExitPolicy> => state.policy),
    quiesce: vi.fn(async () => {}),
    close: vi.fn(async (current: () => boolean) => current()),
    resume: vi.fn(),
    failed: vi.fn(),
  };
  const controller = createIdleExit(hooks);
  return { state, hooks, controller };
}

type Fixture = ReturnType<typeof fixture>;

async function reachDeadline({ controller, hooks }: Fixture) {
  await controller.tick();
  expect(hooks.quiesce).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + IDLE_EXIT_GRACE_MS);
}

describe("idle exit controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a no-client deadline and closes only at the exact 30-second boundary", async () => {
    const f = fixture();
    expect(IDLE_EXIT_GRACE_MS).toBe(30_000);
    expect(f.hooks.policy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await f.controller.tick();
    vi.setSystemTime(IDLE_EXIT_GRACE_MS - 1);
    await f.controller.tick();
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    expect(f.hooks.close).not.toHaveBeenCalled();
    vi.setSystemTime(IDLE_EXIT_GRACE_MS);
    await f.controller.tick();
    expect(f.hooks.quiesce).toHaveBeenCalledTimes(1);
    expect(f.hooks.close).toHaveBeenCalledTimes(1);
    expect(f.hooks.resume).not.toHaveBeenCalled();
    expect(f.hooks.failed).not.toHaveBeenCalled();
    await f.controller.tick();
    expect(f.hooks.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.controller.dispose();
  });

  it("blocks on the live PID predicate and starts a fresh grace after the PID exits", async () => {
    const f = fixture();
    await f.controller.tick();
    vi.setSystemTime(IDLE_EXIT_GRACE_MS - 1);
    f.state.live = true;
    f.controller.changed();
    vi.setSystemTime(IDLE_EXIT_GRACE_MS * 3);
    await f.controller.tick();
    expect(f.hooks.policy).toHaveBeenCalledTimes(1);
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    f.state.live = false;
    f.controller.changed();
    await reachDeadline(f);
    vi.setSystemTime(Date.now() - 1);
    await f.controller.tick();
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    await f.controller.tick();
    expect(f.hooks.close).toHaveBeenCalledTimes(1);
    await f.controller.dispose();
  });

  it.each(["keep", "pause"] as const)("%s policy resets an existing deadline", async (policy) => {
    const f = fixture();
    await f.controller.tick();
    vi.setSystemTime(IDLE_EXIT_GRACE_MS - 1);
    f.state.policy = policy;
    await f.controller.tick();
    vi.setSystemTime(IDLE_EXIT_GRACE_MS * 2);
    await f.controller.tick();
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    f.state.policy = "exit";
    await reachDeadline(f);
    vi.setSystemTime(Date.now() - 1);
    await f.controller.tick();
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    await f.controller.tick();
    expect(f.hooks.close).toHaveBeenCalledTimes(1);
    await f.controller.dispose();
  });

  it("coalesces concurrent ticks while policy and drain work are pending", async () => {
    const f = fixture();
    await reachDeadline(f);
    const policyEntered = deferred<void>();
    const policy = deferred<IdleExitPolicy>();
    const drainEntered = deferred<void>();
    const drain = deferred<void>();
    f.hooks.policy.mockImplementationOnce(() => {
      policyEntered.resolve();
      return policy.promise;
    });
    f.hooks.quiesce.mockImplementationOnce(() => {
      drainEntered.resolve();
      return drain.promise;
    });
    const pending = f.controller.tick();
    await policyEntered.promise;
    expect(f.controller.tick()).toBe(pending);
    expect(f.controller.tick()).toBe(pending);
    expect(f.hooks.policy).toHaveBeenCalledTimes(2);
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    policy.resolve("exit");
    await drainEntered.promise;
    expect(f.controller.tick()).toBe(pending);
    expect(f.hooks.quiesce).toHaveBeenCalledTimes(1);
    drain.resolve();
    await pending;
    expect(f.hooks.policy).toHaveBeenCalledTimes(3);
    expect(f.hooks.close).toHaveBeenCalledTimes(1);
    await f.controller.dispose();
  });

  it.each(["generation", "live"] as const)("rejects stale deferred policy after %s changes", async (change) => {
    const f = fixture();
    await reachDeadline(f);
    const entered = deferred<void>();
    const policy = deferred<IdleExitPolicy>();
    f.hooks.policy.mockImplementationOnce(() => {
      entered.resolve();
      return policy.promise;
    });
    const pending = f.controller.tick();
    await entered.promise;
    if (change === "live") f.state.live = true;
    // Test generation invalidation separately from the live predicate.
    if (change === "generation") f.controller.changed();
    policy.resolve("exit");
    await pending;
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    expect(f.hooks.close).not.toHaveBeenCalled();
    expect(f.hooks.resume).not.toHaveBeenCalled();
    await f.controller.dispose();
  });

  it.each(["generation", "live"] as const)("cancels a deferred drain after %s changes", async (change) => {
    const f = fixture();
    await reachDeadline(f);
    const entered = deferred<void>();
    const drain = deferred<void>();
    f.hooks.quiesce.mockImplementationOnce(() => {
      entered.resolve();
      return drain.promise;
    });
    const pending = f.controller.tick();
    await entered.promise;
    if (change === "live") f.state.live = true;
    if (change === "generation") f.controller.changed();
    drain.resolve();
    await pending;
    expect(f.hooks.policy).toHaveBeenCalledTimes(2);
    expect(f.hooks.close).not.toHaveBeenCalled();
    expect(f.hooks.resume).toHaveBeenCalledTimes(1);
    expect(f.hooks.failed).not.toHaveBeenCalled();
    await f.controller.dispose();
  });

  it.each(["keep", "pause"] as const)("rechecks %s policy after drain and cancels closing", async (policy) => {
    const f = fixture();
    await reachDeadline(f);
    const entered = deferred<void>();
    const drain = deferred<void>();
    f.hooks.quiesce.mockImplementationOnce(() => {
      entered.resolve();
      return drain.promise;
    });
    const pending = f.controller.tick();
    await entered.promise;
    f.state.policy = policy;
    drain.resolve();
    await pending;
    expect(f.hooks.close).not.toHaveBeenCalled();
    expect(f.hooks.resume).toHaveBeenCalledTimes(1);
    f.state.policy = "exit";
    await f.controller.tick();
    vi.setSystemTime(Date.now() + IDLE_EXIT_GRACE_MS - 1);
    await f.controller.tick();
    expect(f.hooks.quiesce).toHaveBeenCalledTimes(1);
    await f.controller.dispose();
  });

  it.each(["generation", "live"] as const)("revalidates %s after the final deferred policy read", async (change) => {
    const f = fixture();
    await reachDeadline(f);
    const entered = deferred<void>();
    const policy = deferred<IdleExitPolicy>();
    f.hooks.policy.mockResolvedValueOnce("exit").mockImplementationOnce(() => {
      entered.resolve();
      return policy.promise;
    });
    const pending = f.controller.tick();
    await entered.promise;
    if (change === "live") f.state.live = true;
    f.controller.changed();
    policy.resolve("exit");
    await pending;
    expect(f.hooks.quiesce).toHaveBeenCalledTimes(1);
    expect(f.hooks.close).not.toHaveBeenCalled();
    expect(f.hooks.resume).toHaveBeenCalledTimes(1);
    await f.controller.dispose();
  });

  it("honors final fence refusal and resumes without marking the owner stopped", async () => {
    const f = fixture();
    await reachDeadline(f);
    const fences: boolean[] = [];
    f.hooks.close.mockImplementationOnce(async (current) => {
      fences.push(current());
      f.state.live = true;
      f.controller.changed();
      fences.push(current());
      return false;
    });
    await f.controller.tick();
    expect(fences).toEqual([true, false]);
    expect(f.hooks.resume).toHaveBeenCalledTimes(1);
    f.state.live = false;
    f.controller.changed();
    await f.controller.tick();
    expect(f.hooks.quiesce).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + IDLE_EXIT_GRACE_MS);
    await f.controller.tick();
    expect(f.hooks.close).toHaveBeenCalledTimes(2);
    await f.controller.dispose();
  });

  it("latches a failed drain, reports failure once, and never resumes", async () => {
    const f = fixture();
    await reachDeadline(f);
    f.hooks.quiesce.mockRejectedValueOnce(new Error("drain failed"));
    await f.controller.tick();
    f.controller.changed();
    vi.setSystemTime(Date.now() + IDLE_EXIT_GRACE_MS);
    await Promise.all([f.controller.tick(), f.controller.tick()]);
    expect(f.hooks.quiesce).toHaveBeenCalledTimes(1);
    expect(f.hooks.policy).toHaveBeenCalledTimes(2);
    expect(f.hooks.failed).toHaveBeenCalledTimes(1);
    expect(f.hooks.close).not.toHaveBeenCalled();
    expect(f.hooks.resume).not.toHaveBeenCalled();
    await f.controller.dispose();
    await f.controller.dispose();
    expect(f.hooks.failed).toHaveBeenCalledTimes(1);
  });

  it("allows repeated disposal before the first heartbeat without starting work", async () => {
    const f = fixture();
    await f.controller.dispose();
    await f.controller.dispose();
    f.controller.changed();
    vi.setSystemTime(IDLE_EXIT_GRACE_MS * 2);
    await f.controller.tick();
    expect(f.hooks.policy).not.toHaveBeenCalled();
    expect(f.hooks.quiesce).not.toHaveBeenCalled();
    expect(f.hooks.close).not.toHaveBeenCalled();
    expect(f.hooks.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["policy", "quiesce", "final policy"] as const)(
    "disposal during deferred %s prevents close and resume",
    async (phase) => {
      const f = fixture();
      await reachDeadline(f);
      const entered = deferred<void>();
      const release = deferred<void>();
      const blockedPolicy = async (): Promise<IdleExitPolicy> => {
        entered.resolve();
        await release.promise;
        return "exit";
      };
      if (phase === "policy") f.hooks.policy.mockImplementationOnce(blockedPolicy);
      if (phase === "final policy") {
        f.hooks.policy.mockResolvedValueOnce("exit").mockImplementationOnce(blockedPolicy);
      }
      if (phase === "quiesce") {
        f.hooks.quiesce.mockImplementationOnce(() => {
          entered.resolve();
          return release.promise;
        });
      }
      const pending = f.controller.tick();
      await entered.promise;
      const disposal = f.controller.dispose();
      const repeated = f.controller.dispose();
      release.resolve();
      await Promise.all([pending, disposal, repeated]);
      await f.controller.tick();
      expect(f.hooks.close).not.toHaveBeenCalled();
      expect(f.hooks.resume).not.toHaveBeenCalled();
      expect(f.hooks.failed).not.toHaveBeenCalled();
      expect(f.hooks.quiesce).toHaveBeenCalledTimes(phase === "policy" ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
