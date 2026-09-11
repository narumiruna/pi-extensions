import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { devToolsEndpoint } from "../src/browser-manager.js";
import { showChromeDevtoolsBrowserSettings } from "../src/browser-settings-menu.js";
import chromeDevtools from "../src/chrome-devtools.js";
import {
  CHROME_DEVTOOLS_LOAD_TOOL_NAME,
  configureChromeDevtoolsToolExposure,
  initializeAvailableChromeDevtoolsTools,
} from "../src/lazy-tools.js";
import { beginWebMcpOperation, DEFAULT_HOST, DEFAULT_PORT, state, webMcpEnabled } from "../src/runtime.js";
import { projectSettingsFilePath, settingsFilePath } from "../src/settings.js";
import { CHROME_DEVTOOLS_TOOL_NAMES, WEBMCP_TOOL_NAMES } from "../src/tool-names.js";

class OwnedBrowserChild extends EventEmitter {
  killCalls = 0;

  kill() {
    this.killCalls += 1;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

const NATIVE_DEFERRED_MODEL = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-native-deferred",
  compat: { supportsAdditionalTools: true },
} as unknown as ExtensionContext["model"];

const ENVIRONMENT_NAMES = [
  "PI_CHROME_DEVTOOLS_HOST",
  "PI_CHROME_DEVTOOLS_PORT",
  "PI_CHROME_DEVTOOLS_AUTO_LAUNCH",
  "PI_CHROME_DEVTOOLS_BROWSER",
] as const;

function resetBrowserRuntimeState() {
  state.host = DEFAULT_HOST;
  state.port = DEFAULT_PORT;
  state.configuredPort = DEFAULT_PORT;
  state.hostConfigured = false;
  state.portConfigured = false;
  state.autoLaunchEnabled = true;
  state.endpointSource = "default";
  state.autoLaunchSource = "default";
  state.browserExecutable = undefined;
  state.extensionPaths = [];
  state.browserExecutableSource = "default";
  state.extensionPathsSource = "default";
  state.settingsFilePath = undefined;
  state.projectSettingsFilePath = undefined;
  state.projectSettingsTrusted = false;
  state.managedBrowser = undefined;
  state.launchPromise = undefined;
  state.lastLaunchAttempt = undefined;
  state.settingsNotice = undefined;
}

async function withBrowserSettingsMenu(
  run: (fixture: {
    directory: string;
    ctx: ReturnType<typeof createMockContext>["ctx"];
    notifications: ReturnType<typeof createMockContext>["notifications"];
    tui: ReturnType<typeof createTuiHarness>;
    generation: number;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-browser-menu-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousEnvironment = Object.fromEntries(ENVIRONMENT_NAMES.map((name) => [name, process.env[name]])) as Record<
    (typeof ENVIRONMENT_NAMES)[number],
    string | undefined
  >;
  process.env.PI_CODING_AGENT_DIR = directory;
  for (const name of ENVIRONMENT_NAMES) delete process.env[name];
  resetBrowserRuntimeState();
  state.sessionController.abort();
  state.sessionController = new AbortController();
  const generation = ++state.sessionGeneration;
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const mock = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  try {
    await run({ directory, ctx: mock.ctx, notifications: mock.notifications, tui, generation });
  } finally {
    tui.dispose();
    state.sessionController.abort();
    state.sessionController = new AbortController();
    state.sessionGeneration += 1;
    resetBrowserRuntimeState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const name of ENVIRONMENT_NAMES) {
      const previous = previousEnvironment[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function sessionOwner(ctx: unknown) {
  return (ctx as { sessionManager: object }).sessionManager;
}

function readSettings() {
  return JSON.parse(readFileSync(settingsFilePath(), "utf8")) as Record<string, unknown>;
}

test("browser settings save endpoint and auto-launch immediately while preserving unknown fields", async () => {
  await withBrowserSettingsMenu(async ({ ctx, notifications, tui, generation }) => {
    writeFileSync(settingsFilePath(), '{"future":{"kept":true},"browser":{"futureBrowserField":"kept"}}\n');
    const running = showChromeDevtoolsBrowserSettings(createMockPi().pi, ctx, generation);
    await tui.waitForOpen();
    const initial = tui.render().join("\n");
    assert.match(initial, /Browser settings/);
    assert.match(initial, /DevTools endpoint\s+http:\/\/127\.0\.0\.1:9222/);
    assert.match(initial, /Auto-launch\s+On/);
    assert.match(initial, /Browser executable\s+Automatic/);
    assert.match(initial, /Unpacked extensions\s+0 configured/);
    assert.ok(tui.resize({ width: 28 }).every((line) => visibleWidth(line) <= 28));
    tui.resize({ width: 80 });

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /DevTools endpoint/);
    tui.setFocused(true);
    tui.type("http://localhost:9333");
    tui.press("tui.input.submit");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /DevTools endpoint\s+http:\/\/localhost:9333/);
    assert.equal(state.host, "localhost");
    assert.equal(state.port, 9333);
    assert.equal(devToolsEndpoint(sessionOwner(ctx)), "http://localhost:9333");
    assert.equal(state.endpointSource, "user");

    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(state.autoLaunchEnabled, false);
    assert.equal(state.autoLaunchSource, "user");
    assert.deepEqual(readSettings(), {
      future: { kept: true },
      browser: {
        futureBrowserField: "kept",
        endpoint: "http://localhost:9333",
        autoLaunch: false,
      },
    });
    assert.ok(notifications.some(({ message }) => /endpoint saved/i.test(message)));
    assert.ok(notifications.some(({ message }) => /auto-launch: Off/i.test(message)));
    tui.press("ctrl+c");
    assert.deepEqual(await running, { closeParent: true });
  });
});

test("WebMCP settings toggle the experimental gate, tool exposure, and active operations", async () => {
  await withBrowserSettingsMenu(async ({ ctx, notifications, tui, generation }) => {
    const mockPi = createMockPi({ activeTools: ["other_tool", ...CHROME_DEVTOOLS_TOOL_NAMES] });
    initializeAvailableChromeDevtoolsTools(mockPi.pi);
    configureChromeDevtoolsToolExposure(mockPi.pi, CHROME_DEVTOOLS_TOOL_NAMES, NATIVE_DEFERRED_MODEL);
    mockPi.rawPi.setActiveTools([...mockPi.rawPi.getActiveTools(), "chrome_devtools_evaluate"]);
    const running = showChromeDevtoolsBrowserSettings(mockPi.pi, ctx, generation);
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /WebMCP · Experimental\s+Off/);
    for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.equal(webMcpEnabled(sessionOwner(ctx)), true);
    assert.deepEqual((readSettings().webmcp as Record<string, unknown>).enabled, true);
    assert.deepEqual(mockPi.rawPi.getActiveTools(), [
      "other_tool",
      CHROME_DEVTOOLS_LOAD_TOOL_NAME,
      "chrome_devtools_evaluate",
    ]);
    assert.ok(WEBMCP_TOOL_NAMES.every((name) => !mockPi.rawPi.getActiveTools().includes(name)));
    assert.match(notifications.at(-1)?.message ?? "", /Experimental WebMCP enabled/i);

    const operation = beginWebMcpOperation(sessionOwner(ctx));
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(webMcpEnabled(sessionOwner(ctx)), false);
    assert.equal(operation.signal.aborted, true);
    assert.deepEqual(mockPi.rawPi.getActiveTools(), [
      "other_tool",
      CHROME_DEVTOOLS_LOAD_TOOL_NAME,
      "chrome_devtools_evaluate",
    ]);
    assert.ok(WEBMCP_TOOL_NAMES.every((name) => !mockPi.rawPi.getActiveTools().includes(name)));
    assert.match(notifications.at(-1)?.message ?? "", /WebMCP disabled/i);
    operation.dispose();

    tui.press("ctrl+c");
    await running;
  });
});

test("a failed WebMCP runtime transition restores the file, gate, and displayed value", async () => {
  await withBrowserSettingsMenu(async ({ ctx, notifications, tui, generation }) => {
    writeFileSync(settingsFilePath(), '{"webmcp":{"enabled":false}}\n');
    const mockPi = createMockPi({ activeTools: ["other_tool", ...CHROME_DEVTOOLS_TOOL_NAMES] });
    initializeAvailableChromeDevtoolsTools(mockPi.pi);
    const setActiveTools = mockPi.rawPi.setActiveTools.bind(mockPi.rawPi);
    let failExposure = false;
    mockPi.rawPi.setActiveTools = (names) => {
      if (failExposure) throw new Error("injected exposure failure");
      setActiveTools(names);
    };
    const running = showChromeDevtoolsBrowserSettings(mockPi.pi, ctx, generation);
    await tui.waitForOpen();
    for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
    failExposure = true;
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.equal(webMcpEnabled(sessionOwner(ctx)), false);
    assert.equal((readSettings().webmcp as Record<string, unknown>).enabled, false);
    assert.match(tui.render().join("\n"), /WebMCP · Experimental\s+Off/);
    assert.match(notifications.at(-1)?.message ?? "", /save failed.*rollback failed/i);
    tui.press("ctrl+c");
    await running;
  });
});

test("browser settings report the effective value when an environment override shadows a save", async () => {
  await withBrowserSettingsMenu(async ({ ctx, notifications, tui, generation }) => {
    process.env.PI_CHROME_DEVTOOLS_AUTO_LAUNCH = "1";
    const running = showChromeDevtoolsBrowserSettings(createMockPi().pi, ctx, generation);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.equal((readSettings().browser as Record<string, unknown>).autoLaunch, false);
    assert.equal(state.autoLaunchEnabled, true);
    assert.equal(state.autoLaunchSource, "environment");
    assert.match(
      notifications.at(-1)?.message ?? "",
      /Effective auto-launch: On \(environment\).*environment override remains effective/i,
    );
    assert.doesNotMatch(notifications.at(-1)?.message ?? "", /auto-launch: Off/);
    tui.press("ctrl+c");
    await running;
  });
});

test("a successful browser setting closes only the extension-owned managed browser", async () => {
  await withBrowserSettingsMenu(async ({ directory, ctx, tui, generation }) => {
    const child = new OwnedBrowserChild();
    const profile = path.join(directory, "managed-profile");
    mkdirSync(profile);
    state.managedBrowser = {
      process: child as unknown as ChildProcess,
      userDataDir: profile,
      exited: false,
      ready: true,
      ownerGeneration: generation,
      sessionOwner: sessionOwner(ctx),
    };
    const running = showChromeDevtoolsBrowserSettings(createMockPi().pi, ctx, generation);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();

    assert.equal(child.killCalls, 1);
    assert.equal(state.managedBrowser, undefined);
    assert.equal(existsSync(profile), false);
    tui.press("ctrl+c");
    await running;
  });
});

test("browser settings edit and reset the executable through the same user JSON", async () => {
  await withBrowserSettingsMenu(async ({ directory, ctx, tui, generation }) => {
    const executable = path.join(directory, "chrome-for-testing");
    writeFileSync(executable, "browser");
    const running = showChromeDevtoolsBrowserSettings(createMockPi().pi, ctx, generation);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.setFocused(true);
    tui.type(executable);
    tui.press("tui.input.submit");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal((readSettings().browser as Record<string, unknown>).executablePath, executable);
    assert.equal(state.browserExecutable, executable);

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.setFocused(true);
    tui.type("automatic");
    tui.press("tui.input.submit");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.deepEqual(readSettings().browser, {});
    assert.equal(state.browserExecutable, undefined);
    tui.press("ctrl+c");
    await running;
  });
});

test("browser settings cancellation and invalid files remain read-only", async () => {
  await withBrowserSettingsMenu(async ({ ctx, tui, generation }) => {
    const cancelled = showChromeDevtoolsBrowserSettings(createMockPi().pi, ctx, generation);
    await tui.waitForOpen();
    tui.press("tui.select.cancel");
    assert.deepEqual(await cancelled, { closeParent: false });
    assert.equal(existsSync(settingsFilePath()), false);

    writeFileSync(settingsFilePath(), "{ invalid\n");
    const invalid = showChromeDevtoolsBrowserSettings(createMockPi().pi, ctx, generation);
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Read only/);
    assert.match(tui.render().join("\n"), /invalid JSON/);
    tui.press("tui.select.cancel");
    await invalid;
    assert.equal(readFileSync(settingsFilePath(), "utf8"), "{ invalid\n");
  });
});

test("an invalid trusted project file warns without blocking user browser settings", async () => {
  await withBrowserSettingsMenu(async ({ directory, tui, generation }) => {
    const projectPath = projectSettingsFilePath(directory);
    mkdirSync(path.dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, "{ invalid project JSON\n");
    const mock = createMockContext({
      cwd: directory,
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      isProjectTrusted: () => true,
    });
    const running = showChromeDevtoolsBrowserSettings(createMockPi().pi, mock.ctx, generation);
    await tui.waitForOpen();
    const rendered = tui.render().join("\n");
    assert.match(rendered, /DevTools endpoint/);
    assert.match(rendered, /invalid JSON/);
    assert.doesNotMatch(rendered, /Read only/);

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.setFocused(true);
    tui.type("http://localhost:9555");
    tui.press("tui.input.submit");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal((readSettings().browser as Record<string, unknown>).endpoint, "http://localhost:9555");
    tui.press("ctrl+c");
    await running;
  });
});

test("a failed browser settings save restores the accepted value and retains the input draft", async () => {
  await withBrowserSettingsMenu(async ({ ctx, notifications, tui, generation }) => {
    const running = showChromeDevtoolsBrowserSettings(createMockPi().pi, ctx, generation);
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    mkdirSync(settingsFilePath());
    tui.setFocused(true);
    tui.type("http://localhost:9333");
    tui.press("tui.input.submit");
    await tui.waitForPending();
    assert.match(tui.render().join("\n"), /http:\/\/localhost:9333/);
    assert.equal(state.host, "127.0.0.1");
    assert.match(notifications.at(-1)?.message ?? "", /save failed.*previous settings remain active/i);
    tui.press("ctrl+c");
    await running;
  });
});

test("the direct settings command dispatches the same RPC workflow", async () => {
  await withBrowserSettingsMenu(async () => {
    const mockPi = createMockPi();
    chromeDevtools(mockPi.pi);
    let selectCalls = 0;
    const mock = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async () => {
        selectCalls += 1;
        return undefined;
      },
    });

    await mockPi.commands.get("chrome-devtools")?.handler("settings", mock.ctx);

    assert.equal(selectCalls, 1);
  });
});

test("RPC browser settings use standard selectors and input without custom TUI", async () => {
  await withBrowserSettingsMenu(async ({ generation }) => {
    let settingsDialogs = 0;
    let customCalls = 0;
    const mock = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async (_title: string, options: string[]) => {
        settingsDialogs += 1;
        if (settingsDialogs === 1) {
          return options.find((option) => option.includes("DevTools endpoint"));
        }
        return undefined;
      },
      input: async () => "http://localhost:9444",
      custom: async () => {
        customCalls += 1;
      },
    });

    await showChromeDevtoolsBrowserSettings(createMockPi().pi, mock.ctx, generation);

    assert.equal(customCalls, 0);
    assert.equal((readSettings().browser as Record<string, unknown>).endpoint, "http://localhost:9444");
    assert.equal(state.port, 9444);
  });
});
