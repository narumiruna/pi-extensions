import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { addAbortListener } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import lockfile from "proper-lockfile";
import { DAEMON_BUILD_VERSION } from "./build-version.js";
import { endpointOwner } from "./endpoint.js";
import {
  canonicalRootGuard,
  daemonPaths,
  privateDirectory,
  processExists,
  publishIdentity,
  readIdentity,
  readJsonBody,
  readUpgradeOwner,
  runtimePaths,
} from "./identity.js";
import { createIdleExit, type IdleExitPolicy } from "./idle-exit.js";
import { withCleanup } from "./lifecycle.js";
import { ParticipantAdmission } from "./participant-admission.js";
import {
  type Callback,
  type ClientContact,
  ClientContactExpiredError,
  type ClientEvent,
  type ClientFacts,
  type ClientHandoff,
  DaemonStoppingError,
  type Execute,
  type Execution,
  type Identity,
  type JobView,
  MAX_MESSAGE_BYTES,
  MAX_REVIEW_BYTES,
  operationPrefix,
  type PollReply,
  PROTOCOL_VERSION,
  REVIEW_PAGE_CHARS,
  record,
  remoteError,
  validateFacts,
  validateHandoff,
  validId,
} from "./protocol.js";

interface Participant {
  facts: ClientFacts;
  callbacks: Map<string, Callback>;
  events: ClientEvent[];
  connected: boolean;
  closing: boolean;
  suspected: boolean;
  seen: number;
  publishing?: boolean;
  handoff?: ClientHandoff;
  // This instance's expiry episode; never restored from clients.json.
  expiry?: AbortController;
  resumeFacts?: ClientFacts;
  reservations?: Set<string>;
  resumeUnsafe?: boolean;
}
interface Job {
  view: JobView;
  digest: string;
  client?: string;
  generation?: string;
  controller: AbortController;
  committed: boolean;
  promise: Promise<void>;
  peers: Set<string>;
}
interface Pending {
  callback: Callback;
  review?: string;
  target: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
export interface ServerHooks {
  factsChanged?(): Promise<void>;
  idle?(): void;
  close?(): Promise<void>;
  lifetime?(): Promise<IdleExitPolicy>;
  quiesce?(): Promise<void>;
  stopped?(): void;
  failure?(): void;
}

export async function startServer(root: string, execute: Execute, hooks: ServerHooks = {}) {
  const base = await runtimePaths(root);
  const identity: Identity = {
    version: 1,
    root: base.root,
    instance: randomUUID(),
    pid: process.pid,
    token: randomBytes(32).toString("hex"),
  };
  const paths = daemonPaths(base, identity.instance);
  const assertRoot = canonicalRootGuard(paths.root);
  assertRoot();
  await privateDirectory(paths.directory);
  const previous = await readIdentity(paths);
  if (previous && processExists(previous.pid)) throw new Error("A daemon owner is still alive; refusing replacement.");
  let compromised = false;
  let published = false;
  const release = await lockfile.lock(paths.directory, {
    realpath: false,
    lockfilePath: paths.owner,
    stale: 30_000,
    update: 5_000,
    onCompromised: () => {
      compromised = true;
      if (published) void close().catch(() => {});
    },
  });
  const participants = new Map<string, Participant>();
  const admission = new ParticipantAdmission();
  const jobs = new Map<string, Job>();
  const backgroundJobs = new Set<Job>();
  const cancelled = new Set<string>();
  const closedClients = new Set<string>();
  // Retain tombstones after result eviction; replay must never dispatch a second write.
  const retired = new Set<string>();
  const pending = new Map<string, Pending>();
  const peersFile = path.join(paths.directory, "clients.json");
  let sequence = 0;
  let closed = false;
  let stopRequested = false;
  let automaticClosing = false;
  let peerWriteFailed = false;
  let idleExit: ReturnType<typeof createIdleExit> | undefined;
  let expiring: Promise<void> | undefined;
  const peerOperations = new Set<Promise<unknown>>();
  let queue = Promise.resolve();
  let closing: Promise<void> | undefined;
  let peerWrites = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function savePeers(candidate?: { peer: Participant; facts: ClientFacts }) {
    idleExit?.changed();
    const operation = peerWrites.then(() => writePeers(candidate));
    peerWrites = operation.catch(() => {
      peerWriteFailed = true;
      hooks.failure?.();
    });
    return operation;
  }
  async function writePeers(candidate?: { peer: Participant; facts: ClientFacts }) {
    const temporary = path.join(paths.directory, `.${randomUUID()}.clients`);
    const data = {
      version: 1,
      root: paths.root,
      clients: [...participants.values()]
        .filter((peer) => processExists(peer.facts.pid))
        .map((peer) => ({ ...(candidate?.peer === peer ? candidate.facts : peer.facts), handoff: peer.handoff })),
    };
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, peersFile);
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true });
    }
  }
  try {
    try {
      const before = await fs.lstat(peersFile);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > MAX_MESSAGE_BYTES ||
        (process.getuid && before.uid !== process.getuid()) ||
        (process.platform !== "win32" && before.mode & 0o077)
      )
        throw new Error("Unsafe daemon client record.");
      const handle = await fs.open(peersFile, "r");
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino)
          throw new Error("Daemon client record changed while opening.");
        const data: unknown = JSON.parse(await handle.readFile("utf8"));
        if (
          !record(data) ||
          data.version !== 1 ||
          data.root !== paths.root ||
          !Array.isArray(data.clients) ||
          data.clients.length > 64
        )
          throw new Error("Invalid daemon client record; evidence retained.");
        for (const stored of data.clients) {
          if (!record(stored)) throw new Error("Invalid stored participant.");
          const { handoff, ...value } = stored;
          validateFacts(value);
          if (handoff !== undefined) validateHandoff(handoff);
          if (processExists(value.pid)) {
            if (handoff?.kind === "exit") closedClients.add(value.id);
            participants.set(value.id, {
              facts: value,
              handoff,
              callbacks: new Map(),
              events: [],
              connected: false,
              closing: false,
              suspected: handoff?.kind !== "exit",
              seen: 0,
            });
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    await release();
    throw error;
  }
  const known = async () => {
    const current = await readIdentity(paths);
    return current?.instance === identity.instance && current.pid === process.pid && current.token === identity.token;
  };
  const emit = (kind: ClientEvent["kind"], payload: unknown, target?: string) => {
    const event: ClientEvent = { id: ++sequence, kind, payload };
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_MESSAGE_BYTES / 8)
      throw new Error("Notification exceeds the local API limit; use bounded diagnostics. No review was truncated.");
    for (const [id, peer] of participants) {
      if (target && id !== target) continue;
      peer.events.push(event);
      while (peer.events.length > 128 || Buffer.byteLength(JSON.stringify(peer.events)) > MAX_MESSAGE_BYTES / 8)
        peer.events.shift();
    }
  };
  const assertOwner = () => {
    if (automaticClosing && !compromised) throw new DaemonStoppingError();
    if (closed || compromised) throw new Error("Daemon ownership is no longer valid.");
    assertRoot();
  };
  const requireParticipant = (id: unknown, cleanup = false) => {
    if (!validId(id)) throw new Error("Invalid client identity.");
    const peer = participants.get(id);
    if (
      !peer ||
      (!cleanup &&
        (peer.publishing ||
          !peer.connected ||
          peer.closing ||
          Date.now() - peer.seen > 5_000 ||
          !processExists(peer.facts.pid)))
    )
      throw new Error("Client is not attached or is closing.");
    return peer;
  };
  const liveClientFacts = () =>
    [...participants.values()].filter((peer) => processExists(peer.facts.pid)).map((peer) => peer.facts);
  const participantFacts = () =>
    [...participants.values()]
      .filter((peer) => !peer.publishing && (peer.connected || peer.suspected) && processExists(peer.facts.pid))
      .map((peer) =>
        peer.closing || peer.suspected ? { ...(peer.resumeFacts ?? peer.facts), idle: false } : peer.facts,
      );
  const contactState = (peer: Participant): ClientContact => {
    if (closed || stopRequested || compromised || peer.publishing || peer.closing || !processExists(peer.facts.pid))
      return "inactive";
    if (peer.connected) return "active";
    return peer.expiry ? "expired" : "inactive";
  };
  const poll = (peer: Participant, cursor: unknown, job?: Job): PollReply => ({
    contact: contactState(peer),
    cursor: sequence,
    callbacks: [...peer.callbacks.values()],
    events: peer.events.filter(
      (event) => event.id > (typeof cursor === "number" && Number.isSafeInteger(cursor) ? cursor : 0),
    ),
    job: job?.view,
  });
  function makeExecution(job: Job): Execution {
    const validate = () => {
      if (compromised) throw new Error("Daemon ownership is no longer valid.");
      // Finish journal/publication bookkeeping after commit even if a UI detaches or stop begins.
      if (job.committed) {
        assertRoot();
        return;
      }
      assertOwner();
      job.controller.signal.throwIfAborted();
      if (job.client) {
        const peer = requireParticipant(job.client);
        if (peer.facts.generation !== job.generation) throw new Error("Client session generation changed.");
      }
    };
    const request = (kind: string, data: unknown, target = job.client, signal = job.controller.signal) => {
      const cleanup = kind === "queue-release";
      if (!cleanup) validate();
      if (!target) throw new Error("This operation requires an attached UI client.");
      const peer = requireParticipant(target, cleanup);
      const callback: Callback = { id: randomUUID(), job: job.view.id, kind, payload: data };
      let review: string | undefined;
      if (
        kind === "merge-review" &&
        record(data) &&
        typeof data.content === "string" &&
        Buffer.byteLength(data.content) > REVIEW_PAGE_CHARS
      ) {
        const bytes = Buffer.byteLength(data.content);
        if (bytes > MAX_REVIEW_BYTES)
          throw new Error("Exact review exceeds its byte limit; no truncated review was approved.");
        review = data.content;
        callback.payload = { ...data, content: undefined };
        callback.review = {
          pages: Math.ceil(review.length / REVIEW_PAGE_CHARS),
          bytes,
          sha256: createHash("sha256").update(review).digest("hex"),
        };
      }
      if (
        peer.callbacks.size >= 64 ||
        Buffer.byteLength(JSON.stringify([...peer.callbacks.values(), callback])) > MAX_MESSAGE_BYTES / 8
      )
        throw new Error("Callback exceeds its byte limit; no review was approved.");
      job.peers.add(target);
      const reservation = record(data) && typeof data.reservation === "string" ? data.reservation : undefined;
      if (kind === "queue-acquire" || cleanup) {
        // A lost acquire response is not proof that Pi never acquired the queue.
        // Bound retained evidence even if a failing or malformed executor keeps requesting grants.
        peer.reservations ??= new Set();
        if (!reservation) peer.resumeUnsafe = true;
        else if (peer.reservations.size < 64) peer.reservations.add(reservation);
        else if (!peer.reservations.has(reservation)) peer.resumeUnsafe = true;
      }
      return new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const effectiveSignal = cleanup ? undefined : signal;
        const abort = () => finish(undefined, effectiveSignal?.reason);
        const finish = (value: unknown, error?: unknown) => {
          if (timer) clearTimeout(timer);
          effectiveSignal?.removeEventListener("abort", abort);
          if (!pending.delete(callback.id)) return;
          peer.callbacks.delete(callback.id);
          if (cleanup && reservation && error === undefined && value === true) peer.reservations?.delete(reservation);
          sequence++;
          if (error) reject(error);
          else resolve(value);
        };
        pending.set(callback.id, {
          callback,
          review,
          target,
          resolve: (value) => finish(value),
          reject: (error) => finish(undefined, error),
        });
        peer.callbacks.set(callback.id, callback);
        sequence++;
        effectiveSignal?.addEventListener("abort", abort, { once: true });
        if (kind.startsWith("queue-")) {
          timer = setTimeout(
            () => finish(undefined, new Error("Client file-queue acknowledgement timed out; work was stopped.")),
            30_000,
          );
          timer.unref?.();
        }
        if (effectiveSignal?.aborted) abort();
      });
    };
    return {
      root: paths.root,
      clientId: job.client,
      signal: job.controller.signal,
      facts: () => (job.client ? participants.get(job.client)?.facts : undefined),
      participants: participantFacts,
      liveClients: liveClientFacts,
      withParticipants: (action) =>
        admission.run(
          async () => {
            validate();
            return action(participantFacts());
          },
          job.committed ? undefined : job.controller.signal,
        ),
      validate,
      request,
      emit: (kind, data, target = job.client) => emit(kind, data, target),
      committed: () => {
        job.committed = true;
        emit("commit", { job: job.view.id }, job.client);
      },
    };
  }
  function enqueue(id: string, client: string, operation: string, payload: unknown): Job {
    const peer = requireParticipant(client);
    if (!id.startsWith(operationPrefix(identity)))
      throw new Error("Operation belongs to another daemon instance; reconcile journals instead of replaying.");
    const digest = createHash("sha256").update(JSON.stringify({ client, operation, payload })).digest("hex");
    const duplicate = jobs.get(id);
    if (duplicate) {
      if (duplicate.digest !== digest || duplicate.client !== client)
        throw new Error("Operation ID was reused with different input.");
      return duplicate;
    }
    if (retired.has(id))
      throw new Error("Operation result expired; reconcile the existing journal before starting new work.");
    if (retired.size + jobs.size >= 4096)
      throw new Error("Daemon operation ledger is full; drain and restart explicitly.");
    if (jobs.size >= 64) {
      for (const [key, job] of jobs)
        if (job.view.phase === "done" || job.view.phase === "failed") {
          retired.add(key);
          jobs.delete(key);
          break;
        }
      if (jobs.size >= 64) throw new Error("Daemon job capacity reached.");
    }
    const job: Job = {
      view: { id, phase: "queued" },
      digest,
      client,
      generation: peer.facts.generation,
      controller: new AbortController(),
      committed: false,
      promise: Promise.resolve(),
      peers: new Set(),
    };
    if (cancelled.has(`${client}:${id}`))
      job.controller.abort(new DOMException("Operation cancelled before dispatch", "AbortError"));
    const execution = makeExecution(job);
    job.promise = queue
      .then(async () => {
        execution.validate();
        job.view.phase = "running";
        const result = await execute(operation, payload, execution);
        if (Buffer.byteLength(JSON.stringify(result ?? null)) > MAX_MESSAGE_BYTES / 2)
          throw new Error("Operation result exceeds its byte limit; use bounded inspection.");
        job.view.result = result;
        job.view.phase = "done";
      })
      .catch((error) => {
        job.view.phase = "failed";
        job.view.error = remoteError(error);
        if (job.committed)
          for (const id of new Set([client, ...job.peers])) {
            const affected = participants.get(id);
            if (affected) affected.resumeUnsafe = true;
          }
      })
      .finally(() => {
        for (const waiting of [...pending.values()])
          if (waiting.callback.job === id) waiting.reject(new Error("Operation finished."));
        hooks.idle?.();
      });
    queue = job.promise;
    jobs.set(id, job);
    return job;
  }
  function invalidateExpiry(peer: Participant) {
    peer.expiry?.abort(new DOMException("Client is no longer eligible to resume contact", "AbortError"));
    peer.expiry = undefined;
    peer.resumeFacts = undefined;
  }
  async function resumeContact(facts: ClientFacts, disconnect?: AbortSignal) {
    const peer = requireParticipant(facts.id, true);
    const expiry = peer.expiry;
    const matchesSession = (old: ClientFacts) =>
      old.pid === facts.pid &&
      old.generation === facts.generation &&
      old.cwd === facts.cwd &&
      old.sessionId === facts.sessionId &&
      old.sessionFile === facts.sessionFile &&
      old.sessionDir === facts.sessionDir &&
      old.mode === facts.mode &&
      old.hasUI === facts.hasUI;
    if (!expiry || contactState(peer) !== "expired" || peer.resumeFacts || !matchesSession(peer.facts))
      throw new Error("Client is not eligible to resume contact for this session.");
    const signal = disconnect ? AbortSignal.any([disconnect, expiry.signal]) : expiry.signal;
    const candidate = structuredClone(facts);
    const recheck = () => {
      assertOwner();
      signal.throwIfAborted();
      if (peerWriteFailed)
        throw new Error(
          "Daemon client ledger persistence is uncertain; reconcile with the existing owner before reconnecting.",
        );
      if (
        participants.get(facts.id) !== peer ||
        peer.expiry !== expiry ||
        contactState(peer) !== "expired" ||
        !matchesSession(peer.facts)
      )
        throw new Error("Client is no longer eligible to resume contact.");
    };
    const affected = (job: Job) => job.client === facts.id || job.peers.has(facts.id);
    const running = (job: Job) => affected(job) && job.view.phase === "running";
    const stopped = Promise.withResolvers<never>();
    const abort = addAbortListener(signal, () => stopped.reject(signal.reason));
    try {
      recheck();
      // Expose the new binding to the monitor, but only as a non-ready, busy suspect.
      peer.resumeFacts = { ...candidate, ready: false };
      // Never wait for jobs or monitor transitions inside admission: they can need the fence.
      await Promise.race([
        Promise.all([hooks.factsChanged?.(), ...[...jobs.values()].filter(running).map((job) => job.promise)]),
        stopped.promise,
      ]);
      recheck();
      return await admission.run(async () => {
        const safe = () => {
          recheck();
          if (
            peer.resumeUnsafe ||
            peer.reservations?.size ||
            peer.callbacks.size ||
            [...jobs.values()].some(running) ||
            [...backgroundJobs].some((job) => job.committed && affected(job))
          )
            throw new Error(
              "Client work or file-queue cleanup is uncertain; reconcile with the existing owner before reconnecting.",
            );
        };
        safe();
        // The staged facts have the same location and identity. Even if cancelled mid-write,
        // the on-disk record does not authorize work or confer expiry eligibility on restart.
        await savePeers({ peer, facts: candidate });
        safe();
        peer.facts = candidate;
        peer.seen = Date.now();
        peer.expiry = undefined;
        peer.resumeFacts = undefined;
        peer.suspected = false;
        peer.connected = true;
        hooks.idle?.();
        return poll(peer, 0);
      }, signal);
    } finally {
      abort[Symbol.dispose]();
      if (peer.expiry === expiry) peer.resumeFacts = undefined;
    }
  }
  async function detach(id: string, retain = false, handoff?: ClientHandoff) {
    const peer = participants.get(id);
    if (!peer) {
      if (closedClients.size < 10_000) closedClients.add(id);
      return { contact: "inactive", cursor: sequence, callbacks: [], events: [] } satisfies PollReply;
    }
    if (closedClients.has(id)) return poll(peer, 0);
    peer.closing = true;
    invalidateExpiry(peer);
    for (const waiting of [...pending.values()])
      if (waiting.target === id && !waiting.callback.kind.startsWith("queue-"))
        waiting.reject(new Error("Client detaching."));
    await hooks.factsChanged?.();
    const affected = [...jobs.values(), ...backgroundJobs].filter((job) => job.client === id || job.peers.has(id));
    for (const job of affected)
      if (!job.committed) job.controller.abort(new DOMException("Client detached", "AbortError"));
    await Promise.allSettled(affected.map((job) => job.promise));
    peer.connected = false;
    // Orderly exit remains protected by PID, but is not an ambiguous active participant.
    peer.suspected = retain && handoff?.kind !== "exit";
    peer.closing = false;
    peer.handoff = handoff ?? (retain ? undefined : { kind: "exit" });
    if (!retain || handoff?.kind === "exit") closedClients.add(id);
    await savePeers();
    const result = poll(peer, 0);
    hooks.idle?.();
    return result;
  }
  async function handle(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (automaticClosing && method !== "stop") throw new DaemonStoppingError();
    const cleanup = ["answer", "poll", "cancel", "detach", "pause", "handoff", "stop"].includes(method);
    if (!published && !cleanup) throw new Error("Daemon readiness is not published.");
    if (!cleanup) assertOwner();
    if (method === "hello")
      return {
        version: PROTOCOL_VERSION,
        buildVersion: DAEMON_BUILD_VERSION,
        root: identity.root,
        instance: identity.instance,
        pid: identity.pid,
      };
    if (method === "attach") {
      const attached = await admission.run(async () => {
        assertOwner();
        validateFacts(params);
        if (closedClients.has(params.id)) throw new Error("Client was retired; attach a new client identity.");
        if (closedClients.size >= 10_000)
          throw new Error("Client retirement ledger is full; stop and restart the service.");
        if (!processExists(params.pid)) throw new Error("Client process is not alive.");
        for (const [id, peer] of participants)
          if (!processExists(peer.facts.pid) && !peer.callbacks.size) participants.delete(id);
        if (!participants.has(params.id) && participants.size >= 64) throw new Error("Daemon client capacity reached.");
        const old = participants.get(params.id);
        if (
          old &&
          (old.facts.pid !== params.pid ||
            ((old.connected || old.suspected) && old.facts.generation !== params.generation))
        )
          throw new Error("Client identity collision.");
        if (old) invalidateExpiry(old);
        participants.set(params.id, {
          facts: structuredClone(params),
          reservations: old?.reservations,
          resumeUnsafe: old?.resumeUnsafe,
          callbacks: old?.callbacks ?? new Map(),
          events: old?.events ?? [],
          connected: true,
          closing: false,
          suspected: false,
          seen: Date.now(),
          publishing: !old,
        });
        try {
          await savePeers();
          assertOwner();
        } catch (error) {
          if (old) participants.set(params.id, old);
          else participants.delete(params.id);
          throw error;
        }
        const attached = requireParticipant(params.id, true);
        attached.publishing = false;
        // A shutdown-confirmed handoff keeps protection across SDK invalidation.
        // Publish the replacement first, then retire only the matching closed scope.
        for (const [id, peer] of participants) {
          const next = peer.handoff;
          if (id === params.id || peer.facts.pid !== params.pid || next?.kind !== "replace") continue;
          const matches =
            next.file !== undefined
              ? next.file === params.sessionFile
              : next.sessionId !== undefined
                ? next.sessionId === params.sessionId
                : params.sessionFile === undefined && next.cwd === params.cwd;
          if (matches) {
            participants.delete(id);
            closedClients.add(id);
          }
        }
        await savePeers();
        assertOwner();
        return attached;
      }, signal);
      // Monitoring can await a queued reservation; never call it while admission is held.
      await hooks.factsChanged?.();
      assertOwner();
      return poll(attached, 0);
    }
    if (method === "resume-contact") {
      validateFacts(params);
      return resumeContact(params, signal);
    }
    if (!record(params)) throw new Error("Invalid request parameters.");
    const contact = typeof params.client === "string" ? participants.get(params.client) : undefined;
    if (contact) contact.seen = Date.now();
    if (method === "update" && record(params.facts) && typeof params.facts.id === "string") {
      const peer = participants.get(params.facts.id);
      if (peer) peer.seen = Date.now();
    }
    if (method === "update") {
      validateFacts(params.facts);
      const peer = requireParticipant(params.facts.id, true);
      const old = peer.facts;
      if (old.pid !== params.facts.pid || old.generation !== params.facts.generation)
        throw new Error("Client generation mismatch.");
      if (contactState(peer) === "expired") throw new ClientContactExpiredError();
      requireParticipant(params.facts.id);
      peer.facts = structuredClone(params.facts);
      const published = peer.facts;
      try {
        await savePeers();
      } catch (error) {
        if (peer.facts === published) peer.facts = old;
        throw error;
      }
      await hooks.factsChanged?.();
      assertOwner();
      if (participants.get(params.facts.id) !== peer) throw new Error("Client changed during update.");
      const reply = poll(peer, 0);
      if (reply.contact === "expired") throw new ClientContactExpiredError();
      if (reply.contact !== "active") throw new Error("Client is not attached or is closing.");
      return reply;
    }
    if (["detach", "pause", "handoff"].includes(method)) {
      if (!validId(params.client)) throw new Error("Invalid client.");
      const peer = participants.get(params.client);
      if (
        peer &&
        ((params.generation !== undefined && params.generation !== peer.facts.generation) ||
          (params.pid !== undefined && params.pid !== peer.facts.pid))
      )
        throw new Error("Stale client cleanup cannot detach a replacement generation.");
      if (method === "handoff") validateHandoff(params.handoff);
      return detach(
        params.client,
        method !== "detach",
        method === "handoff" ? (params.handoff as ClientHandoff) : undefined,
      );
    }
    if (method === "submit") {
      if (
        !validId(params.id) ||
        !validId(params.client) ||
        typeof params.operation !== "string" ||
        params.operation.length > 64
      )
        throw new Error("Invalid operation envelope.");
      return enqueue(params.id, params.client, params.operation, params.payload).view;
    }
    if (method === "poll") {
      const peer = requireParticipant(params.client, true);
      const job = typeof params.job === "string" ? jobs.get(params.job) : undefined;
      if (params.job !== undefined && !job)
        throw new Error("Operation is unknown or its result expired; reconcile journals instead of replaying.");
      if (job && job.client !== params.client) throw new Error("Operation belongs to another client.");
      return poll(peer, params.cursor, job);
    }
    if (method === "review-page") {
      requireParticipant(params.client);
      const waiting = typeof params.id === "string" ? pending.get(params.id) : undefined;
      if (
        !waiting?.review ||
        waiting.target !== params.client ||
        !Number.isSafeInteger(params.index) ||
        Number(params.index) < 0 ||
        Number(params.index) >= Math.ceil(waiting.review.length / REVIEW_PAGE_CHARS)
      )
        throw new Error("Stale, foreign, or invalid review page.");
      const start = Number(params.index) * REVIEW_PAGE_CHARS;
      return { id: params.id, index: params.index, content: waiting.review.slice(start, start + REVIEW_PAGE_CHARS) };
    }
    if (method === "answer") {
      requireParticipant(params.client, true);
      const waiting = typeof params.id === "string" ? pending.get(params.id) : undefined;
      if (!waiting || waiting.target !== params.client) throw new Error("Stale or foreign callback response.");
      if (typeof params.error === "string") waiting.reject(new Error(params.error.slice(0, 1024)));
      else waiting.resolve(params.value);
      return {};
    }
    if (method === "cancel") {
      requireParticipant(params.client, true);
      if (!validId(params.id)) throw new Error("Invalid operation identity.");
      const job = jobs.get(params.id);
      if (!job) {
        if (cancelled.size >= 128) throw new Error("Cancellation capacity reached.");
        cancelled.add(`${params.client}:${params.id}`);
        return { cancelled: true };
      }
      if (job.client !== params.client) throw new Error("Operation belongs to another client.");
      if (!job.committed) job.controller.abort(new DOMException("Operation cancelled", "AbortError"));
      await job.promise;
      return job.view;
    }
    if (method === "stop") {
      stopRequested = true;
      setImmediate(() => {
        void close().catch(() => {});
      });
      return { stopping: true };
    }
    throw new Error("Unknown daemon method.");
  }
  const respond = (response: ServerResponse, status: number, value: unknown) => {
    let encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
      status = 413;
      encoded = JSON.stringify({ error: { name: "Error", message: "Daemon response exceeds its byte limit." } });
    }
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(encoded);
  };
  const server = createServer(async (request, response) => {
    let admissionController: AbortController | undefined;
    const disconnect = () => admissionController?.abort(new DOMException("Client disconnected", "AbortError"));
    try {
      if (request.method !== "POST" || request.url !== "/v1") {
        respond(response, 404, { error: { message: "Not found." } });
        return;
      }
      const body = await readJsonBody(request);
      if (
        !record(body) ||
        body.version !== 1 ||
        body.root !== identity.root ||
        body.instance !== identity.instance ||
        typeof body.token !== "string" ||
        !/^[a-f0-9]{64}$/u.test(body.token) ||
        !timingSafeEqual(Buffer.from(body.token), Buffer.from(identity.token)) ||
        typeof body.method !== "string"
      ) {
        respond(response, 403, { error: { name: "Error", message: "Invalid daemon identity or protocol." } });
        return;
      }
      if (body.method === "attach" || body.method === "resume-contact") {
        admissionController = new AbortController();
        response.once("close", disconnect);
        if (response.destroyed) disconnect();
      }
      const operation = handle(body.method, body.params, admissionController?.signal);
      if (["attach", "resume-contact", "update", "detach", "pause", "handoff"].includes(body.method)) {
        peerOperations.add(operation);
        void operation.finally(() => peerOperations.delete(operation)).catch(() => {});
      }
      respond(response, 200, { result: await operation });
    } catch (error) {
      if (!response.destroyed) respond(response, 400, { error: remoteError(error) });
    } finally {
      response.removeListener("close", disconnect);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const endpoint = endpointOwner(server, paths);
  try {
    assertOwner();
    if (await readUpgradeOwner(paths))
      throw new Error("A daemon upgrade is pending; use normal startup to verify the previous owner.");
    assertOwner();
    await endpoint.listen();
    assertOwner();
    await publishIdentity(paths, identity);
    assertOwner();
    published = true;
  } catch (error) {
    closed = true;
    return withCleanup(
      async () => {
        throw error;
      },
      () => withCleanup(() => endpoint.close(), release),
    );
  }
  function expireClients(): Promise<void> {
    expiring ??= expire().finally(() => {
      expiring = undefined;
    });
    return expiring;
  }
  async function expire() {
    if (closed) return;
    let changed = false;
    for (const [id, peer] of participants) {
      const exited = !processExists(peer.facts.pid);
      if (!exited && (!peer.connected || Date.now() - peer.seen <= 5_000)) continue;
      peer.connected = false;
      peer.suspected = !exited;
      if (exited) invalidateExpiry(peer);
      else if (!peer.closing && !peer.publishing) peer.expiry = new AbortController();
      changed = true;
      for (const job of [...jobs.values(), ...backgroundJobs])
        if (!job.committed && (job.client === id || job.peers.has(id)))
          job.controller.abort(new DOMException(exited ? "Client exited" : "Client contact expired", "AbortError"));
      if (exited) {
        for (const waiting of [...pending.values()])
          if (waiting.target === id) {
            if (waiting.callback.kind === "queue-release") waiting.resolve(true);
            else waiting.reject(new Error("Client process exited."));
          }
        participants.delete(id);
      }
      // Contact expiry alone retains the live session and its uncertain grants.
    }
    if (changed) {
      await savePeers();
      await hooks.factsChanged?.();
    }
  }
  const lifetime = async (): Promise<IdleExitPolicy> =>
    closed || compromised || peerWriteFailed ? "pause" : ((await hooks.lifetime?.()) ?? "pause");
  if (hooks.lifetime) {
    idleExit = createIdleExit({
      live: () => liveClientFacts().length > 0,
      policy: lifetime,
      quiesce: async () => {
        for (const job of [...jobs.values(), ...backgroundJobs])
          if (!job.committed) job.controller.abort(new DOMException("Daemon idle shutdown", "AbortError"));
        await hooks.quiesce?.();
        await Promise.allSettled([...jobs.values()].map((job) => job.promise));
        await Promise.allSettled([...peerOperations]);
        await expiring;
        await peerWrites;
      },
      close: (current) =>
        admission.run(async () => {
          if (!current() || closed || peerWriteFailed || peerOperations.size) return false;
          await peerWrites;
          const owned = await known();
          const policy = await lifetime();
          if (
            !owned ||
            policy !== "exit" ||
            !current() ||
            closed ||
            compromised ||
            peerWriteFailed ||
            peerOperations.size ||
            backgroundJobs.size ||
            pending.size ||
            [...jobs.values()].some((job) => job.view.phase === "queued" || job.view.phase === "running")
          )
            return false;
          assertRoot();
          // Fence new admissions synchronously, then close outside the gate and monitor transition.
          automaticClosing = true;
          closed = true;
          setImmediate(() => {
            void close().catch(() => {});
          });
          return true;
        }),
      resume: () => hooks.idle?.(),
      failed: () => hooks.failure?.(),
    });
    void idleExit.tick();
  }
  heartbeat = setInterval(() => {
    void expireClients()
      .then(() => idleExit?.tick())
      .catch(() => {});
  }, 1_000);
  heartbeat.unref();
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      closed = true;
      for (const peer of participants.values()) invalidateExpiry(peer);
      clearInterval(heartbeat);
      for (const waiting of [...pending.values()])
        if (!waiting.callback.kind.startsWith("queue-")) waiting.reject(new Error("Daemon stopping."));
      for (const job of [...jobs.values(), ...backgroundJobs])
        if (!job.committed) job.controller.abort(new DOMException("Daemon stopping", "AbortError"));
      await idleExit?.dispose();
      let closeError: unknown;
      try {
        await hooks.close?.();
      } catch (error) {
        closeError = error;
      }
      await Promise.allSettled([...jobs.values()].map((job) => job.promise));
      await admission.run(async () => {});
      await Promise.allSettled([...peerOperations]);
      await expiring;
      await peerWrites;
      for (const waiting of [...pending.values()]) waiting.reject(new Error("Daemon stopping."));
      // A failed engine drain must retain the live owner, not permit an implicit restart.
      if (closeError) throw closeError;
      await endpoint.close();
      if (await known()) await fs.rm(paths.identity, { force: true });
      await release();
      hooks.stopped?.();
    })().catch((error) => {
      hooks.failure?.();
      closing = undefined;
      throw error;
    });
    return closing;
  }
  function backgroundExecution(signal: AbortSignal): Execution {
    assertOwner();
    const job: Job = {
      view: { id: randomUUID(), phase: "running" },
      digest: "",
      controller: new AbortController(),
      committed: false,
      promise: Promise.resolve(),
      peers: new Set(),
    };
    const abort = () => {
      job.controller.abort(signal.reason);
      backgroundJobs.delete(job);
    };
    signal.addEventListener("abort", abort, { once: true });
    backgroundJobs.add(job);
    if (signal.aborted) abort();
    return makeExecution(job);
  }
  return {
    identity,
    paths,
    close,
    backgroundExecution,
    get retainedEndpoint() {
      return endpoint.retainedDirectory;
    },
    participants: participantFacts,
    liveClients: liveClientFacts,
    expireClients,
    // The heartbeat and deterministic lifecycle tests use the same evaluation boundary.
    checkLifetime: () => idleExit?.tick() ?? Promise.resolve(),
    isIdle: () =>
      !closed && [...jobs.values()].every((job) => job.view.phase !== "queued" && job.view.phase !== "running"),
    get closed() {
      return closed;
    },
  };
}
