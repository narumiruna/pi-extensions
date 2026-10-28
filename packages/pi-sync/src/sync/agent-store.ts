import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { writeJson } from "../state/json-file.js";
import { withLock } from "../state/lock.js";
import { LOCK_GUARD_STALE_MS, LOCK_GUARD_UPDATE_MS } from "../state/lock-policy.js";
import { LOCKFILE_FS_ADAPTER } from "../state/lockfile-fs.js";
import { stateDir } from "../state/state-directory.js";
import type { AgentCandidate } from "./agent-candidate.js";
import { AGENT_OUTPUT_BYTES } from "./agent-policy.js";
import { ContinuousError } from "./continuous-errors.js";

interface Claim {
  version: 1;
  id: string;
  pid: number;
}
function paths() {
  const root = path.join(stateDir(), "agent-resolver");
  return { root, claim: path.join(root, "claim.json") };
}
async function directory() {
  const { root } = paths();
  await fs.mkdir(root, { mode: 0o700 });
}
async function checkDirectory() {
  const stat = await fs.lstat(paths().root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && stat.mode & 0o077))
    throw new Error("Unsafe agent resolver directory; evidence retained.");
}
async function readPrivate(file: string): Promise<unknown> {
  try {
    await checkDirectory();
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > AGENT_OUTPUT_BYTES * 2 ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      throw new Error("Unsafe agent resolver record; evidence retained.");
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unreadable agent resolver record; evidence retained.");
  }
}
async function readClaim(): Promise<Claim | undefined> {
  const value = await readPrivate(paths().claim);
  if (value === undefined) return;
  const claim = value as Claim;
  if (
    claim?.version !== 1 ||
    typeof claim.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(claim.id) ||
    Object.keys(claim).sort().join(",") !== "id,pid,version" ||
    !Number.isSafeInteger(claim.pid) ||
    claim.pid < 1 ||
    claim.pid > 2_147_483_647
  )
    throw new Error("Invalid agent resolver claim; evidence retained.");
  return claim;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Caller retains the state-directory migration guard; claim changes use a separate short-lived guard. */
export async function withAgentClaim<T>(fn: (assertOwner: () => Promise<void>) => Promise<T>): Promise<T> {
  const claim: Claim = { version: 1, id: randomUUID(), pid: process.pid };
  let armed = false;
  const assertOwner = async () => {
    const current = await readClaim();
    if (current?.id !== claim.id || current.pid !== process.pid)
      throw new Error("Agent resolver ownership changed; candidate not applied.");
  };
  try {
    await withLock("agent-claim", async () => {
      try {
        await directory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await checkDirectory();
      await withClaimGuard(async () => {
        const existing = await readClaim();
        if (existing && alive(existing.pid))
          throw new ContinuousError("contention", "Agent mode deferred: another local resolver is running.");
        // A durability failure can occur after rename: cleanup must own partial initialization too.
        armed = true;
        await writeJson(paths().claim, claim);
      });
    });
    return await fn(assertOwner);
  } finally {
    if (armed) await releaseClaim(claim);
  }
}
async function releaseClaim(claim: Claim) {
  // Ordinary transfers may hold the operation lock for an arbitrary time.
  // Cleanup needs only the claim guard; it never waits for that operation lock.
  await withClaimGuard(async () => {
    const current = await readClaim();
    if (current?.id === claim.id && current.pid === claim.pid) await fs.rm(paths().claim);
  });
}
async function withClaimGuard<T>(run: () => Promise<T>): Promise<T> {
  await checkDirectory();
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(paths().claim, {
    fs: LOCKFILE_FS_ADAPTER,
    realpath: false,
    stale: LOCK_GUARD_STALE_MS,
    update: LOCK_GUARD_UPDATE_MS,
    retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
    onCompromised: (error) => {
      compromisedError = error;
    },
  });
  try {
    const result = await run();
    if (compromisedError) throw compromisedError;
    return result;
  } finally {
    await release();
  }
}
function candidatePath(key: string) {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid agent candidate key.");
  return path.join(paths().root, `${key}.json`);
}
export async function readAgentCandidate(key: string): Promise<unknown> {
  return readPrivate(candidatePath(key));
}
export async function saveAgentCandidate(key: string, candidate: unknown) {
  await checkDirectory();
  const target = candidatePath(key);
  const existing = await readPrivate(target);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(candidate))
      throw new Error("Agent candidate changed before save; existing evidence retained.");
    return;
  }
  await writeJson(target, candidate, { maxBytes: AGENT_OUTPUT_BYTES * 2 });
}

/** Caller holds the resolver claim and operation lock and has validated both candidates. */
export async function replaceRefusedAgentCandidate(
  key: string,
  previous: AgentCandidate,
  candidate: AgentCandidate,
  validate: () => Promise<void>,
) {
  const original = JSON.stringify(previous);
  if (!previous.results.some((row) => "refuse" in row) || candidate.results.some((row) => "refuse" in row))
    throw new Error("Only a validated refusal can be replaced by a complete retry result.");
  const target = candidatePath(key);
  const assertPrevious = async () => {
    if (JSON.stringify(await readPrivate(target)) !== original)
      throw new Error("Cached refusal changed during review; previous evidence retained.");
    await validate();
  };
  await assertPrevious();
  const digest = createHash("sha256").update(original).digest("hex");
  const archive = path.join(paths().root, `${key}.refusal-${digest}.json`);
  const retained = await readPrivate(archive);
  await validate();
  if (retained !== undefined && JSON.stringify(retained) !== original)
    throw new Error("Retained refusal changed; evidence retained.");
  if (retained === undefined) await writeJson(archive, previous, { maxBytes: AGENT_OUTPUT_BYTES * 2 });
  await assertPrevious();
  // Archive first: even a durability error after replacement retains the original refusal.
  // Once rename commits, later cancellation cannot undo the valid new candidate.
  await writeJson(target, candidate, { maxBytes: AGENT_OUTPUT_BYTES * 2 });
}
