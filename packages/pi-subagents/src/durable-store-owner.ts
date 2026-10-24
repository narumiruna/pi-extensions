import { spawn } from "node:child_process";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireDirectory(stats: BigIntStats, privateStore: boolean, uid: bigint): void {
  const permissions = stats.mode & 0o7777n;
  const safeAncestor =
    (stats.uid === 0n || stats.uid === uid) && ((permissions & 0o022n) === 0n || (permissions & 0o1000n) !== 0n);
  if (!stats.isDirectory() || (privateStore ? stats.uid !== uid || permissions !== 0o700n : !safeAncestor)) {
    throw new Error("Unsafe durable store directory: require an owned private 0700 store and safe ancestors");
  }
}

function requireLock(stats: BigIntStats, uid: bigint): void {
  if (!stats.isFile() || stats.uid !== uid || (stats.mode & 0o7777n) !== 0o600n || stats.nlink !== 1n) {
    throw new Error("Unsafe durable owner.lock: require an owned regular 0600 file with one link");
  }
}

/** Run only the descriptor form, never a command-holding flock daemon. */
async function runFlock(
  args: string[],
  signal?: AbortSignal,
  fd?: number,
): Promise<{ code: number | null; output: string }> {
  signal?.throwIfAborted();
  return new Promise((fulfill, reject) => {
    const child = spawn("flock", args, {
      stdio: fd === undefined ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "ignore", fd],
      env: { ...process.env, LC_ALL: "C" },
    });
    let output = "";
    let failure: Error | undefined;
    const abort = () => child.kill("SIGKILL");
    child.stdout?.on("data", (data: Buffer) => {
      // Version output only; never retain unbounded helper output.
      output = (output + data.toString()).slice(0, 4096);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      // Wait for close even on cancellation: the child must release its copy first.
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else fulfill({ code, output });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Linux flock(2) locks belong to the open file description, not a PID. The
 * util-linux flock(1) descriptor form locks inherited fd 3 and exits without
 * LOCK_UN. Node duplicates our FD into the child; the parent keeps the same
 * description locked after child exit, until release or process death closes it.
 * Never unlink, replace, truncate, or explicitly unlock owner.lock. See flock(2)
 * DESCRIPTION and util-linux flock(1)'s third synopsis form (numeric descriptor).
 *
 * This is an advisory lock for cooperating local processes. Private directories
 * exclude other users, not hostile code running as this user/root. Store callers
 * must not rename/remove the store or lock, including while an owner is active.
 * Requires Linux /proc and trusted util-linux flock on PATH; no lease fallback.
 */
export async function acquireStoreOwner(
  directory: string,
  signal?: AbortSignal,
): Promise<{ release(): Promise<void> }> {
  signal?.throwIfAborted();
  if (process.platform !== "linux" || !process.getuid) {
    throw new Error("Experimental durable storage ownership requires Linux and util-linux flock");
  }
  const uid = BigInt(process.getuid());
  // Reject missing/incompatible helpers BEFORE touching the durable directory.
  let version: Awaited<ReturnType<typeof runFlock>>;
  try {
    version = await runFlock(["--version"], signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error("Durable storage ownership requires util-linux flock on PATH", { cause: error });
  }
  signal?.throwIfAborted();
  if (version.code !== 0 || !/^flock from util-linux \d/.test(version.output)) {
    throw new Error("Durable storage ownership requires util-linux flock on PATH");
  }

  const handles: FileHandle[] = [];
  const links: { path: string; stats: BigIntStats }[] = [];
  let lock: FileHandle | undefined;
  try {
    let parent = await open("/", directoryFlags);
    handles.push(parent);
    requireDirectory(await parent.stat({ bigint: true }), false, uid);
    signal?.throwIfAborted();
    const components = resolve(directory).split("/").filter(Boolean);
    if (components.length === 0) throw new Error("The durable store cannot be the filesystem root");
    for (const [index, component] of components.entries()) {
      // Pin every component: O_NOFOLLOW on the final path alone is insufficient.
      const path = `/proc/self/fd/${parent.fd}/${component}`;
      let next: FileHandle;
      try {
        next = await open(path, directoryFlags);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        signal?.throwIfAborted();
        try {
          await mkdir(path, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        signal?.throwIfAborted();
        next = await open(path, directoryFlags);
      }
      handles.push(next);
      const stats = await next.stat({ bigint: true });
      requireDirectory(stats, index === components.length - 1, uid);
      links.push({ path, stats });
      parent = next;
      signal?.throwIfAborted();
    }
    const lockPath = `/proc/self/fd/${parent.fd}/owner.lock`;
    lock = await open(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    const original = await lock.stat({ bigint: true });
    requireLock(original, uid);
    signal?.throwIfAborted();
    const result = await runFlock(["--exclusive", "--nonblock", "3"], signal, lock.fd);
    signal?.throwIfAborted();
    if (result.code === 1) throw new Error("Durable store already has a live owner");
    if (result.code !== 0) throw new Error(`Durable store ownership lock failed (flock exit ${result.code})`);

    // Reject path replacement, hard links, or permission changes during acquire.
    for (const link of links) {
      const current = await lstat(link.path, { bigint: true });
      if (!sameInode(current, link.stats) || !current.isDirectory()) {
        throw new Error("Durable store directory changed during ownership acquisition");
      }
      requireDirectory(current, link === links[links.length - 1], uid);
      signal?.throwIfAborted();
    }
    const current = await lstat(lockPath, { bigint: true });
    requireLock(current, uid);
    if (!sameInode(original, current)) {
      throw new Error("Durable owner.lock changed during ownership acquisition");
    }
    signal?.throwIfAborted();
    // Close traversal handles before handing ownership to the caller.
    while (handles.length > 0) {
      await handles[handles.length - 1].close();
      handles.pop();
    }
    signal?.throwIfAborted();
    const owned = lock;
    lock = undefined;
    let released: Promise<void> | undefined;
    return { release: () => (released ??= owned.close()) };
  } finally {
    // Covers aborted opens, helper failures, unsafe paths, and partial setup.
    if (handles.length > 0 || lock) {
      await Promise.all([...handles.map((handle) => handle.close()), lock?.close()]);
    }
  }
}
