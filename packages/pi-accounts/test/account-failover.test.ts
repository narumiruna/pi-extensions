import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import {
  AccountFailover,
  allowance,
  enabled,
  FAIL_CLOSED_API_KEY,
  failoverFixture,
  keyFor,
  RuntimeAuthCoordinator,
  type UsageCall,
} from "./account-failover-fixture.js";

for (const row of [
  { name: "absent policy", fallback: undefined, service: true, queries: 0 },
  { name: "disabled policy", fallback: { ...enabled(), enabled: false }, service: true, queries: 0 },
  { name: "absent service", fallback: enabled(), service: false, queries: 1 },
  { name: "neither prerequisite", fallback: undefined, service: false, queries: 0 },
]) {
  test(`${row.name} preserves account behavior without automatic mutations or polling`, async () => {
    vi.useFakeTimers();
    const f = await failoverFixture({ active: "primary", ...row });
    await f.start();
    const entries = f.selectionEntries().length;
    const stored = await f.store.readAsync();
    const notices = f.notifications.length;
    await f.turn();
    await vi.advanceTimersByTimeAsync(60_000);
    await f.turn();
    assert.equal(f.requests(), row.queries, "only enabled policy may probe for an optional service");
    assert.equal(f.queries.length, 0);
    assert.equal(f.selectionEntries().length, entries);
    assert.deepEqual(await f.store.readAsync(), stored);
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(f.notifications.length, notices);
    assert.equal(vi.getTimerCount(), 0);
  });
}

for (const provider of ["openrouter", "anthropic"] as const) {
  for (const lowBackup of [false, true]) {
    test(`${provider}: low current allowance accepts the ${lowBackup ? "next" : "first"} adequate backup`, async () => {
      const f = await failoverFixture({ provider, active: "primary", fallback: enabled() });
      await f.start();
      const stored = await f.store.readAsync();
      const model = JSON.stringify(f.ctx.model);
      const cleanups: Array<string | undefined> = [];
      const unregister = registerSessionResourceCleanup((session) => {
        cleanups.push(session);
      });
      try {
        f.offer(({ key }) =>
          allowance(f.ctx, key === keyFor("primary") || (lowBackup && key === keyFor("backup")) ? 5 : 75),
        );
        await f.turn();
        const selected = lowBackup ? "spare" : "backup";
        assert.equal(f.selection(), selected);
        assert.equal(await f.key(), keyFor(selected));
        assert.deepEqual(
          f.queries.map((call) => call.key),
          ["primary", "backup", ...(lowBackup ? ["spare"] : [])].map(keyFor),
        );
        assert.ok(f.queries.every((call) => call.request.refresh && call.model === f.ctx.model?.id));
        assert.ok(
          f.queries.every(
            (call) =>
              call.request.session === f.ctx.sessionManager &&
              call.request.sessionId === f.ctx.sessionManager.getSessionId() &&
              call.request.providerId === provider,
          ),
        );
        assert.deepEqual(cleanups, Array(lowBackup ? 2 : 1).fill(f.ctx.sessionManager.getSessionId()));
        assert.equal(f.aborts(), 0, "awaited activation must not abort the request it is preparing");
        assert.equal(JSON.stringify(f.ctx.model), model);
        assert.deepEqual(await f.store.readAsync(), stored, "startup defaults and all credentials are unchanged");
        assert.deepEqual(f.mock.setModels, []);
        assert.deepEqual(f.mock.sentMessages, []);
        assert.deepEqual(f.mock.sentUserMessages, []);
      } finally {
        unregister();
      }
    });
  }
}

for (const starting of [undefined, "primary"] as const) {
  test(`restores ${starting ?? "Pi built-in login"} after an exhausted candidate list`, async () => {
    const f = await failoverFixture({ active: starting, fallback: enabled() });
    await f.start();
    const originalKey = await f.key();
    f.offer(() => allowance(f.ctx, 0));
    await f.turn();
    assert.equal(f.selection(), starting ?? null);
    assert.equal(await f.key(), originalKey);
    assert.deepEqual(
      f.queries.map((call) => call.key),
      [originalKey, keyFor("backup"), keyFor("spare")],
    );
    assert.equal(f.aborts(), 0);
    const stored = await f.store.readProviderAsync(f.id);
    assert.equal(stored.active, starting);
  });
}

