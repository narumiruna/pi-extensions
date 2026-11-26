import path from "node:path";
import { gt } from "semver";
import { DAEMON_BUILD_ID, DAEMON_BUILD_VERSION } from "./build-version.js";
import { hello } from "./client-transport.js";
import { processExited, readIdentity, readUpgradeOwner, runtimePaths } from "./identity.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export async function inspectDaemonStatus(root: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const paths = await runtimePaths(root);
  const identity = await readIdentity(paths);
  const pending = await readUpgradeOwner(paths);
  const summary = {
    root: paths.root,
    expectedBuildVersion: DAEMON_BUILD_VERSION,
    ...(DAEMON_BUILD_ID && { expectedBuildId: DAEMON_BUILD_ID }),
    ...(identity && { recordedPid: identity.pid }),
    ...(pending && { pendingUpgradePid: pending.pid }),
  };
  signal?.throwIfAborted();
  if (
    !identity ||
    (pending?.instance === identity.instance && pending.pid === identity.pid && (await processExited(pending)))
  ) {
    signal?.throwIfAborted();
    return { running: false as const, ...summary };
  }
  try {
    const build = await hello(paths, identity, signal);
    signal?.throwIfAborted();
    return {
      running: true as const,
      ...summary,
      version: PROTOCOL_VERSION,
      instance: identity.instance,
      pid: identity.pid,
      ...(build.buildVersion && { buildVersion: build.buildVersion }),
      ...(build.buildId && { buildId: build.buildId }),
      buildComparison: compareBuild(build),
      lifecycleLog: path.join(paths.directory, "lifecycle.log"),
    };
  } catch {
    signal?.throwIfAborted();
    return { running: null, ...summary };
  }
}

function compareBuild({ buildVersion, buildId, needsUpgrade }: Awaited<ReturnType<typeof hello>>) {
  if (!buildVersion) return "unversioned";
  if (needsUpgrade) return "older";
  if (gt(buildVersion, DAEMON_BUILD_VERSION)) return "newer";
  if (!buildId || !DAEMON_BUILD_ID) return "unverified";
  return buildId === DAEMON_BUILD_ID ? "match" : "different";
}
