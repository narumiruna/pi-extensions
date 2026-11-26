import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { gt } from "semver";
import { DAEMON_BUILD_ID, DAEMON_BUILD_VERSION, readInstalledDaemonBuild } from "./build-version.js";
import { DaemonError, hello, requestDaemon } from "./client-transport.js";
import {
  canonicalRootGuard,
  clearUpgradeOwner,
  daemonPaths,
  privateDirectory,
  processExists,
  processExited,
  type RuntimePaths,
  readIdentity,
  readProcessBirth,
  readUpgradeOwner,
  recordUpgradeOwner,
  runtimePaths,
  type UpgradeOwner,
  upgradeRepairStarted,
} from "./identity.js";
import { type Identity, OWNERSHIP_CLEANUP_REQUIRED, record } from "./protocol.js";

const upgradeBlockers = {
  busy: "Daemon update deferred while sync work is active. Let it finish, then use /reload or retry the daemon CLI.",
  repair:
    "Daemon update blocked by uncertain consent or queue cleanup. Follow the daemon recovery guide before retrying.",
  unattended: "Review or revoke unattended Pi Sync permission before stopping or replacing the daemon.",
  legacy:
    "This older daemon does not support guarded upgrades. Let sync work finish, run restart from the intended daemon CLI, then /reload.",
};

export class DaemonUpgradeBlockedError extends Error {
  constructor(
    readonly instance: string,
    reason: keyof typeof upgradeBlockers,
  ) {
    super(upgradeBlockers[reason]);
    this.name = "DaemonUpgradeBlockedError";
  }
}

function matchesBuild(version?: string, id?: string) {
  return version === DAEMON_BUILD_VERSION && id === DAEMON_BUILD_ID;
}

function assertInstalledBuild() {
  const { version, id } = readInstalledDaemonBuild();
  if (!matchesBuild(version, id))
    throw new Error("The daemon installation changed. Reload the intended Pi Sync build before retrying.");
}

const sameIdentity = (left?: Identity, right?: Identity) =>
  left?.instance === right?.instance && left?.pid === right?.pid && left?.token === right?.token;
const sameBarrier = (left: UpgradeOwner | undefined, right: UpgradeOwner) =>
  left?.instance === right.instance &&
  left.pid === right.pid &&
  left.birth === right.birth &&
  left.purpose === right.purpose;

export async function checkUpgradeConsent(
  paths: RuntimePaths,
  assertRoot: () => void,
  signal?: AbortSignal,
  instance?: string,
) {
  const { readConsent } = await import("./consent.js");
  const { withStateDirectoryGuardForRoot } = await import("./engine/state/state-directory.js");
  signal?.throwIfAborted();
  await withStateDirectoryGuardForRoot(paths.root, () => {
    signal?.throwIfAborted();
    assertRoot();
    const consent = readConsent(paths.root);
    if (consent && Object.values(consent.setups).some((setup) => setup.afterExit)) {
      if (instance) throw new DaemonUpgradeBlockedError(instance, "unattended");
      throw new Error(upgradeBlockers.unattended);
    }
  });
  signal?.throwIfAborted();
  assertRoot();
}

export async function finishUpgrade(
  paths: RuntimePaths,
  owner: UpgradeOwner,
  assertRoot: () => void,
  signal?: AbortSignal,
) {
  await waitForProcessExit(owner, signal);
  const current = await readIdentity(paths);
  if (current?.instance === owner.instance) throw new Error("The daemon exited without releasing its identity.");
  if (current) throw new Error("Daemon owner changed during recovery. Review the current owner before retrying.");
  const ownerLock = await lstat(paths.owner).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (ownerLock) throw new Error("The daemon exited without releasing its owner lock. Follow daemon recovery.");
  await checkUpgradeConsent(paths, assertRoot, signal);
  if (!sameBarrier(await readUpgradeOwner(paths), owner))
    throw new Error("Daemon upgrade record changed; private state was retained.");
  signal?.throwIfAborted();
  assertRoot();
  await clearUpgradeOwner(paths);
  signal?.throwIfAborted();
  assertRoot();
}

