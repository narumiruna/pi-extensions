import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import {
  browserSettingsForOwner,
  buildManagedBrowserLaunchArguments,
  classifyExtensionBrowserVersion,
  devToolsEndpoint,
  endpointSourceLabel,
  ensureDevToolsEndpoint,
  managedBrowserForOwner,
  setBrowserManagerOperationsForTests,
  shutdownManagedBrowser,
  startManagedBrowserSession,
  syncManagedBrowserSettings,
} from "../src/browser-manager.js";
import { beginWebMcpOperation, state } from "../src/runtime.js";
import type { EffectiveBrowserSettings } from "../src/settings.js";

class FakeChildProcess extends EventEmitter {
  stderr = new PassThrough();
  exited = false;
  killCalls: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals) {
    this.killCalls.push(signal);
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit("exit", 0, signal ?? null));
    }
    return true;
  }
}

function resetRuntime(overrides: Partial<typeof state> = {}) {
  state.sessionController.abort();
  Object.assign(state, {
    host: "127.0.0.1",
    port: 9222,
    configuredPort: 9222,
    hostConfigured: false,
    portConfigured: false,
    autoLaunchEnabled: true,
    endpointSource: "default",
    autoLaunchSource: "default",
    browserExecutable: "/test/chrome-for-testing",
    extensionPaths: ["/test/extension-a", "/test/extension-b"],
    browserExecutableSource: "user",
    extensionPathsSource: "user",
    managedBrowser: undefined,
    launchPromise: undefined,
    lastLaunchAttempt: undefined,
    shuttingDown: false,
    sessionGeneration: state.sessionGeneration + 1,
    sessionController: new AbortController(),
    ...overrides,
  });
}

function successfulOperations(
  options: {
    portAvailable?: boolean | (() => boolean);
    fetch?: (input: string) => Promise<Response>;
    allocatePort?: () => Promise<number>;
    startup?: (child: FakeChildProcess, args: string[]) => void;
  } = {},
) {
  const child = new FakeChildProcess();
  const calls = {
    spawn: [] as Array<{ executable: string; args: string[]; shell: boolean | undefined }>,
    fetch: [] as string[],
    rm: [] as string[],
    version: [] as string[],
    allocations: [] as string[],
  };
  const restore = setBrowserManagerOperationsForTests({
    access: async () => undefined,
    mkdtemp: async () => "/tmp/test-managed-profile",
    allocatePort: async (host) => {
      calls.allocations.push(host);
      return options.allocatePort ? options.allocatePort() : 9333;
    },
    rm: async (target) => {
      calls.rm.push(target);
    },
    fetch: async (input) => {
      const url = String(input);
      calls.fetch.push(url);
      if (options.fetch) return options.fetch(url);
      return browserVersionResponse(url);
    },
    inspectBrowserVersion: async (executable) => {
      calls.version.push(executable);
      return "Google Chrome for Testing 149.0.0.0";
    },
    isPortAvailable: async () =>
      typeof options.portAvailable === "function" ? options.portAvailable() : (options.portAvailable ?? true),
    sleep: async () => undefined,
    spawn: (executable, args, spawnOptions) => {
      calls.spawn.push({ executable, args, shell: spawnOptions.shell });
      queueMicrotask(() => {
        child.emit("spawn");
        if (options.startup) options.startup(child, args);
        else announceStartup(child, args);
      });
      return child as unknown as ChildProcess;
    },
  });
  return { child, calls, restore };
}

function announceStartup(child: FakeChildProcess, args: string[]) {
  const port = args[0]?.split("=")[1];
  child.stderr.write(`DevTools listening on ws://127.0.0.1:${port}/devtools/browser/test\n`);
}

function browserVersionResponse(input: string, identity = "test") {
  return new Response(
    JSON.stringify({
      Browser: "Chrome/149",
      webSocketDebuggerUrl: `ws://${new URL(input).host}/devtools/browser/${identity}`,
    }),
    { status: 200 },
  );
}

