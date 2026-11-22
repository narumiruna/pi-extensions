import { DAEMON_JOB_CAPACITY, record, validId } from "./protocol.js";

export const STATE_WAIT_FAILURE_LIMIT = 3;

export function stateWaitResult(reply: unknown) {
  if (
    !record(reply) ||
    typeof reply.stateRevision !== "string" ||
    !/^[0-9]{1,40}$/u.test(reply.stateRevision) ||
    !Array.isArray(reply.finished) ||
    !Array.isArray(reply.missing) ||
    !reply.finished.every(validId) ||
    !reply.missing.every(validId)
  )
    throw new Error("Invalid daemon state-wait response.");
  return { reply, version: reply.stateRevision, finished: reply.finished, missing: reply.missing };
}

export function stateWaitJobs<Waiter>(waiters: Map<string, Waiter>) {
  if (waiters.size <= DAEMON_JOB_CAPACITY) return [...waiters.keys()];
  const batch = [...waiters.entries()].slice(0, DAEMON_JOB_CAPACITY);
  return batch.map(([id, waiter]) => {
    waiters.delete(id);
    waiters.set(id, waiter);
    return id;
  });
}
