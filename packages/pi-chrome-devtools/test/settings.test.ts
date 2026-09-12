import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  loadSettings,
  projectSettingsFilePath,
  saveBrowserSettings,
  saveSettings,
  saveWebMcpSettings,
  settingsFilePath,
} from "../src/settings.js";

const LIST_PAGES_TOOL = "chrome_devtools_list_pages";

async function withSettingsFixture(
  fn: (fixture: {
    agentDir: string;
    cwd: string;
    extensionA: string;
    extensionB: string;
    executable: string;
  }) => Promise<void>,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-browser-settings-"));
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
  const cwd = path.join(root, "project");
  const extensionA = path.join(root, "extension-a");
  const extensionB = path.join(root, "extension-b");
  const executable = path.join(root, "chrome-for-testing");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  createExtension(extensionA, "extension-a");
  createExtension(extensionB, "extension-b");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const name of environmentNames) delete process.env[name];
  try {
    await fn({ agentDir, cwd, extensionA, extensionB, executable });
  } finally {
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

function createExtension(directory: string, name: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ manifest_version: 3, name, version: "1.0.0" }));
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("browser-only user settings load without creating or requiring tool settings", async () => {
  await withSettingsFixture(async ({ cwd, extensionA, executable }) => {
    writeJson(settingsFilePath(), {
      browser: {
        endpoint: "http://localhost:9333",
        autoLaunch: false,
        executablePath: executable,
        extensionPaths: [extensionA],
      },
      future: { kept: true },
    });

    const loaded = await loadSettings({ cwd, projectTrusted: false });

    assert.equal(loaded.kind, "loaded");
    assert.equal(loaded.settings?.tools, undefined);
    assert.equal(loaded.effectiveBrowser.endpoint, "http://localhost:9333");
    assert.equal(loaded.effectiveBrowser.host, "localhost");
    assert.equal(loaded.effectiveBrowser.port, 9333);
    assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, false);
    assert.equal(loaded.effectiveBrowser.endpointSource, "user");
    assert.equal(loaded.effectiveBrowser.autoLaunchSource, "user");
    assert.equal(loaded.effectiveBrowser.executablePath, executable);
    assert.deepEqual(loaded.effectiveBrowser.extensionPaths, [extensionA]);
    assert.equal(loaded.effectiveBrowser.executablePathSource, "user");
    assert.equal(loaded.effectiveBrowser.extensionPathsSource, "user");
    assert.deepEqual(loaded.warnings, []);
  });
});

test("missing user and project settings are side-effect free defaults", async () => {
  await withSettingsFixture(async ({ agentDir, cwd }) => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(path.join(cwd, ".pi"), { recursive: true, force: true });

    const loaded = await loadSettings({ cwd, projectTrusted: true });

    assert.equal(loaded.kind, "missing");
    assert.equal(loaded.effectiveBrowser.endpoint, "http://127.0.0.1:9222");
    assert.equal(loaded.effectiveWebMcpEnabled, false);
    assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, true);
    assert.equal(loaded.effectiveBrowser.endpointSource, "default");
    assert.deepEqual(loaded.effectiveBrowser.extensionPaths, []);
    assert.equal(existsSync(settingsFilePath()), false);
    assert.equal(existsSync(projectSettingsFilePath(cwd)), false);
  });
});

test("an explicit empty tool selection remains a loaded global setting", async () => {
  await withSettingsFixture(async ({ cwd }) => {
    writeJson(settingsFilePath(), { tools: [], updatedAt: 1 });

    const loaded = await loadSettings({ cwd, projectTrusted: false });

    assert.equal(loaded.kind, "loaded");
    assert.deepEqual(loaded.settings?.tools, []);
  });
});

