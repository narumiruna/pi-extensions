import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { vi } from "vitest";
import { withTempHome } from "./helpers.js";

/** Explicit roots keep alias coverage independent of TMPDIR and the test runner. */
export async function withSnapshotQueueRoot<T>(
  alias: boolean,
  action: (root: string, canonicalRoot: string) => Promise<T>,
) {
  return withTempHome(async (temporaryRoot) => {
    await fs.mkdir(temporaryRoot, { recursive: true });
    const canonicalRoot = await fs.realpath(temporaryRoot);
    const root = alias ? path.join(path.dirname(canonicalRoot), "snapshot-queue-alias") : canonicalRoot;
    if (alias) await fs.symlink(canonicalRoot, root, process.platform === "win32" ? "junction" : "dir");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      return await action(root, canonicalRoot);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
}

/** Emulate top-level case lookup through both the lexical and canonical root. */
export async function caseInsensitiveLookup(root: string, onRename?: (source: unknown, destination: unknown) => void) {
  const roots = new Set([root, await fs.realpath(root)]);
  const readdir = fs.readdir.bind(fs);
  const spies: { mockRestore(): void }[] = [];
  async function resolve(target: unknown) {
    if (typeof target !== "string" || !roots.has(path.dirname(target))) return target;
    const name = (await readdir(root)).find((item) => item.toLowerCase() === path.basename(target).toLowerCase());
    return name ? path.join(path.dirname(target), name) : target;
  }
  for (const method of ["lstat", "realpath", "readFile", "writeFile", "copyFile", "chmod", "open", "rm"] as const) {
    const original = fs[method];
    const spy = vi.spyOn(fs, method);
    const implementation = async (...args: unknown[]) => {
      args[0] = await resolve(args[0]);
      return Reflect.apply(original, fs, args);
    };
    // Vitest's overloaded fs signatures cannot express this forwarding wrapper.
    spy.mockImplementation(implementation as never);
    spies.push(spy);
  }
  const rename = fs.rename.bind(fs);
  spies.push(
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename((await resolve(source)) as string, (await resolve(destination)) as string);
      onRename?.(source, destination);
    }),
  );
  // Pi imports named built-in functions; exercise its actual queue implementation.
  syncBuiltinESMExports();
  return () => {
    for (const spy of spies.reverse()) spy.mockRestore();
    syncBuiltinESMExports();
  };
}
