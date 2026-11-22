import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  automaticPolicyAuthorized,
  ConsentPublicationError,
  consentFingerprint,
  participantBinding,
  readConsent,
  revokeChangedBindings,
} from "./consent.js";
import type { EngineContext, EngineSession } from "./engine/host.js";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "./engine/settings/config.js";
import type { AnySyncConfig } from "./engine/settings/settings-types.js";
import type { createContinuousSync } from "./engine/sync/continuous-sync.js";
import { createEngineLoaders } from "./engine/sync/sync-loaders.js";
import type { IdleExitPolicy } from "./idle-exit.js";
import type { ClientFacts, Execution } from "./protocol.js";
import type { startServer } from "./server.js";
import type { installServiceHost } from "./service-host.js";
import { createServiceContext } from "./service-host.js";

export function createMonitor(root: string, host: ReturnType<typeof installServiceHost>) {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let task:
    | { controller: AbortController; continuous: ReturnType<typeof createContinuousSync>; promise: Promise<void> }
    | undefined;
  let transition = Promise.resolve();
  let closed = false;
  let authorizationFailed = false;
  let scheduled = false;
  let settingsGeneration = 0;
  let blockedParticipants: string | undefined;
  const participatingSessions = () =>
    JSON.stringify(
      server
        ?.participants()
        .map(({ id, generation }) => `${id}:${generation}`)
        .sort() ?? [],
    );
  const policyNeedsReview = () => blockedParticipants === participatingSessions();
  let monitoredPolicy: string | undefined;
  const retries = new Map<string, { fingerprint: string; owner: string; signal: AbortSignal }>();
  const retryOwner = (peer: ClientFacts) =>
    JSON.stringify([peer.generation, peer.cwd, peer.sessionId, peer.sessionFile, peer.sessionDir, peer.model]);
  let epoch:
    | {
        key: string;
        controller: AbortController;
        manager: EngineSession;
        location: { sessionDir: string | undefined; cwd: string };
        debug: boolean;
      }
    | undefined;
  const timingOwners = new WeakMap<EngineContext, Execution>();
  const loaders = createEngineLoaders();
  let continuous: ReturnType<typeof createContinuousSync> | undefined;
  function schedule() {
    if (closed || scheduled || !server) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      transition = transition.then(start).catch(() => {});
    });
  }
  function blockAutomatic() {
    authorizationFailed = true;
    retries.clear();
    task?.controller.abort(new DOMException("Daemon safety barrier", "AbortError"));
  }
  async function stop() {
    const current = task;
    if (!current) return;
    task = undefined;
    current.controller.abort(new DOMException("Daemon monitoring interrupted", "AbortError"));
    await current.continuous.stop();
    await current.promise;
  }
  function unattendedGrant(config: AnySyncConfig) {
    if (!config.continuous || !config.agentMode || !automaticPolicyAuthorized(root, config)) return undefined;
    const saved = readConsent(root)?.setups[config.setupName];
    return saved?.afterExit && saved.fingerprint === consentFingerprint(root, config) ? saved : undefined;
  }
  async function lifetime(): Promise<IdleExitPolicy> {
    if (closed || authorizationFailed) return "pause";
    try {
      const consent = readConsent(root);
      if (!consent || !Object.values(consent.setups).some((saved) => saved.afterExit)) return "exit";
      const config = await loadConfigForCheck();
      if (closed || authorizationFailed) return "pause";
      return !policyNeedsReview() && unattendedGrant(config) ? "keep" : "exit";
    } catch {
      // Invalid evidence is not an implicit revocation or permission to discard a safety barrier.
      return "pause";
    }
  }
  async function start() {
    const service = server;
    if (!service) return;
    if (closed || authorizationFailed || policyNeedsReview() || task || !service.isIdle()) return;
    const generation = settingsGeneration;
    const participants = service.participantGeneration?.();
    const participantsToken = participantBinding(service);
    const consentToken = JSON.stringify(readConsent(root));
    const sameAuthorization = () =>
      !closed &&
      !authorizationFailed &&
      !policyNeedsReview() &&
      server === service &&
      generation === settingsGeneration &&
      participants === service.participantGeneration?.() &&
      participantsToken === participantBinding(service) &&
      consentToken === JSON.stringify(readConsent(root));
    const available = () => !task && service.isIdle() && sameAuthorization();
    if (!consentToken || !available()) return;
    const config = await loadConfigForCheck();
    if (!available() || !automaticPolicyAuthorized(root, config)) return;
    if (!config.continuous || !config.agentMode) {
      retries.clear();
      return;
    }
    const { pendingTransactionEntries } = await import("./engine/snapshot/snapshot-transaction-directory.js");
    if ((await pendingTransactionEntries()).some((entry) => entry.isDirectory()) || !available()) return;
    const peers = service.participants();
    if (peers.some((peer) => !peer.idle || peer.ready !== true)) return;
    const fingerprint = syncCheckConfigFingerprint(config);
    if (config.reservedIgnoreNames !== undefined && monitoredPolicy !== undefined && monitoredPolicy !== fingerprint)
      return;
    const authorized = unattendedGrant(config);
    const selected = peers.toSorted((a, b) => a.id.localeCompare(b.id))[0];
    if (!selected && !authorized) return;
    if (!continuous) {
      const { createContinuousSync } = await import("./engine/sync/continuous-sync.js");
      if (!available()) return;
      continuous = createContinuousSync(loaders, undefined, (ctx, report) =>
        timingOwners.get(ctx)?.emit("timings", { report }),
      );
      // Re-enter every eligibility branch after importing the full engine graph.
      return start();
    }
    const activeContinuous = continuous;
    const binding = selected?.model ?? authorized?.model;
    const sessionDir = selected ? selected.sessionDir : authorized?.sessionDir;
    const cwd = selected?.cwd ?? authorized?.cwd ?? root;
    const key =
      peers
        .map((peer) => `${peer.id}:${peer.generation}`)
        .sort()
        .join(",") || "unattended";
    if (epoch?.key !== key) {
      epoch?.controller.abort(new DOMException("Participating sessions changed", "AbortError"));
      const location = { sessionDir, cwd };
      const manager: EngineSession = {
        getSessionId: () => key,
        getCwd: () => location.cwd,
        getSessionDir: () => location.sessionDir ?? path.join(root, "sessions"),
        usesDefaultSessionDir: () => location.sessionDir === undefined,
      };
      epoch = { key, controller: new AbortController(), manager, location, debug: selected?.startupDebug ?? false };
    }
    epoch.location.sessionDir = sessionDir;
    epoch.location.cwd = cwd;
    const controller = new AbortController();
    const original = service.backgroundExecution(controller.signal);
    const stableFacts: ClientFacts = {
      id: randomUUID(),
      generation: randomUUID(),
      pid: process.pid,
      cwd,
      mode: "rpc",
      hasUI: false,
      idle: true,
      sessionDir,
      model: binding,
    };
    const execution: Execution = { ...original, facts: () => stableFacts };
    const allowed = (currentConfig = config) => {
      if (
        controller.signal.aborted ||
        !sameAuthorization() ||
        syncCheckConfigFingerprint(currentConfig) !== fingerprint
      )
        return false;
      const current = service.participants();
      if (current.length)
        return current.every(
          (peer) =>
            peer.idle &&
            peer.ready === true &&
            JSON.stringify(peer.model) === JSON.stringify(binding) &&
            peer.sessionDir === sessionDir &&
            peer.cwd === cwd,
        );
      const saved = unattendedGrant(currentConfig);
      return Boolean(
        saved &&
          JSON.stringify(saved.model) === JSON.stringify(binding) &&
          saved.sessionDir === sessionDir &&
          (saved.cwd ?? root) === cwd,
      );
    };
    const ctx = createServiceContext(execution);
    ctx.reload = undefined;
    ctx.sessionManager = epoch.manager;
    Object.defineProperty(ctx, "hasUI", {
      get: () => service.participants().some((peer) => peer.hasUI && peer.ready === true),
    });
    timingOwners.set(ctx, execution);
    ctx.backgroundAuthorized = allowed;
    ctx.isIdle = () => Boolean(service.isIdle() && allowed());
    const refresh = async () => {
      execution.validate();
      if (!allowed(await loadConfigForCheck(undefined, controller.signal)))
        throw new Error("Daemon automatic authorization changed.");
      execution.validate();
    };
    const sessionSignal = epoch.controller.signal;
    const debug = epoch.debug;
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const current = { controller, continuous: activeContinuous, promise };
    task = current;
    void host
      .run(execution, async () => {
        const { prepareResolverHost } = await import("./resolver-host.js");
        await refresh();
        const resolver = await prepareResolverHost(root, binding, controller.signal);
        try {
          await refresh();
          if (config.reservedIgnoreNames !== undefined) monitoredPolicy = fingerprint;
          ctx.model = resolver.model;
          ctx.modelUnavailableReason = resolver.unavailable;
          ctx.modelRegistry = {
            streamSimple: (model, context, options) => {
              execution.validate();
              if (!allowed()) throw new Error("Daemon authorization changed before model dispatch.");
              return resolver.registry.streamSimple(model, context, options);
            },
          };
          ctx.validateModel = async () => {
            await refresh();
            for (const peer of peers) {
              const fresh = await execution.request("model-binding", { background: true }, peer.id);
              if (JSON.stringify(fresh ?? undefined) !== JSON.stringify(binding))
                throw new Error("Participating model changed before dispatch.");
              await refresh();
            }
          };
          const explicitRetry = service.participants().some((peer) => {
            const retry = retries.get(peer.id);
            return retry?.fingerprint === fingerprint && retry.owner === retryOwner(peer) && !retry.signal.aborted;
          });
          retries.clear();
          activeContinuous.start(ctx, sessionSignal, explicitRetry ? config.setupName : false, debug, async (run) => {
            await refresh();
            const attempt = new AbortController();
            const owner = service.backgroundExecution(AbortSignal.any([attempt.signal, controller.signal]));
            try {
              return await host.run({ ...owner, facts: execution.facts }, () => run(owner.committed));
            } finally {
              attempt.abort();
            }
          });
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await activeContinuous.stop();
        } finally {
          await resolver.settle();
        }
      })
      .catch(() => {})
      .finally(() => {
        controller.abort();
        if (task === current) task = undefined;
        finish();
      });
  }
  return {
    bind(value: Awaited<ReturnType<typeof startServer>>) {
      server = value;
      schedule();
    },
    schedule,
    lifetime,
    blockAutomatic,
    explicitSync(config: AnySyncConfig, execution: Execution) {
      const peer = execution.facts();
      if (closed || !peer) return;
      const fingerprint = syncCheckConfigFingerprint(config);
      retries.set(peer.id, { fingerprint, owner: retryOwner(peer), signal: execution.signal });
    },
    reviewedPolicy(config: AnySyncConfig) {
      blockedParticipants = undefined;
      monitoredPolicy = config.reservedIgnoreNames === undefined ? undefined : syncCheckConfigFingerprint(config);
    },
    settingsCommitted(blockNewPolicy: boolean) {
      settingsGeneration++;
      retries.clear();
      if (blockNewPolicy) blockedParticipants = participatingSessions();
      task?.controller.abort(new DOMException("Sync settings committed", "AbortError"));
    },
    async pause() {
      transition = transition.then(stop);
      await transition;
    },
    async factsChanged() {
      let failure: unknown;
      try {
        if (server) {
          const peers = server.participants();
          for (const [id, retry] of retries)
            if (retry.signal.aborted || !peers.some((peer) => peer.id === id && retryOwner(peer) === retry.owner))
              retries.delete(id);
          revokeChangedBindings(root, peers);
        }
      } catch (error) {
        blockAutomatic();
        // Recovery barriers must not prevent passive clients from registering protection.
        if (error instanceof ConsentPublicationError) failure = error;
      }
      transition = transition.then(stop);
      await transition;
      if (failure)
        throw new Error(
          "Daemon authorization could not be saved. Automatic work is blocked for this instance; repair and revoke permission before an explicit restart.",
          { cause: failure },
        );
      schedule();
    },
    async close() {
      closed = true;
      retries.clear();
      transition = transition.then(stop);
      await transition;
      epoch?.controller.abort();
    },
  };
}
