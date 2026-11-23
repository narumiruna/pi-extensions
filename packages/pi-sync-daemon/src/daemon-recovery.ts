import { DaemonError, hello, requestDaemon } from "./client-transport.js";
import { acquireStartupLock, checkUpgradeConsent, finishUpgrade } from "./daemon-startup.js";
import {
  canonicalRootGuard,
  clearUpgradeOwner,
  processExists,
  processExited,
  type RuntimePaths,
  readIdentity,
  readProcessBirth,
  readUpgradeOwner,
  recordUpgradeOwner,
  runtimePaths,
  upgradeRepairStarted,
} from "./identity.js";
import { withCleanup } from "./lifecycle.js";
import { type Identity, record } from "./protocol.js";

export type DaemonRecoveryTarget = Pick<Identity, "root" | "pid" | "instance">;

type ForegroundJob = { job: string; client: string; generation: string; birth?: string };

export async function stopDaemonAfterForegroundQueueFailure(
  paths: RuntimePaths,
  identity: Identity,
  { job, client, generation, birth }: ForegroundJob,
  signal: AbortSignal,
): Promise<void> {
  const assertRoot = canonicalRootGuard(paths.root);
  if (process.platform === "linux" && birth === undefined)
    throw new Error("Daemon process identity could not be verified during queue cleanup.");
  const barrier = { ...identity, birth, purpose: "cleanup" as const };
  const samePublished = (current: Identity | undefined) =>
    current !== undefined && sameOwner(current, identity) && current.token === identity.token;
  const release = await acquireStartupLock(paths, signal);
  await withCleanup(async () => {
    signal.throwIfAborted();
    assertRoot();
    if (await readUpgradeOwner(paths)) throw new Error("A daemon upgrade or recovery is already pending.");
    await checkUpgradeConsent(paths, assertRoot, signal);
    const requireCurrent = async () => {
      const sampled = birth === undefined ? undefined : await readProcessBirth(identity.pid);
      const current = await readIdentity(paths);
      signal.throwIfAborted();
      assertRoot();
      if (!current && (await processExited(barrier))) {
        if (await readIdentity(paths)) throw new Error("Daemon owner changed during queue cleanup.");
        signal.throwIfAborted();
        assertRoot();
        return false;
      }
      if (!samePublished(current) || !processExists(identity.pid) || birth !== sampled)
        throw new Error("Daemon owner changed or could not be verified during queue cleanup.");
      return true;
    };
    if (!(await requireCurrent())) return;
    const params = { job, client, generation };
    let checked: unknown;
    try {
      checked = await requestDaemon(paths, identity, "foreground-stop", { ...params, check: true }, signal);
    } catch (error) {
      if (!(await requireCurrent())) return;
      throw error;
    }
    if (!record(checked) || checked.eligible !== true)
      throw new Error(
        record(checked) && typeof checked.blocked === "string"
          ? checked.blocked
          : "Daemon queue cleanup could not be verified.",
      );
    if (!(await requireCurrent())) return;
    signal.throwIfAborted();
    await recordUpgradeOwner(paths, barrier);
    if (!(await requireCurrent())) return finishUpgrade(paths, barrier, assertRoot, signal);
    let reply: unknown;
    try {
      assertRoot();
      reply = await requestDaemon(paths, identity, "foreground-stop", params, signal);
    } catch (error) {
      signal.throwIfAborted();
      const current = await readIdentity(paths);
      signal.throwIfAborted();
      assertRoot();
      if (current && !samePublished(current))
        throw new Error("Daemon owner changed during recovery. Keep the recorded evidence.", { cause: error });
      if (current && error instanceof DaemonError)
        throw new Error("Daemon stop could not be confirmed. Queue grants and recovery evidence were retained.", {
          cause: error,
        });
      return finishUpgrade(paths, barrier, assertRoot, signal);
    }
    if (record(reply) && typeof reply.blocked === "string") {
      const current = await readIdentity(paths);
      signal.throwIfAborted();
      assertRoot();
      if (samePublished(current)) await clearUpgradeOwner(paths);
      throw new Error(reply.blocked);
    }
    if (!record(reply) || reply.stopping !== true)
      throw new Error("Daemon stop could not be confirmed. Queue grants and recovery evidence were retained.");
    await finishUpgrade(paths, barrier, assertRoot, signal);
  }, release);
}

async function recoveryOwner(paths: RuntimePaths) {
  const pending = await readUpgradeOwner(paths);
  if (pending && (pending.purpose !== "cleanup" || (await upgradeRepairStarted(paths, pending))))
    throw new Error("A daemon upgrade or repair is pending. Follow the daemon recovery guide.");
  const identity = await readIdentity(paths);
  if (pending && identity && !sameOwner(pending, identity))
    throw new Error("Daemon owner changed during recovery. Keep the recorded evidence.");
  return { identity, pending };
}

function sameOwner(left: DaemonRecoveryTarget, right: DaemonRecoveryTarget) {
  return left.root === right.root && left.pid === right.pid && left.instance === right.instance;
}

export async function inspectDaemonRecovery(
  root: string,
  signal?: AbortSignal,
): Promise<DaemonRecoveryTarget | undefined> {
  const paths = await runtimePaths(root);
  const assertRoot = canonicalRootGuard(paths.root);
  signal?.throwIfAborted();
  const { identity, pending } = await recoveryOwner(paths);
  if (!pending && identity) await hello(paths, identity, signal);
  signal?.throwIfAborted();
  assertRoot();
  const owner = pending ?? identity;
  if (owner) return { root: owner.root, pid: owner.pid, instance: owner.instance };
}

export async function stopDaemonForRecovery(target: DaemonRecoveryTarget, signal?: AbortSignal): Promise<void> {
  const paths = await runtimePaths(target.root);
  const assertRoot = canonicalRootGuard(paths.root);
  signal?.throwIfAborted();
  const release = await acquireStartupLock(paths, signal);
  await withCleanup(async () => {
    signal?.throwIfAborted();
    assertRoot();
    const { identity, pending } = await recoveryOwner(paths);
    const owner = pending ?? identity;
    if (!owner || !sameOwner(owner, target))
      throw new Error("Daemon owner changed. Review the current owner before stopping it.");
    let barrier = pending;
    if (!barrier && identity) {
      const before = await readProcessBirth(identity.pid);
      await hello(paths, identity, signal);
      const birth = before === undefined ? undefined : await readProcessBirth(identity.pid);
      if (!processExists(identity.pid) || (before !== undefined && before !== birth))
        throw new Error("Daemon process changed during authentication. Review the current owner.");
      await checkUpgradeConsent(paths, assertRoot, signal);
      const current = await readIdentity(paths);
      if (!current || !sameOwner(identity, current))
        throw new Error("Daemon owner changed. Review the current owner before stopping it.");
      signal?.throwIfAborted();
      assertRoot();
      barrier = { ...target, version: identity.version, birth, purpose: "cleanup" };
      await recordUpgradeOwner(paths, barrier);
    }
    if (!barrier) throw new Error("Daemon recovery has no recorded owner.");
    if (identity && !(await processExited(barrier))) {
      await checkUpgradeConsent(paths, assertRoot, signal);
      try {
        const reply = await requestDaemon(paths, identity, "stop", {}, signal);
        if (!record(reply) || reply.stopping !== true) throw new Error("Daemon did not acknowledge stop.");
      } catch (error) {
        signal?.throwIfAborted();
        if (await readIdentity(paths))
          throw new Error("Daemon stop could not be confirmed. Keep recovery evidence and retry.", { cause: error });
      }
    }
    await finishUpgrade(paths, barrier, assertRoot, signal);
  }, release);
}