test("WebMCP is user-only, default-off, validated, and project settings cannot enable it", async () => {
  await withSettingsFixture(async ({ cwd }) => {
    writeJson(projectSettingsFilePath(cwd), { webmcp: { enabled: true } });
    let loaded = await loadSettings({ cwd, projectTrusted: true });
    assert.equal(loaded.effectiveWebMcpEnabled, false);
    assert.match(loaded.warnings.join("\n"), /project webmcp settings ignored/i);

    writeJson(settingsFilePath(), { webmcp: { enabled: true } });
    loaded = await loadSettings({ cwd, projectTrusted: true });
    assert.equal(loaded.kind, "loaded");
    assert.equal(loaded.effectiveWebMcpEnabled, true);
    assert.equal(loaded.settings?.webmcp.enabled, true);

    writeJson(settingsFilePath(), { webmcp: { enabled: "yes" } });
    loaded = await loadSettings({ cwd, projectTrusted: false });
    assert.equal(loaded.kind, "invalid");
    assert.match(loaded.warnings.join("\n"), /webmcp\.enabled.*boolean/i);
  });
});

test("WebMCP saves preserve unknown fields and block malformed-file replacement", async () => {
  await withSettingsFixture(async () => {
    writeJson(settingsFilePath(), {
      future: { kept: true },
      webmcp: { enabled: false, futureWebMcpField: { kept: true } },
    });
    await saveWebMcpSettings(true);
    const saved = JSON.parse(readFileSync(settingsFilePath(), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.future, { kept: true });
    assert.deepEqual(saved.webmcp, {
      enabled: true,
      futureWebMcpField: { kept: true },
    });

    writeFileSync(settingsFilePath(), "{ malformed\n");
    await assert.rejects(saveWebMcpSettings(false), /Cannot save.*invalid JSON/u);
    assert.equal(readFileSync(settingsFilePath(), "utf8"), "{ malformed\n");
  });
});

test("browser endpoints retain explicitly configured default HTTP ports", async () => {
  await withSettingsFixture(async ({ cwd }) => {
    writeJson(settingsFilePath(), { browser: { endpoint: "http://localhost:80" } });

    const loaded = await loadSettings({ cwd, projectTrusted: false });

    assert.equal(loaded.kind, "loaded");
    assert.equal(loaded.effectiveBrowser.endpoint, "http://localhost:80");
    assert.equal(loaded.effectiveBrowser.port, 80);
  });
});

test("user browser endpoint and auto-launch values are validated", async () => {
  await withSettingsFixture(async ({ cwd }) => {
    for (const browser of [
      { endpoint: "https://127.0.0.1:9222" },
      { endpoint: "http://127.0.0.1" },
      { endpoint: "http://127.0.0.1:9222/json/list" },
      { autoLaunch: "no" },
    ]) {
      writeJson(settingsFilePath(), { browser });
      const loaded = await loadSettings({ cwd, projectTrusted: false });
      assert.equal(loaded.kind, "invalid");
      assert.match(loaded.warnings.join("\n"), /browser\.(?:endpoint|autoLaunch)/i);
    }
  });
});

test("user browser paths must be absolute and point to valid unpacked manifests", async () => {
  await withSettingsFixture(async ({ cwd, executable }) => {
    writeJson(settingsFilePath(), {
      browser: { executablePath: executable, extensionPaths: ["relative-extension"] },
    });
    const relative = await loadSettings({ cwd, projectTrusted: false });
    assert.equal(relative.kind, "invalid");
    assert.match(relative.warnings.join("\n"), /absolute/i);

    const missingManifest = path.join(path.dirname(executable), "missing-manifest");
    mkdirSync(missingManifest);
    writeJson(settingsFilePath(), {
      browser: { executablePath: executable, extensionPaths: [missingManifest] },
    });
    const invalidManifest = await loadSettings({ cwd, projectTrusted: false });
    assert.equal(invalidManifest.kind, "invalid");
    assert.match(invalidManifest.warnings.join("\n"), /manifest\.json/i);

    const commaPath = path.join(path.dirname(executable), "extension,with-comma");
    createExtension(commaPath, "comma");
    writeJson(settingsFilePath(), {
      browser: { executablePath: executable, extensionPaths: [commaPath] },
    });
    const invalidComma = await loadSettings({ cwd, projectTrusted: false });
    assert.equal(invalidComma.kind, "invalid");
    assert.match(invalidComma.warnings.join("\n"), /cannot contain a comma/i);
  });
});

test("trusted project extension paths resolve from cwd and replace the user array", async () => {
  await withSettingsFixture(async ({ cwd, extensionA, extensionB, executable }) => {
    writeJson(settingsFilePath(), {
      browser: { executablePath: executable, extensionPaths: [extensionA] },
    });
    const relativeExtension = path.relative(cwd, extensionB);
    writeJson(projectSettingsFilePath(cwd), {
      browser: { extensionPaths: [relativeExtension] },
    });

    const loaded = await loadSettings({ cwd, projectTrusted: true });

    assert.equal(loaded.kind, "loaded");
    assert.deepEqual(loaded.effectiveBrowser.extensionPaths, [extensionB]);
    assert.equal(loaded.effectiveBrowser.extensionPathsSource, "project");
    assert.equal(loaded.effectiveBrowser.executablePath, executable);
    assert.equal(loaded.effectiveBrowser.executablePathSource, "user");
  });
});

test("untrusted projects are not read or allowed to override browser settings", async () => {
  await withSettingsFixture(async ({ cwd, extensionA, executable }) => {
    writeJson(settingsFilePath(), {
      browser: { executablePath: executable, extensionPaths: [extensionA] },
    });
    writeFileSync(projectSettingsFilePath(cwd), "{ this project file is intentionally invalid");

    const loaded = await loadSettings({ cwd, projectTrusted: false });

    assert.equal(loaded.kind, "loaded");
    assert.deepEqual(loaded.effectiveBrowser.extensionPaths, [extensionA]);
    assert.deepEqual(loaded.warnings, []);
  });
});

test("project machine-owned browser settings are ignored with user-file guidance", async () => {
  await withSettingsFixture(async ({ cwd, executable }) => {
    writeJson(settingsFilePath(), {
      browser: {
        endpoint: "http://127.0.0.1:9333",
        autoLaunch: false,
        executablePath: executable,
      },
    });
    writeJson(projectSettingsFilePath(cwd), {
      browser: {
        endpoint: "http://remote.example:9444",
        autoLaunch: true,
        executablePath: "/project/cannot/override",
      },
    });

    const loaded = await loadSettings({ cwd, projectTrusted: true });

    assert.equal(loaded.effectiveBrowser.endpoint, "http://127.0.0.1:9333");
    assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, false);
    assert.equal(loaded.effectiveBrowser.executablePath, executable);
    assert.match(loaded.warnings.join("\n"), /project browser\.endpoint ignored/i);
    assert.match(loaded.warnings.join("\n"), /project browser\.autoLaunch ignored/i);
    assert.match(loaded.warnings.join("\n"), /project browser\.executablePath ignored/i);
  });
});

