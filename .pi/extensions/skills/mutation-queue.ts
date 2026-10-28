// Serialize overlapping skill trees, including metadata edits. Pi's exact-file
// queue alone does not coordinate a file edit with a directory move or removal.
let tail: Promise<void> = Promise.resolve();

export function withSkillTreeQueue<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
