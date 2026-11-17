import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopDaemon } from "@narumitw/pi-sync-daemon";
import { installEngineFixtureHost } from "./engine-host.js";

installEngineFixtureHost();

export { requiredConfig, snapshot, v3S3Settings, v3WebDavSettings } from "./data-fixtures.js";

const fixtureCleanups = new AsyncLocalStorage<Array<() => Promise<void>>>();
export function registerFixtureCleanup(cleanup: () => Promise<void>) {
  const owned = fixtureCleanups.getStore();
  if (!owned) throw new Error("A disposable fixture must own this client.");
  owned.push(cleanup);
}

export async function withTempHome<T>(fn: (agentDir: string) => Promise<T>) {
  installEngineFixtureHost();
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-home-"));
  const agentDir = path.join(home, ".pi", "agent");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.NODE_OPTIONS =
    `${previousNodeOptions ?? ""} --import ${JSON.stringify(new URL("./fixtures/local-network.mjs", import.meta.url).href)}`.trim();
  const cleanups: Array<() => Promise<void>> = [];
  const failures: unknown[] = [];
  let value: T | undefined;
  try {
    value = await fixtureCleanups.run(cleanups, () => fn(agentDir));
  } catch (error) {
    failures.push(error);
  }
  const cleanupResults = await Promise.allSettled(cleanups.toReversed().map((cleanup) => cleanup()));
  for (const result of cleanupResults) if (result.status === "rejected") failures.push(result.reason);
  // Shared service lifetime never permits leaking disposable test owners.
  let stopped = false;
  try {
    if (existsSync(agentDir)) await stopDaemon(agentDir);
    stopped = true;
  } catch (error) {
    failures.push(error);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    try {
      if (stopped) rmSync(home, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Fixture operation or cleanup failed.");
  return value as T;
}

export async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>) {
  const keys = [
    "PI_SYNC_ENDPOINT",
    "PI_SYNC_BUCKET",
    "PI_SYNC_ACCESS_KEY_ID",
    "PI_SYNC_SECRET_ACCESS_KEY",
    "PI_SYNC_SESSIONS",
    "PI_SYNC_SESSION_TOKEN",
    "PI_SYNC_REGION",
    "PI_SYNC_PROFILE",
    "PI_SYNC_PREFIX",
    "PI_SYNC_AUTO_SYNC",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "R2_ENDPOINT",
    "R2_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