test("Pi built-in starting authentication can select a named backup without changing the startup default", async () => {
  const f = await failoverFixture({ fallback: enabled(["backup"]) });
  await f.start();
  const original = await f.key();
  f.offer(({ key }) => allowance(f.ctx, key === original ? 1 : 50));
  await f.turn();
  assert.equal(f.selection(), "backup");
  assert.equal(await f.key(), keyFor("backup"));
  assert.equal((await f.store.readProviderAsync(f.id)).active, undefined);
});

const unknownResults: Array<{ name: string; result: (f: Awaited<ReturnType<typeof failoverFixture>>) => unknown }> = [
  { name: "unavailable", result: (f) => ({ status: "unavailable", providerId: f.id, reason: "query-failed" }) },
  {
    name: "authentication failure",
    result: (f) => ({ status: "unavailable", providerId: f.id, reason: "auth-unavailable" }),
  },
  { name: "HTTP 429 rejection", result: () => Promise.reject(new Error("HTTP 429 quota endpoint")) },
  {
    name: "old service without allowance evidence",
    result: (f) => {
      const report = allowance(f.ctx, 0);
      return { ...report, report: { ...report.report, allowance: undefined } };
    },
  },
  { name: "partial adequate coverage", result: (f) => allowance(f.ctx, 50, { partial: true }) },
];
for (const row of unknownResults) {
  for (const candidate of [false, true]) {
    test(`${row.name} ${candidate ? "on a candidate stops the scan and restores" : "on the current account never triggers failover"}`, async () => {
      const f = await failoverFixture({ active: "primary", fallback: enabled() });
      await f.start();
      const initialEntries = f.selectionEntries().length;
      f.offer(({ key }) => (candidate && key === keyFor("primary") ? allowance(f.ctx, 0) : row.result(f)));
      await f.turn();
      assert.equal(f.selection(), "primary");
      assert.equal(await f.key(), keyFor("primary"));
      assert.deepEqual(
        f.queries.map((call) => call.key),
        candidate ? [keyFor("primary"), keyFor("backup")] : [keyFor("primary")],
      );
      assert.equal(f.selectionEntries().length - initialEntries, 0, "unaccepted trials must not enter session history");
      assert.equal(f.aborts(), 0);
    });
  }
}

test("candidate authentication failure restores and does not inspect later accounts", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  f.offer(() => allowance(f.ctx, 0));
  const getKey = f.registry.getApiKeyForProvider.bind(f.registry);
  vi.spyOn(f.registry, "getApiKeyForProvider").mockImplementation(async (...args) => {
    const key = await getKey(...args);
    if (key === keyFor("backup")) throw new Error("Synthetic candidate authentication failure");
    return key;
  });
  await f.turn();
  assert.equal(f.selection(), "primary");
  assert.equal(await f.key(), keyFor("primary"));
  assert.deepEqual(
    f.queries.map((call) => call.key),
    [keyFor("primary")],
  );
});

test("an unavailable candidate model is never queried and does not select another model or account", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.store.updateProvider(f.id, (state) => ({
    ...state,
    accounts: {
      ...state.accounts,
      backup: {
        type: "oauth",
        access: keyFor("backup"),
        refresh: "synthetic-refresh",
        expires: Date.now() + 3_600_000,
        availableModelIds: ["not-the-selected-model"],
      },
    },
  }));
  f.adapter.oauth = { ...f.adapter.oauth, toAuth: async (credential) => ({ apiKey: credential.access }) };
  await f.start();
  const model = JSON.stringify(f.ctx.model);
  f.offer(() => allowance(f.ctx, 0));
  await f.turn();
  assert.equal(f.selection(), "primary");
  assert.equal(await f.key(), keyFor("primary"));
  assert.equal(JSON.stringify(f.ctx.model), model);
  assert.deepEqual(f.mock.setModels, []);
  assert.deepEqual(
    f.queries.map((call) => call.key),
    [keyFor("primary")],
  );
});

