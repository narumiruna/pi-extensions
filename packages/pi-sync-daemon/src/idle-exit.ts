export const IDLE_EXIT_GRACE_MS = 30_000;
export type IdleExitPolicy = "exit" | "keep" | "pause";

interface IdleExitHooks {
  live(): boolean;
  policy(): Promise<IdleExitPolicy>;
  quiesce(): Promise<void>;
  close(current: () => boolean): Promise<boolean>;
  resume(): void;
  failed(): void;
}

/** The server heartbeat owns timing; this controller owns only one guarded deadline and evaluation. */
export function createIdleExit(hooks: IdleExitHooks) {
  let generation = 0;
  let stopped = false;
  let failed = false;
  let emptySince: number | undefined;
  let running: Promise<void> | undefined;

  const changed = () => {
    generation++;
    if (hooks.live()) emptySince = undefined;
  };
  async function evaluate() {
    if (stopped || failed) return;
    if (hooks.live()) {
      emptySince = undefined;
      return;
    }
    const epoch = generation;
    const current = () => !stopped && !failed && generation === epoch && !hooks.live();
    let quiesced = false;
    try {
      const policy = await hooks.policy();
      if (!current()) return;
      if (policy !== "exit") {
        emptySince = undefined;
        return;
      }
      emptySince ??= Date.now();
      if (Date.now() - emptySince < IDLE_EXIT_GRACE_MS) return;
      quiesced = true;
      await hooks.quiesce();
      if (!current()) return;
      const latest = await hooks.policy();
      if (!current()) return;
      if (latest !== "exit") {
        emptySince = undefined;
        return;
      }
      if (await hooks.close(current)) stopped = true;
      else if (hooks.live()) emptySince = undefined;
    } catch {
      // A failed drain must not be cleared by an implicit restart or another heartbeat.
      failed = true;
      hooks.failed();
    } finally {
      if (quiesced && !stopped && !failed) hooks.resume();
    }
  }
  return {
    changed,
    tick(): Promise<void> {
      if (!running) {
        running = evaluate().finally(() => {
          running = undefined;
        });
      }
      return running;
    },
    async dispose() {
      stopped = true;
      generation++;
      await running;
    },
  };
}