test("managed extension argv is deterministic and keeps multiple paths in shell-free arguments", () => {
  assert.deepEqual(
    buildManagedBrowserLaunchArguments("/tmp/profile", "9333", ["/extensions/one with spaces", "/extensions/two"]),
    [
      "--remote-debugging-port=9333",
      "--user-data-dir=/tmp/profile",
      "--disable-extensions-except=/extensions/one with spaces,/extensions/two",
      "--load-extension=/extensions/one with spaces,/extensions/two",
      ...(process.platform === "win32" ? ["--do-not-de-elevate"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
  );
});

test("browser product classification accepts Chrome for Testing and Chromium only", () => {
  assert.deepEqual(classifyExtensionBrowserVersion("Google Chrome for Testing 149.0.0.0"), {
    supported: true,
    product: "Chrome for Testing",
  });
  assert.deepEqual(classifyExtensionBrowserVersion("Chromium 149.0.0.0"), {
    supported: true,
    product: "Chromium",
  });
  assert.equal(classifyExtensionBrowserVersion("Google Chrome 148.0.0.0").supported, false);
  assert.equal(classifyExtensionBrowserVersion("Brave Browser 1.0 Chromium 149").supported, false);
});

test("extension-configured endpoints bypass attach-first and launch an owned browser", async () => {
  resetRuntime();
  const { calls, restore } = successfulOperations();
  try {
    await ensureDevToolsEndpoint();
    assert.equal(calls.spawn.length, 1);
    assert.equal(calls.spawn[0]?.shell, false);
    assert.equal(calls.spawn[0]?.args[0], "--remote-debugging-port=9333");
    assert.equal(calls.fetch.length, 1, "only the post-spawn readiness check should fetch");
    assert.deepEqual(calls.version, ["/test/chrome-for-testing"]);
    assert.equal(state.port, 9333);
    assert.equal(state.managedBrowser?.ready, true);
  } finally {
    await shutdownManagedBrowser();
    restore();
  }
});

test("extension launch rejects remote, disabled, missing, unsupported, and occupied modes before spawn", async () => {
  for (const scenario of [
    { overrides: { host: "remote.example" }, pattern: /local.*managed browser/i },
    { overrides: { autoLaunchEnabled: false }, pattern: /auto-launch.*required/i },
    { overrides: { browserExecutable: undefined }, pattern: /executablePath.*Chrome for Testing/i },
  ] as const) {
    resetRuntime(scenario.overrides);
    const { calls, restore } = successfulOperations();
    try {
      await assert.rejects(ensureDevToolsEndpoint(), scenario.pattern);
      assert.equal(calls.spawn.length, 0);
    } finally {
      restore();
    }
  }

  resetRuntime();
  const unsupported = successfulOperations();
  unsupported.restore();
  const restoreUnsupported = setBrowserManagerOperationsForTests({
    access: async () => undefined,
    inspectBrowserVersion: async () => "Google Chrome 148.0.0.0",
    spawn: (..._args) => {
      throw new Error("must not spawn");
    },
  });
  try {
    await assert.rejects(ensureDevToolsEndpoint(), /unsupported.*Google Chrome.*Chrome for Testing/i);
  } finally {
    restoreUnsupported();
  }

  resetRuntime({ portConfigured: true });
  const occupied = successfulOperations({ portAvailable: false });
  try {
    await assert.rejects(ensureDevToolsEndpoint(), /port 9222.*already in use/i);
    assert.equal(occupied.calls.spawn.length, 0);
  } finally {
    occupied.restore();
  }
});

test("a ready extension browser on an explicit port is reused without rechecking its port", async () => {
  resetRuntime({ portConfigured: true });
  let portChecks = 0;
  const { calls, restore } = successfulOperations({
    portAvailable: () => {
      portChecks += 1;
      return portChecks === 1;
    },
  });
  try {
    await ensureDevToolsEndpoint();
    await ensureDevToolsEndpoint();
    assert.equal(portChecks, 1);
    assert.equal(calls.spawn.length, 1);
    assert.deepEqual(calls.allocations, []);
    assert.equal(calls.spawn[0]?.args[0], "--remote-debugging-port=9222");
  } finally {
    await shutdownManagedBrowser();
    restore();
  }
});

test("an in-flight extension launch owns its explicit port for concurrent callers", async () => {
  resetRuntime({ portConfigured: true });
  let portChecks = 0;
  let signalReadinessStarted: (() => void) | undefined;
  const readinessStarted = new Promise<void>((resolve) => {
    signalReadinessStarted = resolve;
  });
  let releaseReadiness: (() => void) | undefined;
  const readinessBlocked = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  const { calls, restore } = successfulOperations({
    portAvailable: () => {
      portChecks += 1;
      return portChecks === 1;
    },
    fetch: async (input) => {
      signalReadinessStarted?.();
      await readinessBlocked;
      return browserVersionResponse(input);
    },
  });
  try {
    const first = ensureDevToolsEndpoint();
    await readinessStarted;
    const launches = Promise.all([first, ensureDevToolsEndpoint()]);
    releaseReadiness?.();
    await launches;
    assert.equal(portChecks, 1);
    assert.equal(calls.spawn.length, 1);
  } finally {
    releaseReadiness?.();
    await shutdownManagedBrowser();
    restore();
  }
});

test("caller cancellation leaves the shared managed-browser launch available to other waiters", async () => {
  resetRuntime({ portConfigured: true });
  let signalReadinessStarted: (() => void) | undefined;
  const readinessStarted = new Promise<void>((resolve) => {
    signalReadinessStarted = resolve;
  });
  let releaseReadiness: (() => void) | undefined;
  const readinessBlocked = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  const { calls, restore } = successfulOperations({
    fetch: async (input) => {
      signalReadinessStarted?.();
      await readinessBlocked;
      return browserVersionResponse(input);
    },
  });
  const caller = new AbortController();
  const owner = {};
  try {
    const first = ensureDevToolsEndpoint(undefined, caller.signal, owner);
    await readinessStarted;
    const second = ensureDevToolsEndpoint(undefined, undefined, owner);
    caller.abort(new Error("first caller cancelled"));
    await assert.rejects(first, /first caller cancelled/u);
    releaseReadiness?.();
    await second;
    assert.equal(calls.spawn.length, 1);
    assert.equal(managedBrowserForOwner(owner)?.ready, true);
    const operation = beginWebMcpOperation(owner);
    await shutdownManagedBrowser(undefined, { owner });
    assert.equal(operation.signal.aborted, true);
    operation.dispose();
  } finally {
    releaseReadiness?.();
    await shutdownManagedBrowser(undefined, { owner });
    restore();
  }
});

test("managed browsers and shutdown stay scoped to each session manager", async () => {
  resetRuntime();
  const firstOwner = {};
  const secondOwner = {};
  const children = [new FakeChildProcess(), new FakeChildProcess()];
  const fetchedUrls: string[] = [];
  const spawnArguments: string[][] = [];
  const spawnExecutables: string[] = [];
  let profileIndex = 0;
  let spawnIndex = 0;
  let portIndex = 0;
  const removed: string[] = [];
  const restore = setBrowserManagerOperationsForTests({
    access: async () => undefined,
    inspectBrowserVersion: async () => "Chromium 149.0.0.0",
    mkdtemp: async () => `/tmp/session-profile-${++profileIndex}`,
    allocatePort: async () => [9333, 9444][portIndex++] ?? 0,
    rm: async (target) => {
      removed.push(target);
    },
    fetch: async (input) => {
      fetchedUrls.push(input);
      return browserVersionResponse(input);
    },
    spawn: (executable, args) => {
      spawnExecutables.push(executable);
      spawnArguments.push(args);
      const child = children[spawnIndex++];
      assert.ok(child);
      queueMicrotask(() => {
        child.emit("spawn");
        announceStartup(child, args);
      });
      return child as unknown as ChildProcess;
    },
  });
  startManagedBrowserSession(firstOwner);
  startManagedBrowserSession(secondOwner);
  const firstSettings = {
    endpoint: "http://localhost:9222",
    host: "localhost",
    port: 9222,
    hostConfigured: true,
    portConfigured: false,
    autoLaunchEnabled: true,
    executablePath: "/test/first-chrome-for-testing",
    extensionPaths: ["/projects/first/extension"],
    endpointSource: "user",
    autoLaunchSource: "user",
    executablePathSource: "user",
    extensionPathsSource: "project",
  } satisfies EffectiveBrowserSettings;
  const secondSettings = {
    endpoint: "http://127.0.0.1:9555",
    host: "127.0.0.1",
    port: 9555,
    hostConfigured: true,
    portConfigured: false,
    autoLaunchEnabled: true,
    executablePath: "/test/second-chromium",
    extensionPaths: ["/projects/second/extension"],
    endpointSource: "environment",
    autoLaunchSource: "environment",
    executablePathSource: "environment",
    extensionPathsSource: "user",
  } satisfies EffectiveBrowserSettings;
  syncManagedBrowserSettings(firstOwner, firstSettings);
  syncManagedBrowserSettings(secondOwner, secondSettings);
  Object.assign(state, {
    host: "global-settings-must-not-leak.example",
    port: 9666,
    configuredPort: 9666,
    hostConfigured: true,
    portConfigured: true,
    autoLaunchEnabled: false,
    browserExecutable: undefined,
    extensionPaths: [],
    endpointSource: "default",
    autoLaunchSource: "default",
    browserExecutableSource: "default",
    extensionPathsSource: "default",
  });
  try {
    await Promise.all([
      ensureDevToolsEndpoint(undefined, undefined, firstOwner),
      ensureDevToolsEndpoint(undefined, undefined, secondOwner),
    ]);
    assert.notEqual(managedBrowserForOwner(firstOwner), managedBrowserForOwner(secondOwner));
    assert.equal(managedBrowserForOwner(firstOwner)?.port, 9333);
    assert.equal(managedBrowserForOwner(secondOwner)?.port, 9444);
    assert.deepEqual(browserSettingsForOwner(firstOwner), firstSettings);
    assert.deepEqual(browserSettingsForOwner(secondOwner), secondSettings);
    assert.equal(devToolsEndpoint(firstOwner), "http://localhost:9333");
    assert.equal(devToolsEndpoint(secondOwner), "http://127.0.0.1:9444");
    assert.equal(endpointSourceLabel(firstOwner), "user");
    assert.equal(endpointSourceLabel(secondOwner), "environment");
    assert.deepEqual(spawnExecutables, ["/test/first-chrome-for-testing", "/test/second-chromium"]);
    assert.deepEqual(fetchedUrls, ["http://localhost:9333/json/version", "http://127.0.0.1:9444/json/version"]);
    assert.ok(spawnArguments[0]?.includes("--load-extension=/projects/first/extension"));
    assert.ok(spawnArguments[1]?.includes("--load-extension=/projects/second/extension"));

    const firstOperation = beginWebMcpOperation(firstOwner);
    const secondOperation = beginWebMcpOperation(secondOwner);
    await shutdownManagedBrowser(undefined, { owner: firstOwner });
    assert.equal(children[0]?.killCalls.length, 1);
    assert.equal(children[1]?.killCalls.length, 0);
    assert.equal(firstOperation.signal.aborted, true);
    assert.equal(secondOperation.signal.aborted, false);
    assert.equal(managedBrowserForOwner(firstOwner), undefined);
    assert.equal(managedBrowserForOwner(secondOwner)?.ready, true);
    assert.deepEqual(removed, ["/tmp/session-profile-1"]);
    firstOperation.dispose();
    secondOperation.dispose();
  } finally {
    await shutdownManagedBrowser(undefined, { owner: firstOwner });
    await shutdownManagedBrowser(undefined, { owner: secondOwner });
    restore();
    resetRuntime();
  }
});

test("a missing configured extension browser fails with Chrome for Testing guidance", async () => {
  resetRuntime({ browserExecutable: "/missing/chrome-for-testing" });
  let spawnCalls = 0;
  const restore = setBrowserManagerOperationsForTests({
    access: async () => Promise.reject(new Error("missing")),
    spawn: () => {
      spawnCalls += 1;
      return new FakeChildProcess() as unknown as ChildProcess;
    },
  });
  try {
    await assert.rejects(ensureDevToolsEndpoint(), /not found or is not executable.*Chrome for Testing or Chromium/is);
    assert.equal(spawnCalls, 0);
  } finally {
    restore();
  }
});

test("partial spawn failure removes the owned profile and leaves no managed browser", async () => {
  resetRuntime();
  const child = new FakeChildProcess();
  const removed: string[] = [];
  const restore = setBrowserManagerOperationsForTests({
    access: async () => undefined,
    inspectBrowserVersion: async () => "Chromium 149.0.0.0",
    allocatePort: async () => 9333,
    isPortAvailable: async () => true,
    mkdtemp: async () => "/tmp/partial-profile",
    rm: async (target) => {
      removed.push(target);
    },
    spawn: () => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child as unknown as ChildProcess;
    },
  });
  try {
    await assert.rejects(ensureDevToolsEndpoint(), /spawn failed/);
    assert.equal(state.managedBrowser, undefined);
    assert.deepEqual(removed, ["/tmp/partial-profile"]);
  } finally {
    restore();
  }
});

test("session cancellation after an awaited profile allocation prevents spawn and cleans up", async () => {
  resetRuntime();
  let releaseProfile: (() => void) | undefined;
  const profileAllocated = new Promise<void>((resolve) => {
    releaseProfile = resolve;
  });
  let continueProfile: (() => void) | undefined;
  const profileBlocked = new Promise<void>((resolve) => {
    continueProfile = resolve;
  });
  let spawnCalls = 0;
  const removed: string[] = [];
  const restore = setBrowserManagerOperationsForTests({
    access: async () => undefined,
    inspectBrowserVersion: async () => "Chromium 149.0.0.0",
    isPortAvailable: async () => true,
    mkdtemp: async () => {
      releaseProfile?.();
      await profileBlocked;
      return "/tmp/cancelled-profile";
    },
    rm: async (target) => {
      removed.push(target);
    },
    spawn: () => {
      spawnCalls += 1;
      return new FakeChildProcess() as unknown as ChildProcess;
    },
  });
  try {
    const launch = ensureDevToolsEndpoint();
    await profileAllocated;
    state.sessionController.abort();
    state.sessionGeneration += 1;
    continueProfile?.();
    await assert.rejects(launch, /cancelled|replaced/i);
    assert.equal(spawnCalls, 0);
    assert.deepEqual(removed, ["/tmp/cancelled-profile"]);
  } finally {
    restore();
  }
});

test("repeated shutdown kills and removes an owned browser exactly once", async () => {
  resetRuntime();
  const { child, calls, restore } = successfulOperations();
  try {
    await ensureDevToolsEndpoint();
    const managed = state.managedBrowser;
    assert.ok(managed);
    await Promise.all([shutdownManagedBrowser(managed), shutdownManagedBrowser(managed)]);
    assert.equal(child.killCalls.length, 1);
    assert.deepEqual(calls.rm, ["/tmp/test-managed-profile"]);
  } finally {
    restore();
  }
});

test("no-extension mode preserves attach-first behavior", async () => {
  resetRuntime({ extensionPaths: [] });
  const { calls, restore } = successfulOperations();
  try {
    await ensureDevToolsEndpoint();
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.spawn.length, 0);
    assert.deepEqual(calls.allocations, []);
  } finally {
    restore();
  }
});

test("default attach failures use a nonzero automatic port without a settings file or port file", async () => {
  for (const failure of [
    async () => {
      throw new Error("connection refused");
    },
    async () => new Response("not a CDP endpoint", { status: 404 }),
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("not JSON", { status: 200 }),
  ]) {
    resetRuntime({ extensionPaths: [] });
    const { calls, restore } = successfulOperations({
      fetch: async (input) => (new URL(input).port === "9222" ? failure() : browserVersionResponse(input)),
    });
    try {
      await ensureDevToolsEndpoint(0);
      assert.deepEqual(calls.allocations, ["127.0.0.1"]);
      assert.equal(calls.spawn[0]?.args[0], "--remote-debugging-port=9333");
      assert.equal(calls.version.length, 0, "normal discovery does not require an extension product check");
      assert.equal(state.port, 9333);
      assert.equal(state.managedBrowser?.ready, true);
      assert.deepEqual(calls.fetch, ["http://127.0.0.1:9222/json/version", "http://127.0.0.1:9333/json/version"]);
    } finally {
      await shutdownManagedBrowser();
      assert.equal(state.port, 9222);
      restore();
    }
  }
});

test("an explicit no-extension endpoint does not escape unexpected HTTP errors onto another port", async () => {
  resetRuntime({ extensionPaths: [], portConfigured: true });
  const { calls, restore } = successfulOperations({ fetch: async () => new Response("not CDP", { status: 404 }) });
  try {
    await assert.rejects(ensureDevToolsEndpoint(0), /404/);
    assert.equal(calls.spawn.length, 0);
    assert.deepEqual(calls.allocations, []);
  } finally {
    restore();
  }
});

test("a valid competing CDP browser is rejected and the owned process and profile are released", async () => {
  for (const portConfigured of [false, true]) {
    resetRuntime({ portConfigured });
    const { calls, child, restore } = successfulOperations({
      fetch: async (input) => browserVersionResponse(input, "other-browser"),
    });
    try {
      await assert.rejects(ensureDevToolsEndpoint(0), /does not match the auto-launched browser/);
      assert.equal(state.managedBrowser, undefined);
      assert.equal(state.port, 9222);
      assert.equal(child.killCalls.length, 1);
      assert.deepEqual(calls.rm, ["/tmp/test-managed-profile"]);
    } finally {
      await shutdownManagedBrowser();
      restore();
    }
  }
});

test("HTTP readiness is not probed without the owned child's startup announcement", async () => {
  resetRuntime();
  const { calls, child, restore } = successfulOperations({ startup: () => undefined });
  try {
    await assert.rejects(ensureDevToolsEndpoint(0), /startup announcement/);
    assert.deepEqual(calls.fetch, []);
    assert.equal(child.killCalls.length, 1);
    assert.deepEqual(calls.rm, ["/tmp/test-managed-profile"]);
    assert.equal(state.managedBrowser, undefined);
  } finally {
    await shutdownManagedBrowser();
    restore();
  }
});

test("allocation failures and invalid ports do not spawn a process or leave an owned profile", async () => {
  for (const allocatePort of [
    async () => {
      throw new Error("port allocation failed");
    },
    ...[0, -1, 65536, 1.5, Number.NaN].map((port) => async () => port),
  ]) {
    resetRuntime();
    const { calls, restore } = successfulOperations({ allocatePort });
    try {
      await assert.rejects(ensureDevToolsEndpoint(0), /port allocation failed|valid nonzero DevTools port/);
      assert.equal(calls.spawn.length, 0);
      assert.deepEqual(calls.rm, ["/tmp/test-managed-profile"]);
      assert.equal(state.managedBrowser, undefined);
      assert.equal(state.port, 9222);
    } finally {
      restore();
    }
  }
});

test("session replacement during automatic port allocation prevents stale spawn and removes the profile", async () => {
  resetRuntime();
  const owner = {};
  let markAllocated: (() => void) | undefined;
  let releasePort: ((port: number) => void) | undefined;
  const allocated = new Promise<void>((resolve) => {
    markAllocated = resolve;
  });
  const blockedPort = new Promise<number>((resolve) => {
    releasePort = resolve;
  });
  const { calls, restore } = successfulOperations({
    allocatePort: () => {
      markAllocated?.();
      return blockedPort;
    },
  });
  try {
    const launch = ensureDevToolsEndpoint(0, undefined, owner);
    const rejected = assert.rejects(launch, /cancelled|replaced/);
    await allocated;
    startManagedBrowserSession(owner);
    releasePort?.(9333);
    await rejected;
    assert.equal(calls.spawn.length, 0);
    assert.deepEqual(calls.rm, ["/tmp/test-managed-profile"]);
    assert.equal(managedBrowserForOwner(owner), undefined);
    assert.equal(devToolsEndpoint(owner), "http://127.0.0.1:9222");
  } finally {
    releasePort?.(9333);
    await shutdownManagedBrowser(undefined, { owner });
    restore();
  }
});

test("shutdown during the startup announcement wait cancels the task and cleans up once", async () => {
  resetRuntime();
  const owner = {};
  let markSpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const { calls, child, restore } = successfulOperations({
    startup: () => {
      markSpawned?.();
    },
  });
  try {
    const launch = ensureDevToolsEndpoint(undefined, undefined, owner);
    const rejected = assert.rejects(launch, /cancelled/);
    await spawned;
    await Promise.all([rejected, shutdownManagedBrowser(undefined, { owner, cancelLaunch: true })]);
    assert.equal(child.killCalls.length, 1);
    assert.deepEqual(calls.rm, ["/tmp/test-managed-profile"]);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.deepEqual(calls.fetch, []);
    assert.equal(managedBrowserForOwner(owner), undefined);
  } finally {
    await shutdownManagedBrowser(undefined, { owner });
    restore();
  }
});

test("normal concurrent callers share startup validation instead of attaching to an unverified endpoint", async () => {
  resetRuntime({ extensionPaths: [] });
  let markReadiness: (() => void) | undefined;
  let releaseReadiness: (() => void) | undefined;
  const readinessStarted = new Promise<void>((resolve) => {
    markReadiness = resolve;
  });
  const readinessBlocked = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  const { calls, restore } = successfulOperations({
    fetch: async (input) => {
      if (new URL(input).port === "9222") throw new Error("connection refused");
      markReadiness?.();
      await readinessBlocked;
      return browserVersionResponse(input, "competing-browser");
    },
  });
  const rejected: Promise<void>[] = [];
  try {
    rejected.push(assert.rejects(ensureDevToolsEndpoint(0), /does not match/));
    await readinessStarted;
    rejected.push(assert.rejects(ensureDevToolsEndpoint(0), /does not match/));
    assert.equal(calls.fetch.length, 2, "a second caller must not probe the unverified endpoint");
    releaseReadiness?.();
    await Promise.all(rejected);
    assert.equal(calls.spawn.length, 1);
    assert.equal(state.managedBrowser, undefined);
  } finally {
    releaseReadiness?.();
    await Promise.allSettled(rejected);
    await shutdownManagedBrowser();
    restore();
  }
});

test("an attach probe that overlaps another caller's launch waits for owned-browser validation", async () => {
  resetRuntime({ extensionPaths: [] });
  let markAttach: (() => void) | undefined;
  let releaseAttach: (() => void) | undefined;
  let markReadiness: (() => void) | undefined;
  let releaseReadiness: (() => void) | undefined;
  const attachStarted = new Promise<void>((resolve) => {
    markAttach = resolve;
  });
  const attachBlocked = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const readinessStarted = new Promise<void>((resolve) => {
    markReadiness = resolve;
  });
  const readinessBlocked = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  let attachProbes = 0;
  const { calls, restore } = successfulOperations({
    fetch: async (input) => {
      if (new URL(input).port === "9222") {
        if (++attachProbes === 1) {
          markAttach?.();
          await attachBlocked;
          return browserVersionResponse(input);
        }
        throw new Error("connection refused");
      }
      markReadiness?.();
      await readinessBlocked;
      return browserVersionResponse(input, "competing-browser");
    },
  });
  const rejected: Promise<void>[] = [];
  try {
    rejected.push(assert.rejects(ensureDevToolsEndpoint(0), /does not match/));
    await attachStarted;
    rejected.push(assert.rejects(ensureDevToolsEndpoint(0), /does not match/));
    await readinessStarted;
    releaseAttach?.();
    releaseReadiness?.();
    await Promise.all(rejected);
    assert.equal(calls.spawn.length, 1);
    assert.equal(state.managedBrowser, undefined);
  } finally {
    releaseAttach?.();
    releaseReadiness?.();
    await Promise.allSettled(rejected);
    await shutdownManagedBrowser();
    restore();
  }
});

test("an owned browser that exits during HTTP readiness is never published as ready", async () => {
  resetRuntime();
  const { child, restore } = successfulOperations({
    fetch: async (input) => {
      child.kill();
      await Promise.resolve();
      return browserVersionResponse(input);
    },
  });
  try {
    await assert.rejects(ensureDevToolsEndpoint(0), /exited before DevTools became available/);
    assert.equal(state.managedBrowser, undefined);
    assert.equal(state.port, 9222);
  } finally {
    await shutdownManagedBrowser();
    restore();
  }
});
