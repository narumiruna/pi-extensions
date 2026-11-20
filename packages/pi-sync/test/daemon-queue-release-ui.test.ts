import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClientFacts, ConnectionOptions } from "@narumitw/pi-sync-daemon";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createQueueReleaseUI, type QueueReleaseEvent } from "../src/daemon/queue-release-ui.js";

function recovering(id = "answer-1", job = "job-1", foreground = false): QueueReleaseEvent {
  return { id, job, foreground, state: "retrying" };
}

async function withRecoveryUI(
  body: (fixture: {
    bind: typeof import("../src/daemon/pi-client.js").bindPiDaemonClient;
    connections: FakeConnection[];
    ensure: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  protectionOnly = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-sync-release-ui-"));
  const connections: FakeConnection[] = [];
  const owner = { paths: { root }, identity: {}, needsUpgrade: protectionOnly };
  const ensure = vi.fn(async () => owner);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.doMock("@narumitw/pi-sync-daemon", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@narumitw/pi-sync-daemon")>()),
    DaemonConnection: class extends FakeConnection {
      constructor(paths: { root: string }, identity: object, facts: ClientFacts, options: ConnectionOptions) {
        super(paths, identity, facts, options);
        connections.push(this);
      }
    },
    ensureDaemon: ensure,
    findDaemon: async () => owner,
  }));
  try {
    const { bindPiDaemonClient: bind } = await import("../src/daemon/pi-client.js");
    await body({ bind, connections, ensure });
  } finally {
    vi.doUnmock("@narumitw/pi-sync-daemon");
    vi.resetModules();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}

class FakeConnection {
  contactState = "active" as const;
  contactResumeState = "idle" as const;
  hasPendingWork = false;
  run = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  constructor(
    readonly paths: { root: string },
    readonly identity: object,
    readonly facts: ClientFacts,
    readonly options: ConnectionOptions,
  ) {}
  async attach() {}
  async update() {}
  async pause() {}
  async dispose() {}
  observe(event: QueueReleaseEvent) {
    this.options.queueRelease?.(event);
  }
  status(value: string, activity: "idle" | "working" | "review" | "blocked") {
    this.options.event?.({
      id: 1,
      kind: "status",
      payload: { value, presentation: { activity, ...(activity === "blocked" ? { reason: "repair" } : {}) } },
    });
  }
}

test.each(["tui", "rpc"] as const)("%s debounces only recovery and restores the underlying sync status", (mode) =>
  withRecoveryUI(async ({ bind, connections }) => {
    const mock = createMockContext({ mode });
    const client = bind(mock.ctx, new AbortController().signal);
    try {
      await client.attachExisting();
      const [wire] = connections;
      assert.ok(wire);
      wire.status("sync working", "working");
      const first = recovering();
      wire.observe(first);
      wire.options.error?.(new Error("socket closed"));
      vi.advanceTimersByTime(1_999);
      assert.equal(mock.statuses.get("sync"), "sync working");
      wire.observe({ ...first, state: "finished" });
      vi.advanceTimersByTime(2_000);
      assert.equal(mock.statuses.get("sync"), "sync working");
      assert.deepEqual(mock.notifications, []);

      const second = recovering("answer-2");
      const overlapping = recovering("answer-3");
      wire.observe(second);
      vi.advanceTimersByTime(1_999);
      wire.observe(overlapping);
      assert.equal(mock.statuses.get("sync"), "sync working");
      vi.advanceTimersByTime(1);
      assert.equal(mock.statuses.get("sync"), "sync recovering");
      assert.deepEqual([...mock.statuses.keys()], ["sync"]);
      wire.options.contact?.("active");
      wire.options.error?.(new Error("socket closed"));
      assert.equal(mock.statuses.get("sync"), "sync recovering");
      wire.observe({ ...second, state: "finished" });
      assert.equal(mock.statuses.get("sync"), "sync recovering");
      wire.status("sync review needed", "review");
      assert.equal(mock.statuses.get("sync"), "sync review needed");
      wire.status("sync blocked by a settings lock", "blocked");
      assert.equal(mock.statuses.get("sync"), "sync blocked by a settings lock");
      wire.status("sync idle", "idle");
      assert.equal(mock.statuses.get("sync"), "sync recovering");
      wire.observe({ ...overlapping, state: "finished" });
      assert.equal(mock.statuses.get("sync"), "sync idle");
      assert.deepEqual(mock.notifications, []);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await client.dispose();
    }
  }),
);

test("only one actionable warning per background job; foreground failures still reach the caller", () =>
  withRecoveryUI(async ({ bind, connections }) => {
    const mock = createMockContext({ mode: "rpc" });
    const client = bind(mock.ctx, new AbortController().signal);
    try {
      await client.attachExisting();
      const [wire] = connections;
      assert.ok(wire);
      const failed = { ...recovering(), state: "unconfirmed" as const };
      wire.observe(failed);
      wire.observe(failed);
      wire.observe({ ...failed, id: "another-answer" });
      assert.equal(mock.notifications.length, 1);
      assert.equal(mock.notifications[0]?.level, "warning");
      assert.match(mock.notifications[0]?.message ?? "", /confirm.*\/sync daemon status/u);
      await client.setBusy("command", true, false);
      const deferred = { ...failed, id: "busy-answer", job: "busy-job" };
      const other = { ...failed, id: "other-busy-answer", job: "other-busy-job" };
      wire.observe(deferred);
      wire.observe(deferred);
      wire.observe(other);
      assert.equal(mock.notifications.length, 1);
      const publishError = new Error("could not publish idle facts");
      vi.spyOn(wire, "update").mockRejectedValueOnce(publishError);
      await assert.rejects(client.setBusy("command", false), (error) => error === publishError);
      assert.equal(mock.notifications.length, 2);
      assert.deepEqual(mock.notifications[1], mock.notifications[0]);
      wire.observe(deferred);
      wire.observe(other);
      assert.equal(mock.notifications.length, 2);
      await client.setBusy("command", true, false);

      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<never>();
      wire.run.mockImplementationOnce(() => {
        started.resolve();
        return result.promise;
      });
      const run = client.run("pull", {});
      await started.promise;
      const foreground = recovering("foreground-answer", "foreground-job", true);
      wire.observe(foreground);
      wire.observe({ ...foreground, state: "unconfirmed", foreground: false });
      const failure = new Error("settings.json lock release failed");
      result.reject(failure);
      await assert.rejects(run, (error) => error === failure);
      wire.options.event?.({ id: 2, kind: "notify", payload: { message: failure.message, level: "error" } });
      await client.setBusy("command", false, false);
      assert.deepEqual(mock.notifications.slice(2), [{ message: failure.message, level: "error" }]);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await client.dispose();
    }
  }));

test("teardown discards deferred background warnings", () => {
  const warn = vi.fn();
  const releaseUI = createQueueReleaseUI(() => undefined, warn);
  const failed = { ...recovering(), state: "unconfirmed" as const };
  releaseUI.observe(failed, true, false);
  releaseUI.clear(false);
  releaseUI.flushWarnings();
  assert.equal(warn.mock.calls.length, 0);

  releaseUI.observe(failed, false, false);
  assert.equal(warn.mock.calls.length, 1);
});

test("cancelling the foreground wait clears recovery UI and ignores its late observations", () =>
  withRecoveryUI(async ({ bind, connections }) => {
    const mock = createMockContext({ mode: "tui" });
    const client = bind(mock.ctx, new AbortController().signal);
    try {
      await client.attachExisting();
      const [wire] = connections;
      assert.ok(wire);
      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<void>();
      wire.run.mockImplementationOnce(() => {
        started.resolve();
        return result.promise;
      });
      const abort = new AbortController();
      const run = client.run("push", {}, abort.signal);
      await started.promise;
      const foreground = recovering("first", "foreground-job", true);
      wire.observe(foreground);
      vi.advanceTimersByTime(2_000);
      assert.equal(mock.statuses.get("sync"), "sync recovering");
      abort.abort();
      assert.equal(mock.statuses.get("sync"), undefined);
      wire.observe({ ...foreground, id: "second" });
      wire.observe({ ...foreground, state: "unconfirmed", foreground: false });
      vi.advanceTimersByTime(2_000);
      assert.equal(mock.statuses.get("sync"), undefined);
      assert.deepEqual(mock.notifications, []);
      assert.equal(vi.getTimerCount(), 0);
      result.resolve();
      await run;
    } finally {
      await client.dispose();
    }
  }));

test.each(["pause", "dispose", "SDK retired"] as const)("%s stops or fences the recovery timer", (boundary) =>
  withRecoveryUI(async ({ bind, connections }) => {
    let retired = false;
    const mock = createMockContext({
      mode: "rpc",
      isIdle: () => {
        if (retired) throw new Error("retired context");
        return true;
      },
    });
    const client = bind(mock.ctx, new AbortController().signal);
    try {
      await client.attachExisting();
      const [wire] = connections;
      assert.ok(wire);
      const first = recovering();
      wire.observe(first);
      if (boundary === "pause") await client.pauseForSessionChange();
      else if (boundary === "dispose") await client.dispose();
      else retired = true;
      vi.advanceTimersByTime(2_000);
      wire.observe({ ...first, state: "unconfirmed" });
      assert.deepEqual([...mock.statuses], []);
      assert.deepEqual(mock.notifications, []);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await client.dispose();
    }
  }),
);

test.each(["print", "json", "protection-only"] as const)("%s remains passive and presents no recovery UI", (mode) =>
  withRecoveryUI(async ({ bind, connections, ensure }) => {
    const mock = createMockContext({ mode: mode === "protection-only" ? "rpc" : mode });
    const client = bind(mock.ctx, new AbortController().signal);
    try {
      await client.attachExisting();
      const [wire] = connections;
      assert.ok(wire);
      assert.equal(wire.facts.hasUI, false);
      const first = recovering();
      wire.observe(first);
      vi.advanceTimersByTime(2_000);
      wire.observe({ ...first, state: "unconfirmed" });
      assert.deepEqual([...mock.statuses], []);
      assert.deepEqual(mock.notifications, []);
      assert.deepEqual(ensure.mock.calls, []);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await client.dispose();
    }
  }, mode === "protection-only"),
);

test("a replaced Pi session and shutdown retire the visible status and ignore the old connection", () =>
  withRecoveryUI(async ({ connections }) => {
    vi.doMock("../src/sync/automatic-sync.js", () => ({
      startSession: async (ctx: Parameters<typeof import("../src/daemon/pi-client.js").piDaemonClient>[0]) => {
        const { piDaemonClient } = await import("../src/daemon/pi-client.js");
        await piDaemonClient(ctx).attachExisting();
        return { debug: false };
      },
      autoPushSessions: async () => {},
    }));
    try {
      const { default: extension } = await import("../src/sync-extension.js");
      const mock = createMockPi();
      const first = createMockContext({ mode: "rpc" });
      const second = createMockContext({
        mode: "rpc",
        ui: (first.ctx as import("@earendil-works/pi-coding-agent").ExtensionContext).ui,
      });
      extension(mock.pi);
      const start = mock.events.get("session_start")?.[0];
      const shutdown = mock.events.get("session_shutdown")?.[0];
      assert.ok(start && shutdown);
      await start({ reason: "startup" }, first.ctx);
      const [old] = connections;
      assert.ok(old);
      const previous = recovering();
      old.observe(previous);
      vi.advanceTimersByTime(2_000);
      assert.equal(first.statuses.get("sync"), "sync recovering");
      await start({ reason: "resume" }, second.ctx);
      assert.equal(first.statuses.get("sync"), undefined);
      const [, current] = connections;
      assert.ok(current);
      current.status("sync working", "working");
      old.observe({ ...previous, state: "unconfirmed" });
      old.observe(recovering("old-answer", "old-job"));
      vi.advanceTimersByTime(2_000);
      assert.equal(first.statuses.get("sync"), "sync working");
      assert.deepEqual(first.notifications, []);
      current.status("sync waiting", "idle");
      current.observe(recovering("new-answer", "new-job"));
      vi.advanceTimersByTime(2_000);
      assert.equal(first.statuses.get("sync"), "sync recovering");
      await shutdown({ reason: "reload" }, second.ctx);
      assert.notEqual(first.statuses.get("sync"), "sync recovering");
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      vi.doUnmock("../src/sync/automatic-sync.js");
    }
  }));
