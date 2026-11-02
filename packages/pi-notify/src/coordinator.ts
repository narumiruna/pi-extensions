import { randomUUID } from "node:crypto";
import { isUserActivity } from "./activity.js";
import { type Metadata, notificationMetadata } from "./metadata.js";
import { type DeliveryResult, type Destination, deliver, type Notification, type Providers } from "./provider.js";
import type { Settings } from "./settings.js";

interface Work {
  id: string;
  startedAt: number;
  error: boolean;
  revision: number;
}
interface Pending {
  work: Work;
  dueAt: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  notification?: Notification;
}
export interface DeliveryStatus {
  sequence: number;
  result: DeliveryResult | { state: "sending" };
}

/** Session-owned policy. Providers receive only immutable notification data and cancellation. */
export class Coordinator {
  private alive = true;
  private revision = 0;
  private sequence = 0;
  private work?: Work;
  private pending?: Pending;
  private lastActivity = Date.now();
  private readonly tasks = new Map<Promise<unknown>, AbortController>();
  readonly statuses = new Map<string, DeliveryStatus>();
  constructor(
    private settings: Settings,
    private readonly providers: Providers,
    private readonly tui: boolean,
    private readonly metadata: typeof notificationMetadata = notificationMetadata,
    private readonly onFailure: () => void = () => {},
  ) {}
  get pendingAt(): number | undefined {
    return this.pending?.dueAt;
  }
  observeActivity(): void {
    // Loading settings can take time; do not infer absence before observation starts.
    this.lastActivity = Date.now();
  }
  begin(replace = false): void {
    if (!this.alive) return;
    this.cancelPending();
    if (!this.work || replace)
      this.work = { id: randomUUID(), startedAt: Date.now(), error: false, revision: this.revision };
  }
  assistant(error: boolean): void {
    if (this.work) this.work.error = error;
  }
  input(data: string): void {
    if (this.tui && this.alive && isUserActivity(data)) {
      this.lastActivity = Date.now();
      this.cancelPending();
    }
  }
  apply(settings: Settings): void {
    this.cancelPending();
    this.revision++;
    this.settings = settings;
    for (const id of this.statuses.keys()) if (!Object.hasOwn(settings.destinations, id)) this.statuses.delete(id);
  }
  private cancelPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
  }
  settle(aborted: boolean, data: Pick<Metadata, "sessionId" | "sessionName" | "cwd">): void {
    const work = this.work;
    this.work = undefined;
    if (
      !this.alive ||
      !work ||
      work.revision !== this.revision ||
      aborted ||
      !this.settings.enabled ||
      !this.settings.targetIds.length
    )
      return;
    this.cancelPending();
    const now = Date.now();
    const dueAt =
      this.tui && this.settings.mode === "after-inactivity"
        ? Math.max(now, this.lastActivity + this.settings.inactivitySeconds * 1000)
        : now;
    const pending: Pending = { work, dueAt, controller: new AbortController() };
    this.pending = pending;
    if (dueAt > now) {
      pending.timer = setTimeout(() => this.trySend(pending), dueAt - now);
      pending.timer.unref?.();
    }
    const task = this.metadata({ ...data, ...work, settledAt: now }, pending.controller.signal)
      .then((notification) => {
        if (this.pending !== pending || !this.alive || pending.controller.signal.aborted) return;
        pending.notification = notification;
        this.trySend(pending);
      })
      .catch(() => {
        if (this.pending === pending) this.cancelPending();
      });
    this.track(task, pending.controller);
  }
  private trySend(pending: Pending): void {
    if (
      !this.alive ||
      this.pending !== pending ||
      pending.controller.signal.aborted ||
      this.work ||
      Date.now() < pending.dueAt ||
      !pending.notification ||
      !this.settings.enabled
    )
      return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    const notification = pending.notification;
    for (const id of this.settings.targetIds) {
      const destination = this.settings.destinations[id];
      if (destination) void this.send(id, destination, notification);
    }
  }
  private track<T>(promise: Promise<T>, controller: AbortController): Promise<T> {
    this.tasks.set(promise, controller);
    void promise.finally(() => this.tasks.delete(promise)).catch(() => {});
    return promise;
  }
  send(
    id: string,
    destination: Destination,
    notification: Notification,
    signal?: AbortSignal,
  ): Promise<DeliveryResult> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (!this.alive) controller.abort();
    const sequence = ++this.sequence;
    this.statuses.set(id, { sequence, result: { state: "sending" } });
    const task = deliver(this.providers, destination, notification, combined).then((result) => {
      if (this.alive && this.statuses.get(id)?.sequence === sequence) {
        this.statuses.set(id, { sequence, result });
        if (result.state === "failed") this.onFailure();
      }
      return result;
    });
    return this.track(task, controller);
  }
  async close(): Promise<void> {
    this.alive = false;
    this.work = undefined;
    this.cancelPending();
    for (const controller of this.tasks.values()) controller.abort();
    await Promise.allSettled(this.tasks.keys());
    this.statuses.clear();
  }
}