for (const value of ["primary", "missing", "default", " invalid "]) {
  test(`PI_ACCOUNT=${JSON.stringify(value)} retains precedence and makes no failover queries`, async () => {
    process.env.PI_ACCOUNT = value;
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    const entries = f.selectionEntries().length;
    f.offer(() => allowance(f.ctx, 0));
    await f.turn();
    assert.equal(f.requests(), 0);
    assert.equal(f.selectionEntries().length, entries);
    assert.equal(await f.key(), value === "primary" ? keyFor("primary") : FAIL_CLOSED_API_KEY);
  });
}

test("pacing, low-account exclusions, and refresh hints cannot cause automatic failback or repeated scans", async () => {
  vi.useFakeTimers();
  const f = await failoverFixture({ active: "primary", fallback: enabled(["backup", "primary", "spare"]) });
  await f.start();
  let backupLow = false;
  f.offer(({ key }) => {
    f.mock.eventBus.emit("usage:changed:v1", { session: f.ctx.sessionManager, providerId: f.id });
    return allowance(f.ctx, key === keyFor("primary") || (backupLow && key === keyFor("backup")) ? 0 : 50);
  });
  await f.turn();
  assert.equal(f.selection(), "backup");
  for (let index = 0; index < 3; index++) await f.turn();
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
  await f.turn();
  assert.equal(f.requests(), 2);
  await vi.advanceTimersByTimeAsync(1);
  backupLow = true;
  await f.turn();
  assert.equal(f.selection(), "spare");
  assert.deepEqual(
    f.queries.map((call) => call.key),
    ["primary", "backup", "backup", "spare"].map(keyFor),
  );
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  await f.turn();
  assert.equal(f.selection(), "spare", "recovery of a preferred account must not cause failback");
  assert.deepEqual(
    f.queries.map((call) => call.key),
    ["primary", "backup", "backup", "spare", "spare"].map(keyFor),
  );
  assert.equal(vi.getTimerCount(), 0);
});

test("skips the current and locally missing references and never adds an unlisted credential", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled(["primary", "missing", "backup"]) });
  await f.start();
  f.offer(({ key }) => allowance(f.ctx, key === keyFor("primary") ? 0 : 50));
  await f.turn();
  assert.equal(f.selection(), "backup");
  assert.deepEqual(
    f.queries.map((call) => call.key),
    ["primary", "backup"].map(keyFor),
  );
  assert.ok(!f.queries.some((call) => call.key === keyFor("manual")));
});

test("a successful automatic selection persists across same-manager reload without changing the store default", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  f.offer(({ key }) => allowance(f.ctx, key === keyFor("primary") ? 0 : 50));
  await f.turn();
  const entries = f.selectionEntries().length;
  f.newRun();
  f.setIdle(true);
  await f.emit("session_start");
  await f.emit("before_agent_start");
  await f.turn();
  assert.equal(f.selection(), "backup");
  assert.equal(await f.key(), keyFor("backup"));
  assert.equal(f.selectionEntries().length, entries);
  assert.equal((await f.store.readProviderAsync(f.id)).active, "primary");
  assert.deepEqual(
    f.queries.map((call) => call.key),
    ["primary", "backup", "backup"].map(keyFor),
  );
});

for (const afterActivation of [false, true]) {
  test(`run cancellation ${afterActivation ? "after" : "before"} candidate activation releases its query and restores safely`, async () => {
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    const entered = Promise.withResolvers<UsageCall>();
    const release = Promise.withResolvers<unknown>();
    f.offer((call) => {
      if (afterActivation && call.key === keyFor("primary")) return allowance(f.ctx, 0);
      entered.resolve(call);
      return release.promise;
    });
    const boundary = f.turn();
    const call = await entered.promise;
    try {
      assert.equal(f.selection(), "primary", "a trial is not a saved selection");
      assert.equal(await f.key(), keyFor(afterActivation ? "backup" : "primary"));
      f.cancel();
      await boundary;
      assert.equal(call.request.signal.aborted, true);
      assert.equal(getEventListeners(f.ctx.signal as AbortSignal, "abort").length, 0);
      assert.equal(f.selection(), "primary");
      assert.equal(await f.key(), keyFor("primary"));
      const entries = f.selectionEntries().length;
      release.resolve(allowance(f.ctx, 0));
      await release.promise;
      assert.equal(f.selectionEntries().length, entries, "late evidence must not resume the scan");
    } finally {
      release.resolve(undefined);
      await boundary;
    }
  });
}

