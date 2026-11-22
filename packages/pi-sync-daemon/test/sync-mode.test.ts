import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { DaemonConnection } from "../src/client.js";
import { readConsent } from "../src/consent.js";
import { configFromSettings, syncSettingsConfigFingerprint } from "../src/engine/settings/config.js";
import {
  withConfigPublicationReadyHookForTest,
  withConfigReplacementInstalledHookForTest,
} from "../src/engine/settings/config-file.js";
import { validateSettingsDocument } from "../src/engine/settings/settings-validation.js";
import { syncMode, syncModeFlags } from "../src/engine/settings/sync-mode.js";
import * as continuousSync from "../src/engine/sync/continuous-sync.js";
import { createEngineService } from "../src/engine-service.js";
import { runtimePaths } from "../src/identity.js";
import type { Callback, ClientFacts } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

for (const bits of Array.from({ length: 16 }, (_, index) => index)) {
  test(`project automation combination ${bits.toString(2).padStart(4, "0")}`, () => {
    const expected = bits === 0 ? "Manual" : bits === 12 ? "Automatic" : "Custom";
    const flags = {
      automatic: Boolean(bits & 1),
      automaticTransfer: Boolean(bits & 2),
      agentMode: Boolean(bits & 4),
      continuous: Boolean(bits & 8),
    };
    assert.equal(syncMode(flags), expected);
    const { automatic, ...optional } = flags;
    assert.equal(
      syncMode({ automatic, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value)) }),
      expected,
    );
  });
}

test("only the reviewed Manual and Automatic flags are written", () => {
  assert.deepEqual(syncModeFlags("Manual"), {
    automatic: false,
    automaticTransfer: false,
    agentMode: false,
    continuous: false,
  });
  assert.deepEqual(syncModeFlags("Automatic"), {
    automatic: false,
    automaticTransfer: false,
    agentMode: true,
    continuous: true,
  });
});

type Save = { kind: string; reviewRequired?: boolean; fingerprint?: string };
interface Fixture {
  root: string;
  client: DaemonConnection;
  facts: ClientFacts;
  settingsPath: string;
  before: string;
  settings(): Promise<ReturnType<typeof validateSettingsDocument>>;
  change(mode: "Automatic" | "Manual", signal?: AbortSignal): Promise<Save>;
  policy(): Promise<{ fingerprint: string; automatic: boolean; afterExit: boolean }>;
  approve(fingerprint: string): Promise<unknown>;
  review: (callback: Callback) => boolean | Promise<boolean>;
  publishIdle(idle: boolean): Promise<void>;
  attachOther(): Promise<DaemonConnection>;
}

