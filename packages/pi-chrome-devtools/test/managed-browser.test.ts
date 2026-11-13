import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
  options: { portAvailable?: boolean | (() => boolean); fetch?: (input: string) => Promise<Response> } = {},
) {
  const child = new FakeChildProcess();
  const calls = {
    spawn: [] as Array<{ executable: string; args: string[]; shell: boolean | undefined }>,
    fetch: [] as string[],
    rm: [] as string[],
    version: [] as string[],
  };
  const restore = setBrowserManagerOperationsForTests({
    access: async () => undefined,
    mkdtemp: async () => "/tmp/test-managed-profile",
    readFile: async () => "9333\n/devtools/browser/test\n",
    rm: async (target) => {
      calls.rm.push(target);
    },
    fetch: async (input) => {
      const url = String(input);
      calls.fetch.push(url);
      if (options.fetch) return options.fetch(url);
      return new Response(JSON.stringify({ Browser: "Chrome/149" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
  });
  return { child, calls, restore };
}

test("managed extension argv is deterministic and keeps multiple paths in shell-free arguments", () => {
  assert.deepEqual(
    buildManagedBrowserLaunchArguments("/tmp/profile", "0", ["/extensions/one with spaces", "/extensions/two"]),
    [
      "--remote-debugging-port=0",
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
    fetch: async () => {
      signalReadinessStarted?.();
      await readinessBlocked;
      return new Response(JSON.stringify({ Browser: "Chrome/149" }), { status: 200 });
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
    fetch: async () => {
      signalReadinessStarted?.();
      await readinessBlocked;
      return new Response(JSON.stringify({ Browser: "Chrome/149" }), { status: 200 });
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
  const removed: string[] = [];
  const restore = setBrowserManagerOperationsForTests({
    access: async () => undefined,
    inspectBrowserVersion: async () => "Chromium 149.0.0.0",
    mkdtemp: async () => `/tmp/session-profile-${++profileIndex}`,
    readFile: async (filePath) =>
      filePath.includes("session-profile-1") ? "9333\n/devtools/browser/first\n" : "9444\n/devtools/browser/second\n",
    rm: async (target) => {
      removed.push(target);
    },
    fetch: async (input) => {
      fetchedUrls.push(input);
      return new Response(JSON.stringify({ Browser: "Chrome/149" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    spawn: (executable, args) => {
      spawnExecutables.push(executable);
      spawnArguments.push(args);
      const child = children[spawnIndex++];
      assert.ok(child);
      queueMicrotask(() => child.emit("spawn"));
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
    await ensureDevToolsEndpoint(undefined, undefined, firstOwner);
    await ensureDevToolsEndpoint(undefined, undefined, secondOwner);
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
  } finally {
    restore();
  }
});