test("project executablePath is ignored while invalid project extension settings are warned", async () => {
  await withSettingsFixture(async ({ cwd, extensionA, executable }) => {
    writeJson(settingsFilePath(), {
      browser: { executablePath: executable, extensionPaths: [extensionA] },
    });
    writeJson(projectSettingsFilePath(cwd), {
      browser: { executablePath: "/project/cannot/override", extensionPaths: [42] },
    });

    const loaded = await loadSettings({ cwd, projectTrusted: true });

    assert.equal(loaded.effectiveBrowser.executablePath, executable);
    assert.deepEqual(loaded.effectiveBrowser.extensionPaths, [extensionA]);
    assert.match(loaded.warnings.join("\n"), /project.*extensionPaths/i);
    assert.match(loaded.warnings.join("\n"), /executablePath.*ignored/i);
  });
});

test("deprecated environment settings remain explicit overrides and emit one migration warning", async () => {
  await withSettingsFixture(async ({ cwd, executable }) => {
    writeJson(settingsFilePath(), {
      browser: {
        endpoint: "http://json.example:9333",
        autoLaunch: false,
        executablePath: executable,
      },
    });
    process.env.PI_CHROME_DEVTOOLS_HOST = "127.0.0.1";
    process.env.PI_CHROME_DEVTOOLS_PORT = "9444";
    process.env.PI_CHROME_DEVTOOLS_AUTO_LAUNCH = "1";
    process.env.PI_CHROME_DEVTOOLS_BROWSER = "chromium-from-environment";

    const loaded = await loadSettings({ cwd, projectTrusted: false });

    assert.equal(loaded.effectiveBrowser.endpoint, "http://127.0.0.1:9444");
    assert.equal(loaded.effectiveBrowser.autoLaunchEnabled, true);
    assert.equal(loaded.effectiveBrowser.executablePath, "chromium-from-environment");
    assert.equal(loaded.effectiveBrowser.endpointSource, "environment");
    assert.equal(loaded.effectiveBrowser.autoLaunchSource, "environment");
    assert.equal(loaded.effectiveBrowser.executablePathSource, "environment");
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? "", /deprecated.*future version/i);
    for (const name of [
      "PI_CHROME_DEVTOOLS_HOST",
      "PI_CHROME_DEVTOOLS_PORT",
      "PI_CHROME_DEVTOOLS_AUTO_LAUNCH",
      "PI_CHROME_DEVTOOLS_BROWSER",
    ]) {
      assert.match(loaded.warnings[0] ?? "", new RegExp(name));
    }
    assert.match(loaded.warnings[0] ?? "", /browser\.endpoint.*browser\.autoLaunch/i);
  });
});

