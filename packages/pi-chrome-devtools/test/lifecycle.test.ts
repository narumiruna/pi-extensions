import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  devToolsEndpoint,
  managedBrowserExtensionPaths,
  setBrowserManagerOperationsForTests,
} from "../src/browser-manager.js";
import chromeDevtools from "../src/chrome-devtools.js";
import {
  configureChromeDevtoolsToolExposure,
  initializeAvailableChromeDevtoolsTools,
  setChromeDevtoolsSessionOwner,
} from "../src/lazy-tools.js";
import {
  applyRuntimeWebMcpSetting,
  beginWebMcpOperation,
  currentWebMcpGeneration,
  state,
  webMcpEnabled,
} from "../src/runtime.js";
import { projectSettingsFilePath, saveBrowserSettings, settingsFilePath } from "../src/settings.js";
import { CHROME_DEVTOOLS_TOOL_NAMES, WEBMCP_TOOL_NAMES } from "../src/tool-names.js";

class LifecycleChild extends EventEmitter {
  killCalls = 0;
  kill() {
    this.killCalls += 1;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

async function withFixture(
  fn: (fixture: {
    cwdA: string;
    cwdB: string;
    extensionA: string;
    extensionB: string;
    executable: string;
  }) => Promise<void>,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-lifecycle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const environmentNames = [
    "PI_CHROME_DEVTOOLS_HOST",
    "PI_CHROME_DEVTOOLS_PORT",
    "PI_CHROME_DEVTOOLS_AUTO_LAUNCH",
    "PI_CHROME_DEVTOOLS_BROWSER",
  ] as const;
  const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]])) as Record<
    (typeof environmentNames)[number],
    string | undefined
  >;
  const agentDir = path.join(root, "agent");
  const cwdA = path.join(root, "project-a");
  const cwdB = path.join(root, "project-b");
  const extensionA = path.join(root, "extension-a");
  const extensionB = path.join(root, "extension-b");
  const executable = path.join(root, "chrome-for-testing");
  for (const directory of [agentDir, cwdA, cwdB, extensionA, extensionB]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const [directory, name] of [
    [extensionA, "A"],
    [extensionB, "B"],
  ] as const) {
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name, version: "1.0.0" }),
    );
  }
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const name of environmentNames) delete process.env[name];
  try {
    await fn({ cwdA, cwdB, extensionA, extensionB, executable });
  } finally {
    state.sessionController.abort();
    state.sessionGeneration += 1;
    state.managedBrowser = undefined;
    state.launchPromise = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const name of environmentNames) {
      const previous = previousEnvironment[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function sessionOwner(ctx: unknown) {
  return (ctx as { sessionManager: object }).sessionManager;
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("session_start applies trusted project browser settings and status reports effective sources", async () => {
  await withFixture(async ({ cwdA, extensionA, extensionB, executable }) => {
    writeJson(settingsFilePath(), {
      browser: {
        endpoint: "http://localhost:9333",
        autoLaunch: false,
        executablePath: executable,
        extensionPaths: [extensionA],
      },
    });
    writeJson(projectSettingsFilePath(cwdA), {
      browser: { extensionPaths: [path.relative(cwdA, extensionB)] },
    });
    const mock = createMockPi();
    const { ctx, notifications } = createMockContext({
      cwd: cwdA,
      mode: "rpc",
      hasUI: true,
      isProjectTrusted: () => true,
    });
    chromeDevtools(mock.pi);

    await mock.events.get("session_start")?.[0]?.({}, ctx);
    await mock.commands.get("chrome-devtools")?.handler("status", ctx);

    assert.equal(state.host, "localhost");
    assert.equal(state.port, 9333);
    assert.equal(state.configuredPort, 9333);
    assert.equal(state.autoLaunchEnabled, false);
    assert.equal(state.endpointSource, "user");
    assert.equal(state.autoLaunchSource, "user");
    assert.deepEqual(state.extensionPaths, [extensionB]);
    assert.equal(state.browserExecutable, executable);
    assert.equal(state.extensionPathsSource, "project");
    assert.equal(devToolsEndpoint(sessionOwner(ctx)), "http://localhost:9333");
    assert.deepEqual(managedBrowserExtensionPaths(sessionOwner(ctx)), [extensionB]);
    const status = notifications.at(-1)?.message ?? "";
    assert.match(status, new RegExp(`Project settings: .*${path.basename(cwdA)}.*trusted`));
    assert.match(status, /Endpoint source: user/);
    assert.match(status, /Auto-launch: off \(user\)/);
    assert.match(status, /Unpacked extensions \(project\)/);
    assert.match(status, /Chrome for Testing or Chromium/);
    assert.match(status, /manual JSON edits require \/reload or session replacement/);
  });
});

test("session start loads the user WebMCP gate and reports its experimental safety contract", async () => {
  await withFixture(async ({ cwdA }) => {
    writeJson(settingsFilePath(), {
      tools: CHROME_DEVTOOLS_TOOL_NAMES,
      updatedAt: 1,
      webmcp: { enabled: true },
    });
    const mock = createMockPi({ activeTools: ["other_tool", ...CHROME_DEVTOOLS_TOOL_NAMES] });
    const { ctx, notifications } = createMockContext({
      cwd: cwdA,
      hasUI: true,
      mode: "rpc",
      model: { api: "openai-completions", provider: "other", id: "eager" },
    });
    chromeDevtools(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    await mock.commands.get("chrome-devtools")?.handler("status", ctx);

    assert.equal(webMcpEnabled(sessionOwner(ctx)), true);
    assert.ok(WEBMCP_TOOL_NAMES.every((name) => mock.rawPi.getActiveTools().includes(name)));
    assert.ok(notifications.some(({ message }) => /Experimental WebMCP is enabled/u.test(message)));
    assert.match(notifications.at(-1)?.message ?? "", /WebMCP: enabled · experimental/u);
  });
});

test("session start warns when deprecated environment overrides remain active", async () => {
  await withFixture(async ({ cwdA }) => {
    writeJson(settingsFilePath(), {
      browser: { endpoint: "http://json.example:9333", autoLaunch: false },
    });
    process.env.PI_CHROME_DEVTOOLS_HOST = "127.0.0.1";
    process.env.PI_CHROME_DEVTOOLS_PORT = "9444";
    const mock = createMockPi();
    const { ctx, notifications } = createMockContext({ cwd: cwdA });
    chromeDevtools(mock.pi);

    await mock.events.get("session_start")?.[0]?.({}, ctx);

    assert.equal(state.host, "127.0.0.1");
    assert.equal(state.port, 9444);
    assert.equal(state.endpointSource, "environment");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /environment settings are deprecated/i);
    assert.match(notifications[0]?.message ?? "", /browser\.endpoint/);
  });
});

test("session replacement discards the stale continuation and applies only the latest cwd", async () => {
  await withFixture(async ({ cwdA, cwdB, extensionA, extensionB, executable }) => {
    writeJson(settingsFilePath(), { browser: { executablePath: executable } });
    writeJson(projectSettingsFilePath(cwdA), {
      browser: { extensionPaths: [path.relative(cwdA, extensionA)] },
    });
    writeJson(projectSettingsFilePath(cwdB), {
      browser: { extensionPaths: [path.relative(cwdB, extensionB)] },
    });
    const mock = createMockPi();
    chromeDevtools(mock.pi);
    const first = createMockContext({ cwd: cwdA, isProjectTrusted: () => true }).ctx;
    const second = createMockContext({ cwd: cwdB, isProjectTrusted: () => true }).ctx;

    const firstStart = mock.events.get("session_start")?.[0]?.({}, first);
    const secondStart = mock.events.get("session_start")?.[0]?.({}, second);
    await Promise.all([firstStart, secondStart]);

    assert.deepEqual(state.extensionPaths, [extensionB]);
    assert.equal(state.projectSettingsFilePath, projectSettingsFilePath(cwdB));
  });
});

test("WebMCP enablement, exposure, and invalidation are scoped to the session manager", () => {
  const first = sessionOwner(createMockContext().ctx);
  const second = sessionOwner(createMockContext().ctx);
  const firstPi = createMockPi({ activeTools: [...CHROME_DEVTOOLS_TOOL_NAMES] });
  const secondPi = createMockPi({ activeTools: [...CHROME_DEVTOOLS_TOOL_NAMES] });
  for (const [mock, owner] of [
    [firstPi, first],
    [secondPi, second],
  ] as const) {
    setChromeDevtoolsSessionOwner(mock.pi, owner);
    initializeAvailableChromeDevtoolsTools(mock.pi);
    applyRuntimeWebMcpSetting(true, owner);
    configureChromeDevtoolsToolExposure(mock.pi, CHROME_DEVTOOLS_TOOL_NAMES);
  }
  const firstOperation = beginWebMcpOperation(first);
  const secondOperation = beginWebMcpOperation(second);
  applyRuntimeWebMcpSetting(false, second);
  configureChromeDevtoolsToolExposure(secondPi.pi, CHROME_DEVTOOLS_TOOL_NAMES);
  assert.equal(firstOperation.signal.aborted, false);
  assert.equal(secondOperation.signal.aborted, true);
  assert.equal(webMcpEnabled(first), true);
  assert.equal(webMcpEnabled(second), false);
  assert.ok(WEBMCP_TOOL_NAMES.every((name) => firstPi.rawPi.getActiveTools().includes(name)));
  assert.ok(WEBMCP_TOOL_NAMES.every((name) => !secondPi.rawPi.getActiveTools().includes(name)));
  firstOperation.dispose();
  secondOperation.dispose();
});

test("model replacement invalidates every prior WebMCP identity and active operation", async () => {
  await withFixture(async () => {
    const mock = createMockPi();
    const { ctx } = createMockContext();
    chromeDevtools(mock.pi);
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const owner = sessionOwner(ctx);
    const operation = beginWebMcpOperation(owner);
    const generation = currentWebMcpGeneration(owner);
    await mock.events.get("model_select")?.[0]?.(
      { model: { api: "openai-completions", provider: "other", id: "replacement" } },
      ctx,
    );
    assert.equal(operation.signal.aborted, true);
    assert.ok(currentWebMcpGeneration(owner) > generation);
    operation.dispose();
  });
});

test("session shutdown waits for an in-flight browser settings publication", async () => {
  await withFixture(async () => {
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite: (() => void) | undefined;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const save = saveBrowserSettings(
      { autoLaunch: false },
      {
        write: async (temporaryPath, data) => {
          writeFileSync(temporaryPath, data);
          markWriteStarted?.();
          await writeBlocked;
        },
      },
    );
    await writeStarted;
    const mock = createMockPi();
    const { ctx } = createMockContext();
    chromeDevtools(mock.pi);
    let shutdownSettled = false;
    const shutdown = Promise.resolve(mock.events.get("session_shutdown")?.[0]?.({}, ctx)).then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownSettled, false);
    releaseWrite?.();
    await Promise.all([save, shutdown]);
    assert.equal(shutdownSettled, true);
  });
});

test("session_shutdown clears status and releases an owned browser once", async () => {
  await withFixture(async () => {
    const child = new LifecycleChild();
    const removed: string[] = [];
    const restore = setBrowserManagerOperationsForTests({
      rm: async (target) => {
        removed.push(target);
      },
    });
    const mock = createMockPi();
    const { ctx, statuses } = createMockContext();
    state.managedBrowser = {
      process: child as unknown as ChildProcess,
      userDataDir: "/tmp/lifecycle-profile",
      exited: false,
      ready: true,
      ownerGeneration: state.sessionGeneration,
      sessionOwner: sessionOwner(ctx),
    };
    chromeDevtools(mock.pi);
    const webMcpOperation = beginWebMcpOperation(sessionOwner(ctx));
    try {
      await Promise.all([
        mock.events.get("session_shutdown")?.[0]?.({}, ctx),
        mock.events.get("session_shutdown")?.[0]?.({}, ctx),
      ]);
      assert.equal(child.killCalls, 1);
      assert.deepEqual(removed, ["/tmp/lifecycle-profile"]);
      assert.equal(statuses.get("chrome-devtools"), undefined);
      assert.equal(state.managedBrowser, undefined);
      assert.equal(webMcpOperation.signal.aborted, true);
    } finally {
      restore();
    }
  });
});
