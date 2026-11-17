import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, type Stats, writeSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 8192;
type Phase = "starting" | "ready" | "drained" | "failed";
/** Bounded lifecycle facts only: never log payloads, credentials, provider output, or exception text. */
export function openLifecycleLog(directory: string) {
  const parent = lstatSync(directory);
  const privateOwner = (value: Stats) =>
    (!process.getuid || value.uid === process.getuid()) && (process.platform === "win32" || (value.mode & 0o077) === 0);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !privateOwner(parent))
    throw new Error("Unsafe lifecycle log directory.");
  const target = path.join(directory, "lifecycle.log");
  const handle = openSync(
    target,
    constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let closed = false;
  const validate = () => {
    const current = lstatSync(target);
    const opened = fstatSync(handle);
    const owner = lstatSync(directory);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !privateOwner(current) ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      owner.dev !== parent.dev ||
      owner.ino !== parent.ino ||
      owner.isSymbolicLink() ||
      !privateOwner(owner) ||
      current.size > MAX_BYTES
    )
      throw new Error("Lifecycle log ownership changed; unknown evidence retained.");
    return opened.size;
  };
  try {
    validate();
  } catch (error) {
    closeSync(handle);
    throw error;
  }
  return {
    write(phase: Phase) {
      if (closed) return;
      const line = `${JSON.stringify({ time: new Date().toISOString(), phase })}\n`;
      if (validate() + Buffer.byteLength(line) > MAX_BYTES) ftruncateSync(handle, 0);
      writeSync(handle, line);
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(handle);
      }
    },
  };
}