for (const method of ["manual", "protocol"] as const) {
  test(`a newer ${method} selection supersedes delayed automatic evidence and cannot be restored over`, async () => {
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    const entered = Promise.withResolvers<UsageCall>();
    const release = Promise.withResolvers<unknown>();
    f.offer((call) => {
      if (call.key === keyFor("primary")) return allowance(f.ctx, 0);
      entered.resolve(call);
      return release.promise;
    });
    const boundary = f.turn();
    const call = await entered.promise;
    try {
      assert.equal(f.selection(), "primary");
      assert.equal(await f.key(), keyFor("backup"));
      if (method === "manual") await f.manual("manual");
      else assert.equal((await f.activate("manual")).status, "active");
      await boundary;
      release.resolve(allowance(f.ctx, 0));
      assert.equal(call.request.signal.aborted, true);
      assert.equal(f.selection(), "manual");
      assert.equal(await f.key(), keyFor("manual"));
      assert.ok(!f.queries.some((query) => query.key === keyFor("spare")));
      f.newRun();
      f.offer(() => allowance(f.ctx, 50));
      await f.emit("before_agent_start");
      await f.turn();
      assert.equal(f.selection(), "manual");
      assert.equal(f.queries.at(-1)?.key, keyFor("manual"), "explicit selection permits fresh evidence");
    } finally {
      release.resolve(undefined);
      await boundary;
    }
  });
}

for (const replacement of ["model", "same-manager session", "shutdown"] as const) {
  test(`${replacement} invalidates a delayed query without stale selection publication`, async () => {
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    const entered = Promise.withResolvers<UsageCall>();
    const release = Promise.withResolvers<unknown>();
    f.offer((call) => {
      entered.resolve(call);
      return release.promise;
    });
    const boundary = f.turn();
    const call = await entered.promise;
    try {
      const entries = f.selectionEntries().length;
      if (replacement === "model") {
        f.setModel("anthropic");
        await f.emit("model_select");
      } else if (replacement === "same-manager session") {
        f.newRun();
        await f.emit("session_start");
        await f.emit("before_agent_start");
      } else await f.shutdown();
      release.resolve(allowance(f.ctx, 0));
      await boundary;
      assert.equal(call.request.signal.aborted, true);
      assert.equal(f.selectionEntries().length, entries);
      assert.equal(f.selection(), "primary");
      assert.equal(getEventListeners(f.ctx.signal as AbortSignal, "abort").length, 0);
      if (replacement !== "shutdown") assert.equal(await f.key(), keyFor("primary"));
    } finally {
      release.resolve(undefined);
      await boundary;
    }
  });
}

test("settings reload cancels candidate evidence, restores, and keeps disabled policy silent", async () => {
  const reload = vi.spyOn(AccountFailover.prototype, "reload");
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const controller = reload.mock.contexts.at(-1) as InstanceType<typeof AccountFailover> | undefined;
  assert.ok(controller);
  const entered = Promise.withResolvers<UsageCall>();
  const release = Promise.withResolvers<unknown>();
  f.offer((call) => {
    if (call.key === keyFor("primary")) return allowance(f.ctx, 0);
    entered.resolve(call);
    return release.promise;
  });
  const boundary = f.turn();
  const call = await entered.promise;
  try {
    await f.store.updateProvider(f.id, (state) => ({ ...state, fallback: { ...enabled(), enabled: false } }));
    await controller.reload();
    await boundary;
    assert.equal(call.request.signal.aborted, true);
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("primary"));
    release.resolve(allowance(f.ctx, 50));
    f.newRun();
    const queries = f.requests();
    await f.turn();
    assert.equal(f.requests(), queries);
  } finally {
    release.resolve(undefined);
    await boundary;
  }
});