async function drainForUpgrade(
  paths: RuntimePaths,
  owner: Identity,
  { recorded, birth, guarded }: { recorded?: UpgradeOwner; birth?: string; guarded: boolean },
  assertRoot: () => void,
  signal?: AbortSignal,
) {
  await checkUpgradeConsent(paths, assertRoot, signal, owner.instance);
  const barrier = recorded ?? { ...owner, birth };
  if (!sameIdentity(await readIdentity(paths), owner)) throw new Error("Daemon owner changed before stop.");
  signal?.throwIfAborted();
  assertRoot();
  assertInstalledBuild();
  if (!recorded) await recordUpgradeOwner(paths, barrier);
  let reply: unknown;
  try {
    signal?.throwIfAborted();
    assertRoot();
    assertInstalledBuild();
    reply = await requestDaemon(paths, owner, guarded ? "upgrade-stop" : "stop", {}, signal);
    if (!record(reply) || (reply.stopping !== true && (!guarded || !isDeferral(reply.deferred))))
      throw new Error("Daemon did not acknowledge stop.");
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      "Pi Sync could not replace the daemon safely. Check `pi-sync-daemon status --root <agent-directory>`. Do not force a second owner or remove recovery files.",
      { cause: error },
    );
  }
  if (guarded && isDeferral(reply.deferred) && reply.stopping !== true) {
    const current = await readIdentity(paths);
    const pending = await readUpgradeOwner(paths);
    signal?.throwIfAborted();
    assertRoot();
    if (!sameIdentity(current, owner) || !sameBarrier(pending, barrier))
      throw new Error("Daemon owner or upgrade record changed; private state was retained.");
    await clearUpgradeOwner(paths);
    throw new DaemonUpgradeBlockedError(owner.instance, reply.deferred);
  }
  await finishUpgrade(paths, barrier, assertRoot, signal);
}

function isDeferral(value: unknown): value is "busy" | "unattended" | "repair" {
  return value === "busy" || value === "unattended" || value === "repair";
}

export async function acquireStartupLock(paths: RuntimePaths, signal?: AbortSignal) {
  const deadline = performance.now() + 150_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await lockfile.lock(paths.directory, {
        realpath: false,
        lockfilePath: paths.startup,
        stale: 30_000,
        update: 5_000,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (performance.now() >= deadline)
        throw new Error("Timed out waiting to start the Pi Sync daemon.", { cause: error });
      await delay(50, undefined, { signal });
    }
  }
}

export function ensureDaemon(root: string, signal?: AbortSignal, options?: { compatibleOnly: true }) {
  return startDaemon(root, signal, options?.compatibleOnly ? "compatible-only" : "ensure");
}

export function restartDaemon(root: string, signal?: AbortSignal) {
  return startDaemon(root, signal, "restart");
}

