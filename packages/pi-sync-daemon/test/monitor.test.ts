import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import * as consent from "../src/consent.js";
import * as config from "../src/engine/settings/config.js";
import type { PiSyncSettingsV3 } from "../src/engine/settings/settings-types.js";
import * as continuousModule from "../src/engine/sync/continuous-sync.js";
import { createMonitor } from "../src/monitor.js";
import type { ClientFacts, Execution } from "../src/protocol.js";
import * as resolver from "../src/resolver-host.js";
import { installServiceHost } from "../src/service-host.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  run: (value: {
    root: string;
    monitor: ReturnType<typeof createMonitor>;
    continuous: ReturnType<typeof mockContinuous>;
    peers: ClientFacts[];
    execution(peer: ClientFacts, signal?: AbortSignal): Execution;
    idle: { value: boolean };
    idleRead: ReturnType<typeof vi.fn<() => boolean>>;
    settings: PiSyncSettingsV3;
    save(): Promise<void>;
  }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-monitor-")));
  const peers = Array.from({ length: 2 }, () => ({
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    mode: "rpc" as const,
    hasUI: true,
    idle: true,
    ready: true,
  }));
  const idle = { value: true };
  const idleRead = vi.fn(() => idle.value);
  const settings: PiSyncSettingsV3 = {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "switch-only",
    storageConnections: {
      dav: {
        type: "webdav",
        url: "https://example.invalid/dav/",
        credentials: { username: "fixture", password: "fixture" },
      },
    },
    syncSetups: {
      home: {
        storage: { connection: "dav", path: "pi-sync/home" },
        sync: { include: ["AGENTS.md"], automatic: false, agentMode: true, continuous: true },
      },
    },
  };
  const save = () => fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 });
  const execution = (peer: ClientFacts, signal = new AbortController().signal): Execution => ({
    root,
    clientId: peer.id,
    signal,
    facts: () => peers.find((current) => current.id === peer.id),
    participants: () => peers,
    liveClients: () => peers,
    withParticipants: (action) => action(peers),
    validate: () => signal.throwIfAborted(),
    request: async () => true,
    emit() {},
    committed() {},
  });
  const host = installServiceHost(root);
  const continuous = mockContinuous();
  vi.spyOn(continuousModule, "createContinuousSync").mockReturnValue(continuous);
  const monitor = createMonitor(root, host);
  try {
    await save();
    await host.run(execution(peers[0] as ClientFacts), () =>
      consent.requireHandover(execution(peers[0] as ClientFacts)),
    );
    const server = {
      isIdle: idleRead,
      participants: () => peers,
      backgroundExecution: (signal: AbortSignal) => ({
        ...execution(peers[0] as ClientFacts, signal),
        clientId: undefined,
      }),
    } as unknown as Parameters<typeof monitor.bind>[0];
    monitor.bind(server);
    await vi.waitFor(() => assert.equal(continuous.start.mock.calls.length, 1), { interval: 5 });
    await monitor.pause();
    await run({ root, monitor, continuous, peers, execution, idle, idleRead, settings, save });
  } finally {
    await monitor.close();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}
function mockContinuous() {
  return {
    start: vi.fn<ReturnType<typeof continuousModule.createContinuousSync>["start"]>(),
    stop: vi.fn(async () => {}),
  };
}

for (const route of ["active", "other", "last-other", "two-clients", "cancelled", "replaced"] as const)
  test(`Continuous consumes one eligible setup-scoped retry: ${route}`, () =>
    fixture(async ({ monitor, continuous, peers, execution }) => {
      const first = peers[0];
      const second = peers[1];
      assert.ok(first && second);
      const controller = new AbortController();
      monitor.explicitSync(route === "other" ? "other" : "home", execution(first, controller.signal));
      if (route === "last-other") monitor.explicitSync("other", execution(first));
      if (route === "two-clients") monitor.explicitSync("other", execution(second));
      if (route === "cancelled") controller.abort();
      if (route === "replaced") peers[0] = { ...first, generation: randomUUID() };
      monitor.schedule();
      await vi.waitFor(() => assert.equal(continuous.start.mock.calls.length, 2), { interval: 5 });
      assert.equal(continuous.start.mock.calls[1]?.[2], ["active", "two-clients"].includes(route) ? "home" : false);
      const manager = continuous.start.mock.calls[1]?.[0].sessionManager;
      if (route === "replaced") assert.notEqual(manager, continuous.start.mock.calls[0]?.[0].sessionManager);
      else assert.equal(manager, continuous.start.mock.calls[0]?.[0].sessionManager);
      await monitor.pause();
      monitor.schedule();
      await vi.waitFor(() => assert.equal(continuous.start.mock.calls.length, 3), { interval: 5 });
      assert.equal(continuous.start.mock.calls[2]?.[2], false, "retry is consumed once");
      assert.equal(
        vi.mocked(continuousModule.createContinuousSync).mock.calls.length,
        1,
        "reuse the accounting-owning engine",
      );
    }));

