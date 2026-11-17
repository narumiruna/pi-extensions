/** Complete cleanup without hiding the primary failure or treating cleanup failure as success. */
export async function withCleanup<T>(action: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    result = { ok: true, value: await action() };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await cleanup();
  } catch (error) {
    if (!result.ok)
      throw new AggregateError([result.error, error], "Operation and cleanup both failed; recovery evidence retained.");
    throw error;
  }
  if (!result.ok) throw result.error;
  return result.value;
}
