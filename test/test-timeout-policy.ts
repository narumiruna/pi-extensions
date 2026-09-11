export const maximumTestTimeoutMs = 5_000;

export type TimeoutTask = {
  name: string;
  type: string;
  timeout?: number;
  tasks?: readonly TimeoutTask[];
};

export function assertTestTasksWithinCap(tasks: readonly TimeoutTask[]): void {
  for (const task of tasks) {
    if (task.type === "test") {
      assertTestTimeoutWithinCap(task.timeout, task.name);
    }
    if (task.tasks) assertTestTasksWithinCap(task.tasks);
  }
}

export function assertTestTimeoutWithinCap(timeoutMs: number | undefined, testName: string): void {
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= maximumTestTimeoutMs) {
    return;
  }
  throw new Error(
    `Test ${JSON.stringify(testName)} has a ${timeoutMs} ms timeout; the maximum is ${maximumTestTimeoutMs} ms`,
  );
}