test("busy eligibility does not consume an explicit retry", () =>
  fixture(async ({ monitor, continuous, peers, execution, idle, idleRead }) => {
    const peer = peers[0];
    assert.ok(peer);
    idle.value = false;
    monitor.explicitSync("home", execution(peer));
    const calls = idleRead.mock.calls.length;
    monitor.schedule();
    await vi.waitFor(() => assert.ok(idleRead.mock.calls.length > calls), { interval: 5 });
    assert.equal(continuous.start.mock.calls.length, 1);
    idle.value = true;
    monitor.schedule();
    await vi.waitFor(() => assert.equal(continuous.start.mock.calls.length, 2), { interval: 5 });
    assert.equal(continuous.start.mock.calls[1]?.[2], "home");
  }));

test("disabled Continuous drops an intent instead of carrying it into a later activation", () =>
  fixture(async ({ monitor, continuous, peers, execution, settings, save }) => {
    const peer = peers[0];
    const setup = settings.syncSetups.home;
    assert.ok(peer && setup);
    monitor.explicitSync("home", execution(peer));
    setup.sync.continuous = false;
    await save();
    const original = config.loadConfigForCheck;
    const read = deferred<void>();
    vi.spyOn(config, "loadConfigForCheck").mockImplementation(async () => {
      const current = await original();
      if (!current.continuous) read.resolve();
      return current;
    });
    monitor.schedule();
    await read.promise;
    setup.sync.continuous = true;
    await save();
    monitor.schedule();
    await vi.waitFor(() => assert.equal(continuous.start.mock.calls.length, 2), { interval: 5 });
    assert.equal(continuous.start.mock.calls[1]?.[2], false);
  }));

for (const change of ["cancelled", "replaced"] as const)
  test(`retry origin is revalidated after resolver preparation: ${change}`, () =>
    fixture(async ({ monitor, continuous, peers, execution }) => {
      const peer = peers[0];
      assert.ok(peer);
      const controller = new AbortController();
      monitor.explicitSync("home", execution(peer, controller.signal));
      const host = await resolver.prepareResolverHost("", undefined);
      const entered = deferred<void>();
      const prepared = deferred<resolver.ResolverHost>();
      vi.spyOn(resolver, "prepareResolverHost").mockImplementation(() => {
        entered.resolve();
        return prepared.promise;
      });
      monitor.schedule();
      await entered.promise;
      if (change === "cancelled") controller.abort();
      else peers[0] = { ...peer, generation: randomUUID() };
      prepared.resolve(host);
      await vi.waitFor(() => assert.equal(continuous.start.mock.calls.length, 2), { interval: 5 });
      assert.equal(continuous.start.mock.calls[1]?.[2], false);
    }));

test("close during resolver preparation settles it without activating a retry", () =>
  fixture(async ({ monitor, continuous, peers, execution }) => {
    const peer = peers[0];
    assert.ok(peer);
    monitor.explicitSync("home", execution(peer));
    const original = resolver.prepareResolverHost;
    const entered = deferred<void>();
    const prepared = deferred<resolver.ResolverHost>();
    const host = await original("", undefined);
    const settle = vi.spyOn(host, "settle");
    vi.spyOn(resolver, "prepareResolverHost").mockImplementation(() => {
      entered.resolve();
      return prepared.promise;
    });
    monitor.schedule();
    await entered.promise;
    const closed = monitor.close();
    prepared.resolve(host);
    await closed;
    assert.equal(continuous.start.mock.calls.length, 1);
    assert.equal(settle.mock.calls.length, 1);
  }));

test("an authorization publication failure during config loading blocks the pending retry", () =>
  fixture(async ({ monitor, continuous, peers, execution }) => {
    const peer = peers[0];
    assert.ok(peer);
    monitor.explicitSync("home", execution(peer));
    const original = config.loadConfigForCheck;
    const latest = await original();
    const entered = deferred<void>();
    const loaded = deferred<typeof latest>();
    vi.spyOn(config, "loadConfigForCheck").mockImplementation(() => {
      entered.resolve();
      return loaded.promise;
    });
    monitor.schedule();
    await entered.promise;
    vi.spyOn(consent, "revokeChangedBindings").mockImplementation(() => {
      throw new consent.ConsentPublicationError("fixture failure");
    });
    const changed = monitor.factsChanged();
    void changed.catch(() => {});
    loaded.resolve(latest);
    await assert.rejects(changed, /Automatic work is blocked/u);
    assert.equal(continuous.start.mock.calls.length, 1);
    assert.equal(await monitor.lifetime(), "pause", "failed publication must not enable implicit restart");
  }));

