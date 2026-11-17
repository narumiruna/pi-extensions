import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectSync } from "@narumitw/pi-sync-daemon/engine/sync/sync-inspection";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { readMergeAncestors } from "../src/state/merge-baseline-store.js";
import {
  readStateForConfig,
  statePathForConfig,
  syncStateFingerprint,
  writeStateForConfig,
} from "../src/state/sync-state-store.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { mergeJournalIdentity, mergeJournalPath, writeMergeJournal } from "../src/sync/merge-journal.js";
import { createStartupTimings } from "../src/sync/startup-timings.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { withEngineFixtureHost } from "./engine-host.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";
import { contextUi, deferred } from "./startup-check-helpers.js";

async function fixture(root: string) {
  const f = await createMergeFixture(root);
  await updateLocalConfig((settings) => ({
    ...settings,
    syncSetups: {
      ...settings.syncSetups,
      home: { ...settings.syncSetups.home, sync: { ...settings.syncSetups.home.sync, automaticTransfer: true } },
    },
  }));
  // A directional/legacy baseline must first take the full path to become a
  // complete merged baseline, including its verified ancestor cache.
  await syncBoth(f.ctx, mergeOptions, () => f.backend);
  return { ...f, config: await loadConfig() };
}

function diagnostics(timings: ReturnType<typeof createStartupTimings>) {
  const context = createMockContext({ mode: "rpc" });
  timings.publish(context.ctx, true, new AbortController().signal, "background startup");
  return context.notifications[0]?.message ?? "";
}

function observed(f: Awaited<ReturnType<typeof fixture>>) {
  const readHead = f.backend.readHead.bind(f.backend);
  const reads = vi.spyOn(f.backend, "readHead");
  const downloads = vi.spyOn(f.backend, "readSnapshot");
  const publishes = vi.spyOn(f.backend, "publishSnapshot");
  return {
    readHead,
    reads,
    downloads,
    publishes,
    restore() {
      reads.mockRestore();
      downloads.mockRestore();
      publishes.mockRestore();
    },
  };
}

test("unchanged automatic sync reads one fresh head, downloads nothing, and writes no state or cache", async () => {
  await withTempHome(async (root) => {
    const f = await fixture(root);
    const bytes = await fs.readFile(statePathForConfig(f.config));
    const before = await fs.stat(statePathForConfig(f.config));
    const calls = observed(f);
    const rename = vi.spyOn(fs, "rename");
    const timings = createStartupTimings();
    try {
      assert.equal(
        await syncBoth(f.ctx, { ...mergeOptions, auto: true, startupTimings: timings }, () => f.backend),
        "applied",
      );
      assert.equal(calls.reads.mock.calls.length, 1);
      assert.equal(calls.downloads.mock.calls.length, 0);
      assert.equal(calls.publishes.mock.calls.length, 0);
      assert.equal(rename.mock.calls.length, 0);
      assert.deepEqual(await fs.readFile(statePathForConfig(f.config)), bytes);
      assert.equal((await fs.stat(statePathForConfig(f.config))).mtimeMs, before.mtimeMs);
      assert.match(diagnostics(timings), /transfer result: unchanged \(fast path\)/u);
    } finally {
      calls.restore();
      rename.mockRestore();
    }
  });
});

test("startup passes one collector through inspection and unchanged automatic transfer", async () => {
  await withTempHome(async (root) => {
    const f = await fixture(root);
    await updateLocalConfig((settings) => ({ ...settings, debug: true }));
    await adoptFixtureRoot(root);
    const { default: sync } = await import("../src/sync-extension.js");
    const mock = createMockPi();
    const context = createMockContext({ mode: "rpc" });
    const done = deferred();
    const ui = contextUi(context.ctx);
    const notify = ui.notify.bind(ui);
    ui.notify = (message, level) => {
      notify(message, level);
      if (message.startsWith("pi-sync debug: background")) done.resolve();
    };
    sync(mock.pi, {
      loadSyncInspection: async () => ({
        inspectSync: (config, options, signal, _factory, timings) =>
          inspectSync(config, options, signal, () => f.backend, timings),
      }),
      loadSyncOperations: async () =>
        ({
          syncBoth: (ctx: ExtensionContext, options: Parameters<typeof syncBoth>[1]) =>
            withEngineFixtureHost(() =>
              withAgentSyncLock(ctx, options, (current) => syncBoth(ctx, current, () => f.backend)),
            ),
        }) as never,
    });
    const calls = observed(f);
    try {
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await done.promise;
      const report =
        context.notifications.find((entry) => entry.message.startsWith("pi-sync debug: background"))?.message ?? "";
      assert.match(report, /automatic transfer:.*transfer result: unchanged \(fast path\)/su);
      assert.ok(report.includes("transfer remote head:"), report);
      assert.equal(calls.reads.mock.calls.length, 2, "inspection and transfer each read a fresh head");
      assert.equal(calls.downloads.mock.calls.length, 0);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      calls.restore();
    }
  });
});

