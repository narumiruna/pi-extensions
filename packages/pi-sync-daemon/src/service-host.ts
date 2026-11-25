import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { readConsent } from "./consent.js";
import { configureEngineHost, type EngineContext } from "./engine/host.js";
import type { ForegroundQueueOutcome } from "./foreground-queue-outcome.js";
import { canonicalRootGuard, processExists } from "./identity.js";
import { withCleanup } from "./lifecycle.js";
import { type ClientFacts, type Execution, OWNERSHIP_CLEANUP_REQUIRED } from "./protocol.js";

class OwnershipCleanupError extends Error {
  readonly code = OWNERSHIP_CLEANUP_REQUIRED;
}

interface ForegroundQueueState {
  entered: boolean;
  deferred: boolean;
  beforeMutation?: OwnershipCleanupError;
}

interface Scope {
  execution: Execution;
  held: ReadonlySet<string>;
  peers?: readonly ClientFacts[];
  foreground?: ForegroundQueueState;
}
const scope = new AsyncLocalStorage<Scope>();

/** One service process owns one root; tests must use a separate process per root. */
export function installServiceHost(root: string, ignoreFileOperationsAvailable?: boolean) {
  let poisoned: "queue" | "other" | undefined;
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
    if (poisoned)
      throw new OwnershipCleanupError("Daemon ownership cleanup is uncertain; stop and reconcile before retrying.");
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
    const foreground = owner.foreground;
    let acquireFailed = false;
    let completed = false;
    return withCleanup(
      async () => {
        for (const peer of peers) {
          owner.execution.validate();
          const reservation = randomUUID();
          requested.push({ client: peer.id, reservation });
          try {
            await owner.execution.request(
              "queue-acquire",
              { reservation, targets: missing, generation: peer.generation, background: !owner.execution.clientId },
              peer.id,
            );
          } catch (error) {
            acquireFailed = true;
            throw error;
          }
          owner.execution.validate();
        }
        for (const target of missing) protectedTarget(target, owner.execution);
        if (foreground) foreground.entered = true;
        const result = await scope.run({ ...owner, held: new Set([...owner.held, ...missing]) }, action);
        completed = true;
        return result;
      },
      async () => {
        // Release by request identity even when a grant response was lost. A cancelled
        // prompt is not evidence that a granted remote writer stopped.
        const results = await Promise.allSettled(
          requested.map(async ({ client, reservation }) => {
            const peer = peers.find((peer) => peer.id === client);
            if (peer && !processExists(peer.pid)) return;
            if ((await owner.execution.request("queue-release", { reservation }, client)) !== true)
              throw new Error("File-queue release was not acknowledged.");
          }),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          poisoned ??= "queue";
          const error = new OwnershipCleanupError(
            "File-queue release is uncertain; stop the daemon and keep grants quarantined until owner exit.",
            { cause: failure.reason },
          );
          if (foreground && poisoned === "queue") {
            if (completed) {
              foreground.deferred = true;
              return;
            }
            if (acquireFailed && !foreground.entered && !owner.execution.signal.aborted)
              foreground.beforeMutation = error;
          }
          throw error;
        }
      },
    );
  }
  configureEngineHost({
    ignoreFileOperationsAvailable,
    allowConfigMigration: () => Boolean(readConsent(root)),
    root: () => {
      assertRoot();
      if (poisoned && !(poisoned === "queue" && scope.getStore()?.foreground?.deferred))
        throw new OwnershipCleanupError("Daemon ownership cleanup is uncertain; stop and reconcile before restarting.");
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
                poisoned = "other";
                throw new OwnershipCleanupError(
                  "Pi settings lock release failed; stop and reconcile before restarting.",
                  {
                    cause: error,
                  },
                );
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
    cleanupRequired: () => poisoned !== undefined,
    async runForeground<T>(
      execution: Execution,
      action: (setAdoptionResume: (journal: string | undefined) => void) => Promise<T>,
    ): Promise<T | ForegroundQueueOutcome> {
      const owner = current();
      if (owner.execution !== execution || !execution.clientId || owner.held.size || owner.foreground)
        throw new Error("Foreground queue recovery requires one attached directional job.");
      const foreground: ForegroundQueueState = { entered: false, deferred: false };
      let adoptionResume: string | undefined;
      return scope.run({ ...owner, foreground }, async () => {
        try {
          const result = await action((journal) => {
            adoptionResume = journal;
          });
          if (foreground.deferred && poisoned === "queue") return { foregroundQueueCleanup: "verified-result", result };
          return result;
        } catch (error) {
          if (
            foreground.beforeMutation &&
            !execution.signal.aborted &&
            error instanceof AggregateError &&
            error.errors.includes(foreground.beforeMutation)
          )
            return adoptionResume === undefined
              ? { foregroundQueueCleanup: "before-mutation" }
              : { foregroundQueueCleanup: "resume-adoption", journal: adoptionResume };
          if (foreground.deferred && !(error instanceof OwnershipCleanupError)) {
            const detail = error instanceof Error ? ` ${error.message}` : "";
            throw new OwnershipCleanupError(`File-queue release was not confirmed.${detail}`, { cause: error });
          }
          throw error;
        }
      });
    },
    run<T>(execution: Execution, action: () => Promise<T>): Promise<T> {
      return scope.run({ execution, held: new Set() }, async () => {
        try {
          return await action();
        } catch (error) {
          if (error instanceof AggregateError) {
            const cleanup = error.errors.find((entry: unknown) => entry instanceof OwnershipCleanupError);
            if (cleanup) throw new OwnershipCleanupError(`${error.message} ${cleanup.message}`, { cause: error });
          }
          throw error;
        }
      });
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