test("browser saves preserve unknown top-level and browser fields", async () => {
  await withSettingsFixture(async ({ extensionA, executable }) => {
    writeJson(settingsFilePath(), {
      browser: {
        executablePath: executable,
        extensionPaths: [extensionA],
        futureBrowserField: { kept: true },
      },
      future: { kept: true },
    });

    await saveBrowserSettings({
      endpoint: "http://localhost:9333",
      autoLaunch: false,
    });

    const saved = JSON.parse(readFileSync(settingsFilePath(), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.browser, {
      executablePath: executable,
      extensionPaths: [extensionA],
      futureBrowserField: { kept: true },
      endpoint: "http://localhost:9333",
      autoLaunch: false,
    });
    assert.deepEqual(saved.future, { kept: true });
  });
});

test("global tool saves preserve valid browser and unknown sibling fields", async () => {
  await withSettingsFixture(async ({ extensionA, executable }) => {
    writeJson(settingsFilePath(), {
      browser: { executablePath: executable, extensionPaths: [extensionA] },
      future: { kept: true },
    });

    await saveSettings({ tools: [LIST_PAGES_TOOL], updatedAt: 2 });

    const saved = JSON.parse(readFileSync(settingsFilePath(), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.browser, {
      executablePath: executable,
      extensionPaths: [extensionA],
    });
    assert.deepEqual(saved.future, { kept: true });
    assert.deepEqual(saved.tools, [LIST_PAGES_TOOL]);
  });
});

test("WebMCP saves publish in invocation order and recover after a failed save", async () => {
  await withSettingsFixture(async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = saveWebMcpSettings(true, {
      write: async (temporaryPath, data) => {
        writeFileSync(temporaryPath, data);
        firstStarted?.();
        await firstBlocked;
      },
    });
    await started;
    const second = saveWebMcpSettings(false);
    releaseFirst?.();
    await Promise.all([first, second]);
    assert.equal(
      (JSON.parse(readFileSync(settingsFilePath(), "utf8")) as { webmcp?: { enabled?: unknown } }).webmcp?.enabled,
      false,
    );

    await assert.rejects(
      saveWebMcpSettings(true, { write: async () => Promise.reject(new Error("write failed")) }),
      /write failed/u,
    );
    await saveWebMcpSettings(true);
    assert.equal(
      (JSON.parse(readFileSync(settingsFilePath(), "utf8")) as { webmcp?: { enabled?: unknown } }).webmcp?.enabled,
      true,
    );
  });
});

test("pending global saves finish before a dependent settings read", async () => {
  await withSettingsFixture(async ({ cwd }) => {
    let releaseWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let unblockWrite: (() => void) | undefined;
    const writeBlock = new Promise<void>((resolve) => {
      unblockWrite = resolve;
    });
    const save = saveSettings(
      { tools: [LIST_PAGES_TOOL], updatedAt: 3 },
      {
        write: async (temporaryPath, data) => {
          writeFileSync(temporaryPath, data);
          releaseWrite?.();
          await writeBlock;
        },
      },
    );
    await writeStarted;
    let readSettled = false;
    const read = loadSettings({ cwd, projectTrusted: false }).then((value) => {
      readSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(readSettled, false);
    unblockWrite?.();
    await save;

    const loaded = await read;
    assert.deepEqual(loaded.settings?.tools, [LIST_PAGES_TOOL]);
  });
});
