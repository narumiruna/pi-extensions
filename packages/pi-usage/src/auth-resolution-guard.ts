import { abortError } from "./core.js";

export interface UsageAuthLifecycle {
  signal?: AbortSignal;
  checkCurrent?: () => void;
}

/** Stop owned auth continuations without cancelling a Pi-owned token rotation. */
export function createUsageAuthGuard(lifecycle: UsageAuthLifecycle = {}) {
  const check = () => {
    if (lifecycle.signal?.aborted) throw abortError();
    lifecycle.checkCurrent?.();
  };
  return {
    check,
    async wait<T>(operation: () => T | Promise<T>): Promise<T> {
      check();
      let onAbort: (() => void) | undefined;
      const pending = Promise.resolve().then(() => {
        check();
        return operation();
      });
      try {
        const result = lifecycle.signal
          ? await Promise.race([
              pending,
              new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(abortError());
                lifecycle.signal?.addEventListener("abort", onAbort, { once: true });
              }),
            ])
          : await pending;
        check();
        return result;
      } catch (error) {
        check();
        throw error;
      } finally {
        if (onAbort) lifecycle.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