async function startDaemon(
  root: string,
  signal: AbortSignal | undefined,
  intent: "ensure" | "compatible-only" | "restart",
) {
  const paths = await runtimePaths(root);
  const assertRoot = canonicalRootGuard(paths.root);
  signal?.throwIfAborted();
  await privateDirectory(paths.directory);
  const restartTarget = intent === "restart" ? { identity: await readIdentity(paths) } : undefined;
  signal?.throwIfAborted();
  const release = await acquireStartupLock(paths, signal);
  try {
    signal?.throwIfAborted();
    let waited = false;
    let upgraded = false;
    let verifyRestartTarget = restartTarget !== undefined;
    for (;;) {
      signal?.throwIfAborted();
      const upgrade = await readUpgradeOwner(paths);
      if (upgrade && intent === "compatible-only")
        throw new Error("A daemon upgrade or recovery is pending; no replacement was attempted.");
      if (upgrade && (await upgradeRepairStarted(paths, upgrade)))
        throw new Error("A daemon upgrade repair is incomplete. Run `pi-sync-daemon repair-upgrade` for this root.");
      const existing = await readIdentity(paths);
      if (verifyRestartTarget) {
        if (!sameIdentity(existing, restartTarget?.identity))
          throw new Error("Daemon owner changed while waiting to restart. Check status before retrying.");
        verifyRestartTarget = false;
      }
      if (upgrade && existing?.instance === upgrade.instance && existing.pid !== upgrade.pid)
        throw new Error("The recorded upgrade owner changed; private state was retained.");
      if (upgrade && (existing?.instance !== upgrade.instance || (await processExited(upgrade)))) {
        await finishUpgrade(paths, upgrade, assertRoot, signal);
        upgraded = true;
        continue;
      }
      if (upgrade?.purpose === "cleanup")
        throw Object.assign(
          new Error("Daemon recovery is incomplete. Use /sync daemon recover to finish the reviewed stop."),
          { code: OWNERSHIP_CLEANUP_REQUIRED },
        );
      if (!existing) break;
      const beforeHello = upgrade ? undefined : await readProcessBirth(existing.pid);
      let status: Awaited<ReturnType<typeof hello>>;
      try {
        status = await hello(paths, existing, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (upgrade) {
          await finishUpgrade(paths, upgrade, assertRoot, signal);
          upgraded = true;
          continue;
        }
        if (error instanceof DaemonError && error.remote.name === "DaemonStoppingError" && !waited) {
          waited = true;
          await waitForDaemonExit(existing, signal);
          continue;
        }
        if (processExists(existing.pid))
          throw new Error(
            "A daemon owner is alive but unavailable; use diagnostics instead of starting a second owner.",
            { cause: error },
          );
        break;
      }
      signal?.throwIfAborted();
      assertRoot();
      const restart = intent === "restart" && !upgraded;
      if (restart && status.buildVersion && gt(status.buildVersion, DAEMON_BUILD_VERSION))
        throw new Error("The running daemon is newer than this CLI. Use the intended Pi Sync build to restart it.");
      if (!status.needsUpgrade && !restart) {
        if (upgrade) throw new Error("The recorded upgrade owner changed; private state was retained.");
        return { paths: daemonPaths(paths, existing.instance), identity: existing, ...status, replacedOwner: false };
      }
      if (intent === "compatible-only")
        throw new Error("A compatible daemon could not be attached; an older owner was left unchanged.");
      if (upgraded)
        throw new Error("An older Pi Sync daemon started again. Close or upgrade other Pi sessions, then use /reload.");
      if (!status.upgradeStop && !restart) throw new DaemonUpgradeBlockedError(existing.instance, "legacy");
      const birth = beforeHello === undefined ? undefined : await readProcessBirth(existing.pid);
      if (birth !== beforeHello || (upgrade?.birth !== undefined && (await processExited(upgrade))))
        throw new Error("The daemon process changed during authentication; private state was retained.");
      await drainForUpgrade(
        paths,
        existing,
        { recorded: upgrade, birth, guarded: status.upgradeStop },
        assertRoot,
        signal,
      );
      upgraded = true;
    }
    signal?.throwIfAborted();
    assertRoot();
    assertInstalledBuild();
    const executable = process.versions.bun ? "node" : process.execPath;
    const child = spawn(
      executable,
      [
        fileURLToPath(new URL("./cli.js", import.meta.url)),
        "serve",
        "--root",
        paths.root,
        "--expect-build",
        DAEMON_BUILD_VERSION,
        DAEMON_BUILD_ID ?? "",
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    const ready = await new Promise<Identity>((resolve, reject) => {
      const timer = setTimeout(() => failed(new Error("Daemon readiness timed out.")), 15_000);
      timer.unref?.();
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.off("message", message);
        child.off("error", failed);
        child.off("exit", exited);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (code: number | null) =>
        failed(new Error(`Daemon startup exited (${code}); private state was retained.`));
      const message = (value: unknown) => {
        if (!record(value)) return;
        if (value.type === "error")
          failed(new Error(typeof value.message === "string" ? value.message : "Daemon startup failed."));
        if (value.type === "ready") {
          const candidate = value.identity;
          if (!record(candidate) || candidate.pid !== child.pid || candidate.root !== paths.root)
            return failed(new Error("Daemon readiness identity did not match the launched process."));
          cleanup();
          resolve(candidate as unknown as Identity);
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.on("message", message);
      child.once("error", failed);
      child.once("exit", exited);
      if (signal?.aborted) abort();
    }).finally(() => {
      if (!child.pid) child.once("error", () => {});
      if (child.connected) child.disconnect();
      child.unref();
    });
    const published = await readIdentity(paths);
    if (!published || !sameIdentity(published, ready)) throw new Error("Ready daemon was not the published owner.");
    const status = await hello(paths, published, signal);
    signal?.throwIfAborted();
    assertRoot();
    if (!matchesBuild(status.buildVersion, status.buildId))
      throw new Error("The daemon installation changed during startup. Use /reload to retry.");
    return { paths: daemonPaths(paths, ready.instance), identity: ready, ...status, replacedOwner: upgraded };
  } finally {
    await release();
  }
}

export async function waitForDaemonExit({ pid }: Pick<Identity, "pid">, signal?: AbortSignal) {
  await waitForProcessExit({ pid }, signal);
}

async function waitForProcessExit(owner: Parameters<typeof processExited>[0], signal?: AbortSignal) {
  const deadline = Date.now() + 30_000;
  signal?.throwIfAborted();
  while (!(await processExited(owner))) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Closing daemon is still alive; replacement was not attempted.");
    await delay(25, undefined, { signal });
  }
  signal?.throwIfAborted();
}

export async function findDaemon(root: string) {
  let paths: RuntimePaths;
  try {
    paths = await runtimePaths(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const identity = await readIdentity(paths);
  if (!identity || !processExists(identity.pid)) return undefined;
  try {
    const status = await hello(paths, identity);
    return { paths: daemonPaths(paths, identity.instance), identity, ...status };
  } catch (error) {
    if (error instanceof DaemonError && error.remote.name === "DaemonStoppingError") return undefined;
    throw error;
  }
}

export async function stopDaemon(root: string): Promise<boolean> {
  const paths = await runtimePaths(root);
  const identity = await readIdentity(paths);
  if (!identity) return false;
  await requestDaemon(paths, identity, "stop", {});
  const deadline = Date.now() + 30_000;
  for (;;) {
    const current = await readIdentity(paths);
    if (!current || current.instance !== identity.instance) return true;
    if (Date.now() >= deadline) throw new Error("Daemon did not drain; no replacement was attempted.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