test("failed publication retains its journal and reports the interrupted stage without private data", async () => {
  await withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "local instructions\n");
    f.backend.failNextPublicationAfterCommit = true;
    const timings = createStartupTimings();
    await assert.rejects(syncBoth(f.ctx, { ...mergeOptions, auto: true, startupTimings: timings }, () => f.backend));
    await fs.access(mergeJournalPath(f.config));
    const report = diagnostics(timings);
    assert.match(report, /transfer remote publication: [^\n]+\(interrupted\)/u);
    assert.doesNotMatch(report, /private|instructions|memory:|access-key|secret-key/u);
  });
});

for (const mode of [
  "manual",
  "local-edit",
  "remote-edit",
  "missing-revision",
  "legacy-state",
  "missing-selection",
  "missing-ancestors",
  "invalid-ancestors",
  "incomplete-ancestors",
  "enable-content-merge",
  "partial-sync",
] as const) {
  test(`automatic fast path falls back for ${mode}`, async () => {
    await withTempHome(async (root) => {
      const f = await fixture(root);
      const state = await readStateForConfig(f.config);
      const ancestor = path.join(`${statePathForConfig(f.config)}.ancestors`, `${syncStateFingerprint(state)}.json`);
      if (mode === "local-edit") await fs.writeFile(path.join(root, "AGENTS.md"), "local instructions\n");
      if (mode === "remote-edit") await f.remoteEdit("AGENTS.md", "remote instructions\n");
      if (mode === "missing-revision") {
        delete state.lastRemoteRevision;
        await writeStateForConfig(f.config, state);
      }
      if (mode === "legacy-state") {
        state.version = 2;
        await writeStateForConfig(f.config, state);
      }
      if (mode === "missing-ancestors") await fs.rm(ancestor);
      if (mode === "invalid-ancestors") await fs.writeFile(ancestor, "{broken");
      if (mode === "incomplete-ancestors") {
        const record = JSON.parse(await fs.readFile(ancestor, "utf8"));
        record.files = [];
        await fs.writeFile(ancestor, JSON.stringify(record));
      }
      if (mode === "enable-content-merge" || mode === "partial-sync") {
        await updateLocalConfig((settings) => {
          settings.version = 5;
          settings.syncSetups.home.sync[mode === "partial-sync" ? "partialSync" : "mergeContent"] = true;
          return settings;
        });
      }
      const calls = observed(f);
      if (mode === "missing-selection") {
        calls.reads.mockImplementation(async (signal) => {
          const head = await calls.readHead(signal);
          return head ? { ...head, selection: undefined } : undefined;
        });
      }
      const timings = createStartupTimings();
      try {
        await syncBoth(f.ctx, { ...mergeOptions, auto: mode !== "manual", startupTimings: timings }, () => f.backend);
        assert.ok(calls.downloads.mock.calls.length > 0, mode);
        const report = diagnostics(timings);
        assert.doesNotMatch(report, /transfer result: unchanged/u);
        if (mode === "manual") {
          assert.equal(calls.reads.mock.calls.length, 3);
          assert.equal(calls.downloads.mock.calls.length, 1);
        }
        if (mode === "local-edit" || mode === "remote-edit") {
          for (const stage of [
            "transfer snapshot download",
            "transfer backup",
            "transfer local apply",
            "transfer baseline write",
          ])
            assert.ok(report.includes(`${stage}:`), report);
          assert.match(report, /transfer remote head: .*\([2-9] calls\)/u);
          if (mode === "local-edit") assert.ok(report.includes("transfer remote publication:"), report);
        }
        if (mode === "enable-content-merge") {
          const current = await loadConfig();
          assert.ok(
            (await readMergeAncestors(current, await readStateForConfig(current)))?.some(
              (file) => file.path === "AGENTS.md",
            ),
          );
        }
      } finally {
        calls.restore();
      }
    });
  });
}