async function grant(root: string, settings: PiSyncSettingsV3) {
  const file = path.join(root, "pi-sync", "daemon.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.future = { retained: true };
  saved.setups.home = {
    fingerprint: consent.consentFingerprint(root, config.configFromSettings(settings)),
    afterExit: true,
    cwd: root,
    future: "retained",
  };
  await fs.writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  return { file, saved };
}

test("missing unattended consent permits exit without reading settings or creating files", () =>
  fixture(async ({ root, monitor }) => {
    const read = vi.spyOn(config, "loadConfigForCheck");
    const file = path.join(root, "pi-sync", "daemon.json");
    assert.equal(await monitor.lifetime(), "exit");
    await fs.rm(file);
    assert.equal(await monitor.lifetime(), "exit");
    assert.equal(read.mock.calls.length, 0);
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  }));

test("a valid grant keeps lifetime without resolving an unavailable model or changing evidence", () =>
  fixture(async ({ root, monitor, settings, continuous }) => {
    const { file, saved } = await grant(root, settings);
    saved.setups.home.model = {
      provider: "unavailable-fixture",
      id: "unavailable-fixture",
      signature: "a".repeat(64),
      authSource: "models_json_key",
    };
    await fs.writeFile(file, JSON.stringify(saved), { mode: 0o600 });
    const before = await fs.readFile(file);
    const settingsBefore = await fs.readFile(path.join(root, "pi-sync.json"));
    const resolve = vi.spyOn(resolver, "prepareResolverHost");
    assert.equal(await monitor.lifetime(), "keep");
    assert.equal(await monitor.lifetime(), "keep");
    assert.equal(resolve.mock.calls.length, 0);
    assert.equal(continuous.start.mock.calls.length, 1);
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await fs.readFile(path.join(root, "pi-sync.json")), settingsBefore);
  }));

for (const change of ["revoked", "fingerprint", "other-setup", "agent-mode", "continuous", "storage"] as const)
  test(`an ineligible after-exit grant does not keep lifetime: ${change}`, () =>
    fixture(async ({ root, monitor, settings, save }) => {
      const { file, saved } = await grant(root, settings);
      const home = settings.syncSetups.home;
      assert.ok(home);
      if (change === "revoked") saved.setups.home.afterExit = false;
      if (change === "fingerprint") saved.setups.home.fingerprint = "f".repeat(64);
      if (change === "other-setup") {
        saved.setups.other = saved.setups.home;
        delete saved.setups.home;
      }
      if (change === "agent-mode") home.sync.agentMode = false;
      if (change === "continuous") home.sync.continuous = false;
      if (change === "storage") home.storage.path = "different-root";
      await fs.writeFile(file, JSON.stringify(saved), { mode: 0o600 });
      await save();
      const before = await fs.readFile(file);
      assert.equal(await monitor.lifetime(), "exit");
      assert.deepEqual(await fs.readFile(file), before);
    }));

for (const change of ["model", "cwd", "sessionDir"] as const)
  test(`a changed interactive binding revokes unattended lifetime: ${change}`, () =>
    fixture(async ({ root, monitor, peers, settings, idle }) => {
      await grant(root, settings);
      idle.value = false;
      const peer = peers[0];
      assert.ok(peer);
      if (change === "model")
        peer.model = {
          provider: "fixture",
          id: "fixture",
          signature: "b".repeat(64),
          authSource: "models_json_key",
        };
      if (change === "cwd") peer.cwd = path.join(root, "other");
      if (change === "sessionDir") peer.sessionDir = path.join(root, "other-sessions");
      await monitor.factsChanged();
      assert.equal(await monitor.lifetime(), "exit");
      assert.equal(consent.readConsent(root)?.setups.home?.afterExit, false);
    }));

for (const failure of ["consent", "settings"] as const)
  test(`uncertain ${failure} reads pause lifetime without rewriting the invalid file`, () =>
    fixture(async ({ root, monitor, settings }) => {
      const { file } = await grant(root, settings);
      const target = failure === "consent" ? file : path.join(root, "pi-sync.json");
      await fs.writeFile(target, "{invalid", { mode: 0o600 });
      assert.equal(await monitor.lifetime(), "pause");
      assert.equal(await fs.readFile(target, "utf8"), "{invalid");
    }));

test("a cleanup safety barrier blocks lifetime and automatic work without revoking persisted consent", () =>
  fixture(async ({ root, monitor, settings, continuous }) => {
    const { file } = await grant(root, settings);
    const before = await fs.readFile(file);
    const original = config.loadConfigForCheck;
    const latest = await original();
    const entered = deferred<void>();
    const loaded = deferred<typeof latest>();
    vi.spyOn(config, "loadConfigForCheck").mockImplementation(() => {
      entered.resolve();
      return loaded.promise;
    });
    monitor.schedule();
    await entered.promise;
    monitor.blockAutomatic();
    loaded.resolve(latest);
    await monitor.factsChanged();
    assert.equal(await monitor.lifetime(), "pause");
    assert.equal(continuous.start.mock.calls.length, 1);
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal(consent.readConsent(root)?.setups.home?.afterExit, true);
  }));

test("a failed binding revocation keeps the prior grant paused rather than allowing implicit restart", () =>
  fixture(async ({ root, monitor, settings, idle }) => {
    const { file } = await grant(root, settings);
    const before = await fs.readFile(file);
    idle.value = false;
    vi.spyOn(consent, "revokeChangedBindings").mockImplementation(() => {
      throw new consent.ConsentPublicationError("fixture failure");
    });
    await assert.rejects(monitor.factsChanged(), /Automatic work is blocked/u);
    assert.equal(await monitor.lifetime(), "pause");
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal(consent.readConsent(root)?.setups.home?.afterExit, true);
  }));