for (const mutation of ["rotation", "removal"] as const) {
  test(`credential ${mutation} invalidates delayed current-account evidence`, async () => {
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    const entered = Promise.withResolvers<UsageCall>();
    const release = Promise.withResolvers<unknown>();
    f.offer((call) => {
      entered.resolve(call);
      return release.promise;
    });
    const boundary = f.turn();
    const call = await entered.promise;
    try {
      await f.store.updateProvider(f.id, (state) => {
        const accounts = { ...state.accounts };
        if (mutation === "removal") delete accounts.primary;
        else accounts.primary = { type: "api_key", key: "sk-rotated-fixture" };
        return { ...state, accounts };
      });
      await f.ready();
      release.resolve(allowance(f.ctx, 0));
      await boundary;
      assert.equal(call.request.signal.aborted, true);
      assert.equal(f.selection(), "primary");
      assert.equal(f.queries.length, 1);
      assert.equal(await f.key(), mutation === "rotation" ? "sk-rotated-fixture" : FAIL_CLOSED_API_KEY);
    } finally {
      release.resolve(undefined);
      await boundary;
    }
  });
}

test("a candidate removed during a query stops the attempt instead of searching on an activation error", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  f.offer(async () => {
    await f.store.updateProvider(f.id, (state) => {
      const accounts = { ...state.accounts };
      delete accounts.backup;
      return { ...state, accounts };
    });
    return allowance(f.ctx, 0);
  });
  await f.turn();
  assert.equal(f.selection(), "primary");
  assert.equal(await f.key(), keyFor("primary"));
  assert.deepEqual(
    f.queries.map((call) => call.key),
    [keyFor("primary")],
  );
});

test("a stalled usage refresh releases the request gate after its 15-second deadline", async () => {
  vi.useFakeTimers();
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const entered = Promise.withResolvers<UsageCall>();
  const release = Promise.withResolvers<unknown>();
  f.offer((call) => {
    entered.resolve(call);
    return release.promise;
  });
  const boundary = f.turn();
  const call = await entered.promise;
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    await boundary;
    assert.equal(call.request.signal.aborted, true);
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(f.requests(), 1);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    release.resolve(undefined);
    await boundary;
  }
});

for (const supersession of ["cancellation", "protocol", "shutdown"] as const) {
  test(`${supersession} releases delayed activation and rejects its late cleanup failure`, async () => {
    const f = await failoverFixture({ active: "primary", fallback: enabled() });
    await f.start();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const cleanup = f.adapter.invalidateConnections;
    assert.ok(cleanup);
    let blocked = false;
    f.adapter.invalidateConnections = async (session) => {
      await cleanup(session);
      if ((await f.key()) !== keyFor("backup") || blocked) return;
      blocked = true;
      entered.resolve();
      await release.promise;
      finished.resolve();
      throw new Error("Obsolete candidate cleanup failure");
    };
    f.offer(() => allowance(f.ctx, 0));
    const boundary = f.turn();
    await entered.promise;
    try {
      assert.equal(f.selection(), "primary", "activation must not persist an unaccepted trial");
      assert.equal(await f.key(), keyFor("backup"));
      if (supersession === "cancellation") f.cancel();
      else if (supersession === "protocol") assert.equal((await f.activate("manual")).status, "active");
      else await f.shutdown();
      await boundary;
      const selected = supersession === "protocol" ? "manual" : "primary";
      const key = supersession === "shutdown" ? undefined : keyFor(selected);
      assert.equal(f.selection(), selected);
      assert.equal(await f.key(), key);
      release.resolve();
      await finished.promise;
      // Drain the stale sync continuation, without elapsed-time sleeps.
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(await f.key(), key);
      assert.equal(f.selection(), selected);
      assert.equal(f.queries.length, 1, "no candidate request or quota query may escape before authentication cleanup");
    } finally {
      release.resolve();
      await boundary;
    }
  });
}

