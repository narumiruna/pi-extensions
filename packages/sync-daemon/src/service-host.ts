import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { readConsent } from "./consent.js";
import { configureEngineHost, type EngineContext } from "./engine/host.js";
import { canonicalRootGuard, processExists } from "./identity.js";
import { withCleanup } from "./lifecycle.js";
import type { ClientFacts, Execution } from "./protocol.js";

interface Scope {
  execution: Execution;
  held: ReadonlySet<string>;
  peers?: readonly ClientFacts[];
}
const scope = new AsyncLocalStorage<Scope>();

/** One service process owns one root; tests must use a separate process per root. */
export function installServiceHost(root: string) {
  let poisoned = false;
  const assertRoot = canonicalRootGuard(root);
  function current() {
    const value = scope.getStore();
    if (!value) throw new Error("Engine access requires a daemon job.");
    return value;
  }
  function protectedTarget(target: string, execution: Execution) {
    const normalized = path.resolve(target);
    if (execution.liveClients().some((peer) => peer.sessionFile && path.resolve(peer.sessionFile) === normalized))
      throw new Error("A live client's session is protected, including after orderly exit.");
  }
  async function reserve<T>(targets: readonly string[], action: () => Promise<T>): Promise<T> {
    const owner = current();
    assertRoot();
    if (poisoned) throw new Error("Daemon ownership cleanup is uncertain; stop and reconcile before retrying.");
    const missing = [...new Set(targets)].filter((target) => !owner.held.has(target)).sort();
    if (!missing.length) return action();
    if (!owner.peers)
      return owner.execution.withParticipants((peers) =>
        scope.run({ ...owner, peers }, () => reserve(targets, action)),
      );
    owner.execution.validate();
    for (const target of missing) protectedTarget(target, owner.execution);
    const peers = owner.peers.toSorted((a, b) => a.id.localeCompare(b.id));
    const requested: { client: string; reservation: string }[] = [];
    return withCleanup(
      async () => {
        for (const peer of peers) {
          owner.execution.validate();
          const reservation = randomUUID();
          requested.push({ client: peer.id, reservation });
          await owner.execution.request(
            "queue-acquire",
            { reservation, targets: missing, generation: peer.generation, background: !owner.execution.clientId },
            peer.id,
          );
          owner.execution.validate();
        }
        for (const target of missing) protectedTarget(target, owner.execution);
        return await scope.run({ ...owner, held: new Set([...owner.held, ...missing]) }, action);
      },
      async () => {
        // Release by request identity even when a grant response was lost. A cancelled
        // prompt is not evidence that a granted remote writer stopped.
        const results = await Promise.allSettled(
          requested.map(({ client, reservation }) => {
            const peer = peers.find((peer) => peer.id === client);
            return peer && !processExists(peer.pid)
              ? Promise.resolve(true)
              : owner.execution.request("queue-release", { reservation }, client);
          }),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          poisoned = true;
          throw new Error(
            "File-queue release is uncertain; stop the daemon and keep grants quarantined until owner exit.",
            { cause: failure.reason },
          );
        }
      },
    );
  }
  configureEngineHost({
    allowConfigMigration: () => Boolean(readConsent(root)),
    root: () => {
      assertRoot();
      if (poisoned) throw new Error("Daemon ownership cleanup is uncertain; stop and reconcile before restarting.");
      return root;
    },
    reserveTargets: reserve,
    mutate: async (target, action) =>
      reserve([target], async () => {
        const owner = current();
        protectedTarget(target, owner.execution);
        const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
        owner.execution.validate();
        return withFileMutationQueue(target, async () => {
          const settings = path.resolve(target) === path.join(root, "settings.json");
          let release: (() => Promise<void>) | undefined;
          if (settings) {
            // Pi's absent-file branch does not reread after locking. Do not race it.
            const info = await fs.lstat(target).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              throw error;
            });
            if (!info && owner.execution.liveClients().length)
              throw new Error("Cannot create settings.json while a Pi client is alive; create it through Pi first.");
            if (info?.isSymbolicLink()) throw new Error("Refusing an aliased settings file.");
            release = await lockfile.lock(target, { realpath: false });
          }
          return withCleanup(
            async () => {
              owner.execution.validate();
              protectedTarget(target, owner.execution);
              return action();
            },
            async () => {
              try {
                await release?.();
              } catch (error) {
                poisoned = true;
                throw error;
              }
            },
          );
        });
      }),
    review: async (_ctx, request, signal, isCurrent) => {
      if (!isCurrent() || signal?.aborted) return false;
      const result = await current().execution.request("merge-review", request, undefined, signal);
      return result === true && isCurrent() && !signal?.aborted;
    },
    status: (_ctx, value, presentation) => current().execution.emit("status", { value, presentation }),
  });
  return {
    run<T>(execution: Execution, action: () => Promise<T>): Promise<T> {
      return scope.run({ execution, held: new Set() }, action);
    },
  };
}

export function createServiceContext(execution: Execution): EngineContext {
  const initial = execution.facts();
  if (!initial) throw new Error("This operation needs an attached client.");
  const facts = () => execution.facts() ?? initial;
  const ask = async (kind: string, payload: unknown, signal?: AbortSignal) => {
    execution.validate();
    return execution.request(kind, payload, undefined, signal);
  };
  return {
    cwd: initial.cwd,
    mode: initial.mode,
    get hasUI() {
      return facts().hasUI;
    },
    // Resolver initialization replaces these only for explicitly model-capable jobs.
    modelRegistry: {
      streamSimple: () => {
        throw new Error("The standalone resolver is unavailable.");
      },
    },
    sessionManager: {
      getSessionFile: () => facts().sessionFile,
      getSessionId: () => facts().sessionId ?? "",
      getCwd: () => facts().cwd,
      getSessionDir: () => facts().sessionDir ?? path.join(execution.root, "sessions"),
      usesDefaultSessionDir: () => facts().sessionDir === undefined,
    },
    get protectedSessionFiles() {
      return execution.liveClients().flatMap((peer) => (peer.sessionFile ? [peer.sessionFile] : []));
    },
    isIdle: () => execution.participants().every((peer) => peer.idle),
    reload: async () => {
      await ask("reload", {});
    },
    ui: {
      notify: (message, level = "info") => execution.emit("notify", { message, level }),
      setStatus: (_key, value) => execution.emit("status", { value }),
      confirm: async (title, message, options) => (await ask("confirm", { title, message }, options?.signal)) === true,
      select: async (title, items, options) => {
        const result = await ask("select", { title, items, helpText: options?.helpText }, options?.signal);
        if (typeof result !== "string" || !items.includes(result)) return undefined;
        return result;
      },
    },
  };
}