async function withModeFixture(kind: "mixed" | "ignore" | "legacy", run: (fixture: Fixture) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-mode-")));
  const settingsPath = path.join(root, "pi-sync.json");
  const ignore = { scope: "agent-directory", pathPolicy: "ignore-file", sessions: false, automatic: false };
  const setup = { storage: { connection: "git", branch: "fixture/home", path: "home" } };
  const before = JSON.stringify({
    version: kind === "legacy" ? 3 : 8,
    activeSyncSetup: "home",
    onSwitch: "switch-only",
    storageConnections: { git: { type: "git", remote: "git@github.com:fixture/private.git" } },
    syncSetups: {
      home: {
        ...setup,
        sync: { ...(kind === "ignore" ? ignore : { automatic: false, include: ["settings.json"] }), future: "keep" },
      },
      ...(kind === "mixed"
        ? {
            other: { storage: { connection: "git", branch: "fixture/other", path: "other" }, sync: ignore },
          }
        : {}),
    },
    future: { key: "value" },
  });
  const service = createEngineService(root, true);
  try {
    await fs.writeFile(settingsPath, before, { mode: 0o600 });
    if (kind !== "legacy") await fs.writeFile(path.join(root, ".syncignore"), "/private/\n", { mode: 0o600 });
    await withRpcServer(root, service.execute, async ({ createConnection, server }) => {
      const facts: ClientFacts = {
        id: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        cwd: root,
        mode: "tui",
        hasUI: true,
        idle: false,
      };
      const client = await createConnection(facts, {
        callback: async (callback) => {
          const title = (callback.payload as { title?: string }).title;
          if (title === "Adopt pi-sync-daemon as the synchronization owner?") return true;
          return fixture.review(callback);
        },
      }).attach();
      const fixture: Fixture = {
        root,
        client,
        facts,
        settingsPath,
        before,
        settings: async () => validateSettingsDocument(JSON.parse(await fs.readFile(settingsPath, "utf8"))),
        change: async (mode, signal) => {
          const expected = syncSettingsConfigFingerprint(configFromSettings(await fixture.settings()));
          return (await client.run("settings.sync-mode", { mode, expected }, signal)) as Save;
        },
        policy: async () => (await client.run("daemon.policy", {})) as Awaited<ReturnType<Fixture["policy"]>>,
        approve: (fingerprint) => client.run("daemon.authorize-connected", { fingerprint }),
        review: () => true,
        publishIdle: async (idle) => {
          Object.assign(facts, { ready: true, idle });
          await client.update(facts);
          service.bind(server);
          await service.hooks.factsChanged();
        },
        attachOther: () =>
          createConnection(
            { ...facts, id: randomUUID(), generation: randomUUID() },
            {
              callback: async (callback) => fixture.review(callback),
            },
          ).attach(),
      };
      await client.run("daemon.handover", {});
      await run(fixture);
    });
  } finally {
    await service.hooks.close();
    await fs.rm((await runtimePaths(root)).directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const kind of ["legacy", "mixed", "ignore"] as const) {
  test(`${kind}: reviewed modes save an exact preset and never start automatic work from Settings`, async () =>
    withModeFixture(kind, async (fixture) => {
      let review: Callback | undefined;
      fixture.review = (callback) => {
        review = callback;
        return false;
      };
      assert.equal((await fixture.change("Manual")).kind, "unchanged");
      assert.equal((await fixture.change("Automatic")).kind, "cancelled");
      assert.equal(await fs.readFile(fixture.settingsPath, "utf8"), fixture.before);
      const shown = review?.payload as { title: string; content: string };
      assert.equal(shown.title, "Use Automatic sync?");
      assert.match(shown.content, /selected model's provider.*incur charges/);
      assert.match(shown.content, /No transfer starts here/);
      fixture.review = () => true;
      const result = await fixture.change("Automatic");
      assert.equal(result.kind, "saved");
      assert.equal(result.reviewRequired, kind !== "legacy");
      const settings = await fixture.settings();
      assert.equal(syncMode(settings.syncSetups.home.sync), "Automatic");
      assert.deepEqual(settings.future, { key: "value" });
      assert.equal(settings.syncSetups.home.sync.future, "keep");
      assert.equal((await fixture.policy()).afterExit, false);
      if (kind !== "legacy") {
        assert.equal((await fixture.policy()).automatic, false);
        assert.ok(result.fingerprint);
        assert.equal(result.fingerprint, (await fixture.policy()).fingerprint);
        await assert.rejects(fixture.client.run("sync", { args: [] }), /separate policy review/i);
        fixture.review = () => false;
        assert.equal(await fixture.approve(result.fingerprint), false);
        assert.equal((await fixture.policy()).automatic, false);
        fixture.review = () => true;
        assert.equal(await fixture.approve(result.fingerprint), true);
      }
      assert.equal((await fixture.policy()).automatic, true);
      assert.equal((await fixture.change("Manual")).kind, "saved");
      assert.equal(syncMode((await fixture.settings()).syncSetups.home.sync), "Manual");
      assert.equal((await fixture.policy()).afterExit, false);
    }));
}

for (const changed of ["settings", "rules", "model", "write failure", "abort"] as const) {
  test(`a reviewed mode is not saved after ${changed}`, async () =>
    withModeFixture("ignore", async (fixture) => {
      const controller = new AbortController();
      fixture.review = async () => {
        if (changed === "settings") await fs.writeFile(fixture.settingsPath, `${fixture.before}\n`);
        if (changed === "rules") await fs.writeFile(path.join(fixture.root, ".syncignore"), "/different/\n");
        if (changed === "model")
          await fixture.client.update({
            ...fixture.facts,
            model: {
              id: "other",
              provider: "fixture",
              signature: "a".repeat(64),
              authSource: "stored",
            },
          });
        if (changed === "abort") controller.abort();
        return true;
      };
      const save = () => fixture.change("Automatic", controller.signal);
      if (changed === "write failure") {
        await withConfigPublicationReadyHookForTest(
          async () => {
            throw new Error("injected publication failure");
          },
          async () => {
            await assert.rejects(save(), /injected publication failure/);
          },
        );
        assert.equal(await fs.readFile(fixture.settingsPath, "utf8"), fixture.before);
        assert.equal((await save()).kind, "saved");
      } else {
        await assert.rejects(save(), /changed|abort|cancel/i);
        assert.equal(syncMode((await fixture.settings()).syncSetups.home.sync), "Manual");
      }
    }));
}

test("committed settings survive cancellation and can be reviewed later", async () =>
  withModeFixture("ignore", async (fixture) => {
    const controller = new AbortController();
    await withConfigReplacementInstalledHookForTest(
      async () => controller.abort(),
      async () => {
        await fixture.change("Automatic", controller.signal).catch(() => undefined);
      },
    );
    assert.equal(syncMode((await fixture.settings()).syncSetups.home.sync), "Automatic");
    const policy = await fixture.policy();
    assert.equal(policy.automatic, false);
    assert.equal(await fixture.approve(policy.fingerprint), true);
  }));

test("the same mode cannot reactivate a retained after-exit grant after switching through Manual", async () =>
  withModeFixture("legacy", async (fixture) => {
    assert.equal((await fixture.change("Automatic")).kind, "saved");
    assert.equal(
      await fixture.client.run("daemon.authorize", {
        fingerprint: (await fixture.policy()).fingerprint,
        afterExit: true,
      }),
      true,
    );
    const authorized = (await fixture.policy()).fingerprint;
    assert.equal((await fixture.policy()).afterExit, true);
    assert.equal((await fixture.change("Manual")).kind, "saved");
    assert.equal((await fixture.change("Automatic")).kind, "saved");
    assert.equal((await fixture.policy()).fingerprint, authorized);
    assert.equal((await fixture.policy()).afterExit, false);
    assert.equal(readConsent(fixture.root)?.setups.home?.afterExit, false);
  }));

test("two clients cannot both save from the same old mode", async () =>
  withModeFixture("legacy", async (fixture) => {
    const peer = await fixture.attachOther();
    const expected = syncSettingsConfigFingerprint(configFromSettings(await fixture.settings()));
    const [first, second] = await Promise.allSettled([
      fixture.client.run("settings.sync-mode", { mode: "Automatic", expected }),
      peer.run("settings.sync-mode", { mode: "Automatic", expected }),
    ]);
    const results = [first, second];
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.match(String(results.find((result) => result.status === "rejected")?.reason), /changed/);
    assert.equal(syncMode((await fixture.settings()).syncSetups.home.sync), "Automatic");
  }));

test("the preset starts the existing monitor only after approval and idle, and Manual stops it", async () => {
  const continuous = { start: vi.fn(), stop: vi.fn(async () => {}) };
  const create = vi.spyOn(continuousSync, "createContinuousSync").mockReturnValue(continuous);
  try {
    await withModeFixture("ignore", async (fixture) => {
      await fixture.publishIdle(false);
      const result = await fixture.change("Automatic");
      await fixture.publishIdle(true);
      await fixture.policy();
      assert.equal(continuous.start.mock.calls.length, 0);
      await fixture.publishIdle(false);
      assert.ok(result.fingerprint);
      assert.equal(await fixture.approve(result.fingerprint), true);
      assert.equal(continuous.start.mock.calls.length, 0);
      await fixture.publishIdle(true);
      await vi.waitFor(() => assert.equal(continuous.start.mock.calls.length, 1), { interval: 5 });
      await fixture.publishIdle(false);
      assert.equal((await fixture.change("Manual")).kind, "saved");
      assert.ok(continuous.stop.mock.calls.length > 0);
      await fixture.publishIdle(true);
      assert.equal(continuous.start.mock.calls.length, 1);
    });
  } finally {
    create.mockRestore();
  }
});

function approvalMarker(root: string) {
  const key = createHash("sha256").update("home").digest("hex");
  return path.join(root, "pi-sync", `daemon-connected-${key}.pending`);
}

test("pending publication evidence blocks an installed connected approval until a fresh review", async () =>
  withModeFixture("ignore", async (fixture) => {
    const result = await fixture.change("Automatic");
    assert.ok(result.fingerprint);
    assert.equal(await fixture.approve(result.fingerprint), true);
    const marker = approvalMarker(fixture.root);
    await fs.writeFile(marker, "", { mode: 0o600 });
    assert.equal((await fixture.policy()).automatic, false);
    await assert.rejects(fixture.client.run("sync", { args: [] }), /separate policy review/i);
    fixture.review = () => false;
    assert.equal(await fixture.approve(result.fingerprint), false);
    assert.equal((await fixture.policy()).automatic, false);
    fixture.review = () => true;
    assert.equal(await fixture.approve(result.fingerprint), true);
    assert.equal((await fixture.policy()).automatic, true);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  }));

for (const explicitAfterExit of [false, true]) {
  test(`recovering a pending approval ${explicitAfterExit ? "with" : "without"} explicit after-exit consent`, async () =>
    withModeFixture("ignore", async (fixture) => {
      const saved = await fixture.change("Automatic");
      assert.ok(saved.fingerprint);
      const authorize = () =>
        fixture.client.run("daemon.authorize", { fingerprint: saved.fingerprint, afterExit: true });
      assert.equal(await authorize(), true);
      assert.equal((await fixture.policy()).afterExit, true);
      const marker = approvalMarker(fixture.root);
      await fs.writeFile(marker, "", { mode: 0o600 });
      assert.equal((await fixture.policy()).afterExit, false);
      assert.equal(await (explicitAfterExit ? authorize() : fixture.approve(saved.fingerprint)), true);
      assert.equal((await fixture.policy()).afterExit, explicitAfterExit);
      assert.equal(readConsent(fixture.root)?.setups.home?.afterExit, explicitAfterExit);
      await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    }));
}