test("normal, restoration, and fail-closed waits have a combined 60-second cap", async () => {
  vi.useFakeTimers();
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const candidateEntered = Promise.withResolvers<void>();
  const recoveryEntered = Promise.withResolvers<void>();
  const publicationEntered = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const releasePublication = Promise.withResolvers<void>();
  const cleanup = f.adapter.invalidateConnections;
  assert.ok(cleanup);
  f.adapter.invalidateConnections = async (session) => {
    await cleanup(session);
    if ((await f.key()) === keyFor("backup")) candidateEntered.resolve();
    else recoveryEntered.resolve();
    await releaseCleanup.promise;
  };
  const publish = RuntimeAuthCoordinator.prototype.forceFailClosed;
  vi.spyOn(RuntimeAuthCoordinator.prototype, "forceFailClosed").mockImplementation(async function (
    this: InstanceType<typeof RuntimeAuthCoordinator>,
    ...args
  ) {
    const result = await publish.apply(this, args);
    publicationEntered.resolve();
    await releasePublication.promise;
    return result;
  });
  f.offer(() => allowance(f.ctx, 0));
  const start = Date.now();
  let completed = false;
  const boundary = f.turn().then(() => {
    completed = true;
  });
  await candidateEntered.promise;
  try {
    await vi.advanceTimersByTimeAsync(45_000);
    await recoveryEntered.promise;
    assert.equal(completed, false);
    await vi.advanceTimersByTimeAsync(14_000);
    await publicationEntered.promise;
    assert.equal(f.ctx.signal?.aborted, true);
    assert.equal(completed, false);
    await vi.advanceTimersByTimeAsync(1_000);
    await boundary;
    assert.equal(Date.now() - start, 60_000);
    assert.equal(await f.key(), FAIL_CLOSED_API_KEY);
    assert.equal(f.selection(), "primary");
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    releaseCleanup.resolve();
    releasePublication.resolve();
    await boundary;
  }
});

test("a same-manager new session rejects evidence from the previous session ID", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const entered = Promise.withResolvers<UsageCall>();
  const release = Promise.withResolvers<unknown>();
  f.offer((call) => {
    entered.resolve(call);
    return release.promise;
  });
  const boundary = f.turn();
  const call = await entered.promise;
  try {
    (f.ctx.sessionManager as SessionManager).newSession();
    f.newRun();
    f.setIdle(true);
    await f.start();
    assert.notEqual(f.ctx.sessionManager.getSessionId(), call.request.sessionId);
    release.resolve(allowance(f.ctx, 0));
    await boundary;
    assert.equal(call.request.signal.aborted, true);
    assert.equal(f.selection(), "primary");
    assert.equal(await f.key(), keyFor("primary"));
    assert.equal(f.selectionEntries().length, 1);
  } finally {
    release.resolve(undefined);
    await boundary;
  }
});

test("a confirmed-low original is not revisited before its reset; explicit selection permits fresh evidence", async () => {
  vi.useFakeTimers();
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  const reset = Date.now() + 60 * 60_000;
  f.offer(() => allowance(f.ctx, 0, { reset }));
  await f.turn();
  assert.equal(f.selection(), "primary");
  assert.equal(f.requests(), 3);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await f.turn();
  assert.equal(f.requests(), 3, "pacing expiry alone cannot revisit a confirmed-low original");
  await f.activate("primary");
  f.newRun();
  f.offer(() => allowance(f.ctx, 50));
  await f.turn();
  assert.equal(f.requests(), 4);
  assert.equal(f.selection(), "primary");
});

test("failed restoration blocks the request and agent_settled performs verified safe recovery", async () => {
  const f = await failoverFixture({ active: "primary", fallback: enabled() });
  await f.start();
  let failed = true;
  const cleanup = f.adapter.invalidateConnections;
  assert.ok(cleanup);
  f.adapter.invalidateConnections = async (session) => {
    if (failed && (await f.key()) === keyFor("primary")) throw new Error("Synthetic restoration cleanup failure");
    await cleanup(session);
  };
  f.offer(({ key }) =>
    key === keyFor("primary")
      ? allowance(f.ctx, 0)
      : { status: "unavailable", providerId: f.id, reason: "auth-unavailable" },
  );
  await f.turn();
  assert.equal(f.ctx.signal?.aborted, true);
  assert.equal(await f.key(), FAIL_CLOSED_API_KEY);
  assert.equal(f.selection(), "primary");
  failed = false;
  f.setIdle(false);
  await f.emit("agent_settled");
  assert.equal(await f.key(), FAIL_CLOSED_API_KEY, "a busy callback is not a safe recovery boundary");
  f.setIdle(true);
  await f.emit("agent_settled");
  assert.equal(await f.key(), keyFor("primary"));
  f.newRun();
  await f.emit("before_agent_start");
  await f.turn();
  assert.equal(f.ctx.signal?.aborted, false);
  assert.equal(f.requests(), 2, "recovery must not retry the candidate scan");
});
