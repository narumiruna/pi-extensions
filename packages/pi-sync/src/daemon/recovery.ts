import { type ClientFacts, DaemonConnection, findDaemon, type Identity } from "@narumitw/pi-sync-daemon";
import type { PiApplyGate } from "./apply-gate.js";

type Address = { paths: DaemonConnection["paths"]; identity: Identity };
interface Recovery {
  gate: PiApplyGate;
  root: string;
  identity: Identity;
  facts: ClientFacts;
  timer?: ReturnType<typeof setInterval>;
  attempt?: Promise<boolean>;
}
const recoveries = new Set<Recovery>();
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function finish(record: Recovery) {
  if (record.timer) clearInterval(record.timer);
  recoveries.delete(record);
}
function attempt(record: Recovery, known?: Address): Promise<boolean> {
  record.attempt ??= (async () => {
    const exited = !alive(record.identity.pid);
    if (exited) await record.gate.releaseAfterOwnerExit(record.identity.pid);
    const address = known ?? (await findDaemon(record.root));
    if (!address || (!exited && address.identity.instance !== record.identity.instance)) return false;
    // Only plain closed-session facts and detached grants cross this recovery boundary.
    // Reclaim the obsolete participant on a compatible owner, reject all new work,
    // and service release callbacks until an authenticated detach confirms drain.
    const connection = new DaemonConnection(
      address.paths,
      address.identity,
      {
        ...record.facts,
        hasUI: false,
        idle: false,
        ready: false,
      },
      {
        callback: async (callback) => {
          const data = callback.payload;
          if (
            callback.kind === "queue-release" &&
            data !== null &&
            typeof data === "object" &&
            "reservation" in data &&
            typeof data.reservation === "string"
          ) {
            await record.gate.releaseRequest(data.reservation);
            return true;
          }
          throw new Error("Closed Pi participant cannot authorize new work.");
        },
      },
    );
    try {
      // Cleanup polling does not attach or recreate a retired participant.
      await connection.dispose();
      await record.gate.releaseAfterDrain();
      finish(record);
      return true;
    } finally {
      await connection.dispose();
    }
  })()
    .catch(() => false)
    .finally(() => {
      record.attempt = undefined;
    });
  return record.attempt;
}

/** Intentionally shared cleanup may outlive a session, but never retains its ctx or UI. */
export function quarantineClient(gate: PiApplyGate, root: string, identity: Identity, facts: ClientFacts) {
  gate.detach();
  const record: Recovery = { gate, root, identity: structuredClone(identity), facts: structuredClone(facts) };
  recoveries.add(record);
  record.timer = setInterval(() => {
    void attempt(record);
  }, 1000);
  record.timer.unref();
  void attempt(record);
}

/** A newly attached client stays unready until obsolete local participants are retired. */
export async function recoverDetachedClients(address: Address) {
  const pending = [...recoveries].filter((record) => record.root === address.paths.root);
  const results = await Promise.all(
    pending.map(async (record) => {
      const done = await attempt(record, address);
      return done || !recoveries.has(record) || (await attempt(record, address));
    }),
  );
  if (results.some((done) => !done))
    throw new Error(
      "Previous Pi cleanup is still uncertain; stop or repair the existing daemon before retrying /reload.",
    );
}
