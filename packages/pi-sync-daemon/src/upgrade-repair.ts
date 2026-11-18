import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { acquireStartupLock } from "./client.js";
import { revokeRetainedGrants } from "./consent.js";
import { withStateDirectoryGuardForRoot } from "./engine/state/state-directory.js";
import {
  canonicalRootGuard,
  privateDirectory,
  processExited,
  readIdentity,
  readUpgradeOwner,
  runtimePaths,
  upgradeArchivePath,
  upgradeFile,
} from "./identity.js";

/** Explicit repair never launches or sends requests to a daemon. */
export async function repairUpgrade(root: string) {
  const paths = await runtimePaths(root);
  const assertRoot = canonicalRootGuard(paths.root);
  await privateDirectory(paths.directory);
  const releaseStartup = await acquireStartupLock(paths);
  try {
    const pending = await readUpgradeOwner(paths);
    if (!pending) return { repaired: false };
    // Exclude direct `serve`. Use a distinct lock key so proper-lockfile can track both locks.
    const releaseOwner = await lockfile.lock(paths.owner, {
      realpath: false,
      lockfilePath: paths.owner,
      stale: 30_000,
      update: 5_000,
    });
    try {
      const identity = await readIdentity(paths);
      if (identity && (identity.instance !== pending.instance || identity.pid !== pending.pid))
        throw new Error("The recorded upgrade owner changed; private state was retained.");
      if (!(await processExited(pending)))
        throw new Error("Cannot verify that the old Pi Sync daemon has exited; private state was retained.");
      assertRoot();
      // The archive also marks a repair in progress before consent or recovery records change.
      const archive = upgradeArchivePath(paths, pending);
      await privateDirectory(archive);
      const revokedGrants = await withStateDirectoryGuardForRoot(paths.root, () => {
        assertRoot();
        return revokeRetainedGrants(paths.root);
      });
      assertRoot();
      // Keep the original bytes private. Move the barrier last so interrupted repair can be retried.
      if (identity) await fs.rename(paths.identity, path.join(archive, path.basename(paths.identity)));
      assertRoot();
      const barrier = upgradeFile(paths);
      await fs.rename(barrier, path.join(archive, path.basename(barrier)));
      return { repaired: true, revokedGrants, archive };
    } finally {
      await releaseOwner();
    }
  } finally {
    await releaseStartup();
  }
}
