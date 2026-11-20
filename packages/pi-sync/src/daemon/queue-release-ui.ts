import type { ConnectionOptions } from "@narumitw/pi-sync-daemon";

export type QueueReleaseEvent = Parameters<NonNullable<ConnectionOptions["queueRelease"]>>[0];
type ClearStatus = (redraw?: boolean) => void;

/** Session-owned presentation only; it neither controls delivery nor infers a job's outcome. */
export function createQueueReleaseUI(show: () => ClearStatus | undefined, warn: () => void) {
  const retries = new Map<string, { job: string; foreground: boolean }>();
  const handledJobs = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clearStatus: ClearStatus | undefined;

  function remember(job: string) {
    if (handledJobs.has(job)) return false;
    if (handledJobs.size >= 128) {
      const oldest = handledJobs.values().next();
      if (!oldest.done) handledJobs.delete(oldest.value);
    }
    handledJobs.add(job);
    return true;
  }
  function clearPresentation(redraw: boolean) {
    clearTimeout(timer);
    timer = undefined;
    const release = clearStatus;
    clearStatus = undefined;
    release?.(redraw);
  }

  return {
    get retrying() {
      return retries.size > 0;
    },
    observe({ id, job, state, foreground }: QueueReleaseEvent, commandBusy: boolean, cancelled: boolean) {
      if (state === "retrying") {
        if (foreground && cancelled) {
          remember(job);
          return;
        }
        if (retries.has(id)) return;
        retries.set(id, { job, foreground });
        if (retries.size !== 1) return;
        timer = setTimeout(() => {
          timer = undefined;
          const release = show();
          if (retries.size) clearStatus = release;
          else release?.(false); // Presentation may have synchronously reentered lifecycle cleanup.
        }, 2_000);
        timer.unref?.();
        return;
      }
      const retry = retries.get(id);
      retries.delete(id);
      if (!retries.size) clearPresentation(true);
      if (state === "unconfirmed" && remember(job) && !foreground && !retry?.foreground && !commandBusy) warn();
    },
    finishForeground(redraw: boolean) {
      for (const [id, { job, foreground }] of retries) {
        if (!foreground) continue;
        retries.delete(id);
        remember(job); // Late observations of this job should not duplicate its command result.
      }
      if (!retries.size) clearPresentation(redraw);
    },
    clear(redraw: boolean) {
      retries.clear();
      handledJobs.clear();
      clearPresentation(redraw);
    },
  };
}