test("an unchanged baseline does not bypass a valid pending journal", async () => {
  await withTempHome(async (root) => {
    const f = await fixture(root);
    const state = await readStateForConfig(f.config);
    await writeMergeJournal(f.config, {
      version: 1,
      identity: mergeJournalIdentity(f.config, f.backend.identity),
      before: f.base,
      after: f.base,
      accepted: f.base,
      upload: f.base,
      expectedHead: f.baseHead,
      committedHead: f.baseHead,
      backup: "private-backup",
      stateIdentity: syncStateFingerprint(state),
    });
    const calls = observed(f);
    const timings = createStartupTimings();
    try {
      await syncBoth(f.ctx, { ...mergeOptions, auto: true, startupTimings: timings }, () => f.backend);
      assert.ok(calls.downloads.mock.calls.length > 0);
      await assert.rejects(fs.access(mergeJournalPath(f.config)), { code: "ENOENT" });
      assert.doesNotMatch(diagnostics(timings), /transfer result: unchanged/u);
    } finally {
      calls.restore();
    }
  });
});

for (const boundary of ["malformed-journal", "unresolved", "policy-change"] as const) {
  test(`fast path cannot hide ${boundary}`, async () => {
    await withTempHome(async (root) => {
      const f = await fixture(root);
      const state = await readStateForConfig(f.config);
      if (boundary === "malformed-journal") await fs.writeFile(mergeJournalPath(f.config), "{broken");
      if (boundary === "unresolved") {
        state.unresolved = [{ paths: ["AGENTS.md"], artifact: "retained" }];
        await writeStateForConfig(f.config, state);
      }
      if (boundary === "policy-change")
        await updateLocalConfig((settings) => {
          settings.syncSetups.home.sync.include = ["settings.json"];
          return settings;
        });
      const calls = observed(f);
      const timings = createStartupTimings();
      try {
        await assert.rejects(
          syncBoth(f.ctx, { ...mergeOptions, auto: true, startupTimings: timings }, () => f.backend),
        );
        assert.equal(calls.publishes.mock.calls.length, 0);
        assert.doesNotMatch(diagnostics(timings), /transfer result: unchanged/u);
        if (boundary === "malformed-journal")
          assert.equal(await fs.readFile(mergeJournalPath(f.config), "utf8"), "{broken");
      } finally {
        calls.restore();
      }
    });
  });
}

for (const race of ["local", "state", "settings", "cancel", "owner", "busy"] as const) {
  test(`fast-path verification rechecks ${race} after ancestor reads`, async () => {
    await withTempHome(async (root) => {
      const f = await fixture(root);
      const state = await readStateForConfig(f.config);
      const ancestor = path.join(`${statePathForConfig(f.config)}.ancestors`, `${syncStateFingerprint(state)}.json`);
      const signal = new AbortController();
      const ctx = f.ctx as ExtensionContext;
      let fired = false;
      const read = fs.readFile.bind(fs);
      const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const result = await read(...args);
        if (String(args[0]) === ancestor && !fired) {
          fired = true;
          if (race === "local") await fs.writeFile(path.join(root, "AGENTS.md"), "newer instructions\n");
          if (race === "state") await writeStateForConfig(f.config, { ...state, lastAppliedSnapshot: "newer-state" });
          if (race === "settings")
            await updateLocalConfig((settings) => {
              settings.syncSetups.home.sync.automaticTransfer = false;
              return settings;
            });
          if (race === "cancel") signal.abort(new DOMException("cancelled", "AbortError"));
          if (race === "owner") ctx.sessionManager = (createMockContext().ctx as ExtensionContext).sessionManager;
          if (race === "busy") ctx.isIdle = () => false;
        }
        return result;
      });
      const timings = createStartupTimings();
      try {
        await assert.rejects(
          syncBoth(
            f.ctx,
            { ...mergeOptions, auto: true, signal: signal.signal, startupTimings: timings },
            () => f.backend,
          ),
        );
        assert.equal(fired, true);
        assert.doesNotMatch(diagnostics(timings), /transfer result: unchanged/u);
      } finally {
        spy.mockRestore();
      }
    });
  });
}
