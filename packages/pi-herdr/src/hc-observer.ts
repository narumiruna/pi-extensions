import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditorStatusPublisher, type EditorStatusPublisher } from "@narumitw/pi-tui-kit/editor-status-publisher";
import { type HcSubscription, requestHc, subscribeHc } from "./hc-rpc.mjs";
import { createHcWidgetSnapshot, parseHcTerminals } from "./hc-widget.js";
import type { HerdrWidgetObserver } from "./herdr-observer.js";
import {
  createHerdrWidget,
  HERDR_WIDGET_KEY,
  type HerdrWidgetSnapshot,
  herdrWidgetFingerprint,
  herdrWidgetSummary,
} from "./herdr-widget.js";

export interface HcEnvironment {
  terminalId: string;
  socketEndpoint: string;
}

export interface HcObserverOptions {
  environment: HcEnvironment;
  request?: typeof requestHc;
  subscribe?: typeof subscribeHc;
  retryDelayMs?: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid hc event sequence");
  return value as number;
}

function eventSnapshot(value: unknown) {
  if (!record(value)) throw new Error("Invalid hc subscription snapshot");
  return { seq: sequence(value.seq), terminals: parseHcTerminals(value.terminals) };
}

function retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("hc observer cancelled"));
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("hc observer cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Observe native facts only. Pi owns OSC status and hc owns terminal lifetime/ancestry. */
export function createHcWidgetObserver(options: HcObserverOptions): HerdrWidgetObserver {
  const request = options.request ?? requestHc;
  const subscribe = options.subscribe ?? subscribeHc;
  let generation = 0;
  let owner: ExtensionContext["sessionManager"] | undefined;
  let controller: AbortController | undefined;
  let publisher: EditorStatusPublisher<HerdrWidgetSnapshot> | undefined;
  let fingerprint: string | undefined;
  const tasks = new Set<Promise<void>>();
  const cleanupErrors = new Set<unknown>();
  const owns = (ctx: ExtensionContext, expected = generation) =>
    expected === generation && owner !== undefined && ctx.sessionManager === owner;

  function publish(ctx: ExtensionContext, expected: number, snapshot: HerdrWidgetSnapshot | undefined) {
    if (!owns(ctx, expected)) return;
    const next = herdrWidgetFingerprint(snapshot);
    if (next === fingerprint) return;
    publisher?.publish(snapshot);
    fingerprint = next;
  }

  async function attempt(ctx: ExtensionContext, expected: number, signal: AbortSignal, healthy: () => void) {
    const attemptController = new AbortController();
    const abort = () => attemptController.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let subscription: HcSubscription | undefined;
    let active = true;
    let dirty = true;
    let seq = -1;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const notify = () => {
      const waiting = wake;
      wake = undefined;
      waiting?.();
    };
    const fail = (error: unknown) => {
      if (!active || attemptController.signal.aborted) return;
      failure = error;
      attemptController.abort();
      notify();
    };
    attemptController.signal.addEventListener("abort", notify);
    const current = () => active && !attemptController.signal.aborted && owns(ctx, expected);
    try {
      subscription = await subscribe(options.environment.socketEndpoint, {
        signal: attemptController.signal,
        onEvent(frame) {
          if (!current()) return;
          try {
            if (!record(frame) || !record(frame.params)) throw new Error("Invalid hc event");
            const next = sequence(frame.params.seq);
            if (frame.method === "heartbeat") return;
            if (frame.method !== "event" && frame.method !== "missed") throw new Error("Unknown hc notification");
            if (next <= seq) return;
            seq = next;
            if (frame.method === "missed") {
              eventSnapshot(frame.params);
              publish(ctx, expected, undefined);
            } else {
              if (frame.params.type === "doc") return;
              if (typeof frame.params.type !== "string" || typeof frame.params.terminal !== "string")
                throw new Error("Invalid hc fact event");
            }
            // Native events can contain partial facts. Re-read, never infer state from terminal text.
            dirty = true;
            notify();
          } catch (error) {
            fail(error);
          }
        },
      });
      // Attach immediately, including when a late subscription resolves after cancellation.
      void subscription.closed.then((error) => fail(error ?? new Error("hc subscription closed")));
      if (!current()) {
        if (failure !== undefined && owns(ctx, expected) && !signal.aborted) throw failure;
        return;
      }
      const initial = eventSnapshot(subscription.snapshot);
      seq = Math.max(seq, initial.seq);
      let discarded = 0;
      while (current()) {
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (!current() || dirty) notify();
          });
          if (!current()) break;
        }
        dirty = false;
        const result = await request(
          options.environment.socketEndpoint,
          "terminal.list",
          { all: true },
          {
            signal: attemptController.signal,
          },
        );
        if (!current()) break;
        if (!record(result)) throw new Error("Invalid hc terminal list");
        const terminals = parseHcTerminals(result.terminals);
        const own = terminals.filter((terminal) => terminal.address === options.environment.terminalId);
        if (own.length !== 1 || own[0]?.state !== "live") throw new Error("Current hc terminal is unavailable");
        if (dirty && discarded < 2) {
          discarded += 1;
          continue;
        }
        discarded = 0;
        publish(ctx, expected, createHcWidgetSnapshot(terminals, options.environment.terminalId));
        // A validated no-peer snapshot is healthy too; a subscription acknowledgement is not.
        healthy();
      }
      if (failure !== undefined && owns(ctx, expected) && !signal.aborted) throw failure;
    } finally {
      active = false;
      attemptController.abort();
      notify();
      signal.removeEventListener("abort", abort);
      attemptController.signal.removeEventListener("abort", notify);
      if (subscription) {
        try {
          await subscription.close();
        } catch (error) {
          cleanupErrors.add(error);
        }
      }
    }
  }

  async function run(ctx: ExtensionContext, expected: number, signal: AbortSignal) {
    let failures = 0;
    while (owns(ctx, expected) && !signal.aborted) {
      try {
        await attempt(ctx, expected, signal, () => {
          failures = 0;
        });
        return;
      } catch {
        if (!owns(ctx, expected) || signal.aborted) return;
        publish(ctx, expected, undefined);
        failures += 1;
        if (failures >= 2) return;
        try {
          await retryDelay(options.retryDelayMs ?? 200, signal);
        } catch {
          return;
        }
      }
    }
  }

  return {
    start(ctx) {
      controller?.abort();
      try {
        publisher?.dispose();
      } finally {
        generation += 1;
        publisher = undefined;
        fingerprint = undefined;
        owner = undefined;
        controller = undefined;
      }
      if (ctx.mode !== "tui") return;
      owner = ctx.sessionManager;
      const expected = generation;
      controller = new AbortController();
      publisher = createEditorStatusPublisher({
        key: HERDR_WIDGET_KEY,
        name: "hc",
        context: ctx,
        isCurrent: () => generation === expected,
        summary: herdrWidgetSummary,
        render: (snapshot, theme, width) => createHerdrWidget(snapshot, theme, false).render(width),
      });
      const task = run(ctx, expected, controller.signal);
      tasks.add(task);
      void task.then(
        () => tasks.delete(task),
        (error) => {
          cleanupErrors.add(error);
          tasks.delete(task);
        },
      );
    },
    restore(ctx) {
      return owns(ctx) ? (publisher?.setCollapsed(false) ?? false) : false;
    },
    async shutdown(ctx) {
      if (owner !== undefined && !owns(ctx)) return;
      controller?.abort();
      const errors: unknown[] = [];
      try {
        publisher?.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        generation += 1;
        publisher = undefined;
        fingerprint = undefined;
      }
      const expected = generation;
      await Promise.allSettled([...tasks]);
      errors.push(...cleanupErrors);
      cleanupErrors.clear();
      if (expected === generation) {
        owner = undefined;
        controller = undefined;
      }
      if (errors.length) throw new AggregateError(errors, "hc widget cleanup failed");
    },
  };
}
