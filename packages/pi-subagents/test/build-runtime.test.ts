import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterAll, describe, test } from "vitest";
import { type BuildMetadata, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";
import { createLoaderQueue } from "./loader-queue.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-subagents",
  forbiddenEagerInputs: ["src/menu.ts", "src/settings-ui.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  allowedEagerExternals: [
    "@narumitw/pi-tui-kit/editor-status-widget",
    "@narumitw/pi-tui-kit/editor-status-publisher",
    "@narumitw/pi-tui-kit/editor-status-view",
    "@narumitw/pi-tui-kit/editor-status-collection",
  ],
  entries: {
    index: "src/index.ts",
    "child-communication-bridge": "src/child-communication-bridge.ts",
    "child-readiness-probe": "src/child-readiness-probe.ts",
  },
});

const childBridgeSource = "src/child-communication-bridge.ts";
const childReadinessSource = "src/child-readiness-probe.ts";

function validMetadata(): BuildMetadata {
  return {
    outputs: {
      "dist/index.js": {
        entryPoint: "src/index.ts",
        imports: [
          { path: "dist/chunks/shared.js", kind: "import-statement" },
          {
            path: "@earendil-works/pi-coding-agent",
            kind: "import-statement",
            external: true,
          },
        ],
        inputs: { "src/index.ts": {}, "src/subagents.ts": {} },
      },
      "dist/child-communication-bridge.js": {
        entryPoint: childBridgeSource,
        imports: [{ path: "dist/chunks/shared.js", kind: "import-statement" }],
        inputs: { [childBridgeSource]: {} },
      },
      "dist/child-readiness-probe.js": {
        entryPoint: childReadinessSource,
        imports: [{ path: "dist/chunks/shared.js", kind: "import-statement" }],
        inputs: { [childReadinessSource]: {} },
      },
      "dist/chunks/shared.js": {
        imports: [],
        inputs: { "src/broker-credentials.ts": {} },
      },
    },
  };
}

test("eager graph validation keeps child-only entries separate and packages external", async () => {
  const builder = await loadBuilder();
  assert.doesNotThrow(() => builder.validateEagerGraph(validMetadata()));

  const eagerBridge = validMetadata();
  requireOutput(eagerBridge, "dist/index.js").inputs = {
    "src/index.ts": {},
    [childBridgeSource]: {},
  };
  assert.throws(
    () => builder.validateEagerGraph(eagerBridge),
    /Child-process entry is eager: src\/child-communication-bridge\.ts/u,
  );

  const eagerReadiness = validMetadata();
  requireOutput(eagerReadiness, "dist/index.js").inputs = {
    "src/index.ts": {},
    [childReadinessSource]: {},
  };
  assert.throws(
    () => builder.validateEagerGraph(eagerReadiness),
    /Child-process entry is eager: src\/child-readiness-probe\.ts/u,
  );

  const bundledDependency = validMetadata();
  requireOutput(bundledDependency, "dist/index.js").inputs = {
    "node_modules/example/index.js": {},
  };
  assert.throws(() => builder.validateEagerGraph(bundledDependency), /Bundled package input: .*node_modules\/example/u);

  const foreignSource = validMetadata();
  requireOutput(foreignSource, "dist/index.js").inputs = { "../other-package/src/index.ts": {} };
  assert.throws(() => builder.validateEagerGraph(foreignSource), /Bundled non-package source/u);

  const reachableBridge = validMetadata();
  requireOutput(reachableBridge, "dist/child-communication-bridge.js").inputs = {};
  requireOutput(reachableBridge, "dist/index.js").imports?.push({
    path: "dist/child-communication-bridge.js",
    kind: "import-statement",
  });
  assert.throws(() => builder.validateEagerGraph(reachableBridge), /Child-process entry is reachable/u);

  const missingBridge = validMetadata();
  delete missingBridge.outputs?.["dist/child-communication-bridge.js"];
  assert.throws(() => builder.validateEagerGraph(missingBridge), /no src\/child-communication-bridge.ts entrypoint/u);

  const missingReadiness = validMetadata();
  delete missingReadiness.outputs?.["dist/child-readiness-probe.js"];
  assert.throws(() => builder.validateEagerGraph(missingReadiness), /no src\/child-readiness-probe.ts entrypoint/u);
});

test("generated main entry references the generated child entries", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-subagents-build-test-"));
  try {
    const output = join(root, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    const mainPath = join(output, "index.ts");
    const mainSource = await readFile(mainPath, "utf8");
    assert.match(mainSource, /"\.\/child-communication-bridge\.ts"/u);
    assert.match(mainSource, /"\.\/child-readiness-probe\.ts"/u);
    await writeFile(mainPath, mainSource.replaceAll('"./child-readiness-probe.ts"', '"./wrong-probe.ts"'));
    await assert.rejects(
      builder.validateGeneratedFiles(output),
      /does not reference the generated child readiness probe/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

// Memoize prerequisites inside each selectable test, never in a longer setup hook.
describe("generated Jiti entrypoints", { concurrent: false, shuffle: false }, () => {
  let root: string;
  let agentDir: string;
  let output: string;
  let fixtureReady: Promise<void> | undefined;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const loaders = createLoaderQueue();
  const children: Promise<unknown>[] = [];

  function ensureFixture(): Promise<void> {
    fixtureReady ??= (async () => {
      const builder = await loadBuilder();
      root = await mkdtemp(join(packageRoot, ".pi-subagents-build-test-"));
      agentDir = join(root, "agent");
      output = join(root, "dist");
      await builder.buildRuntime({ outputDirectory: output });
      await mkdir(agentDir, { recursive: true });
      process.env.PI_CODING_AGENT_DIR = agentDir;
    })();
    return fixtureReady;
  }

  test("builds the shared Jiti fixture within the test budget", ensureFixture);

  afterAll(async () => {
    // Drain builds, reloads, and child close before deleting paths or restoring the environment.
    await fixtureReady?.catch(() => {});
    await loaders.drain();
    await Promise.allSettled(children);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (root) await rm(root, { force: true, recursive: true });
  });

  test("Pi's Jiti loader preserves the main extension registrations", async ({ signal }) => {
    await ensureFixture();
    await loaders.run(
      () =>
        new DefaultResourceLoader({
          cwd: root,
          agentDir,
          settingsManager: SettingsManager.inMemory({}),
          additionalExtensionPaths: [join(output, "index.ts")],
        }),
      signal,
      (loader) => {
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        const main = loaded.extensions[0];
        assert.ok(main?.handlers.has("session_start"));
        assert.ok(main?.handlers.has("session_shutdown"));
        assert.deepEqual(
          [...(main?.messageRenderers.keys() ?? [])],
          ["pi-subagents-completion", "pi-subagents-message"],
        );
        assert.deepEqual(
          [...(main?.tools.keys() ?? [])],
          ["subagent_spawn", "subagent_inspect", "subagent_cancel", "subagent_wait", "subagent_send"],
        );
        assert.deepEqual(
          Object.keys(
            (main?.tools.get("subagent_send")?.definition.parameters as { properties?: Record<string, unknown> })
              ?.properties ?? {},
          ),
          ["recipient", "requestId", "message"],
        );
      },
    );
  });

  test("generated commands cross both lazy UI boundaries and preserve lifecycle cleanup", async ({ signal }) => {
    await ensureFixture();
    initTheme("dark");
    await loaders.run(
      () =>
        new DefaultResourceLoader({
          cwd: root,
          agentDir,
          settingsManager: SettingsManager.inMemory({}),
          additionalExtensionPaths: [join(output, "index.ts")],
        }),
      signal,
      async (loader) => {
        const main = loader.getExtensions().extensions[0];
        assert.ok(main);
        const tui = createTuiHarness({ width: 80 });
        const context = createMockContext({ mode: "tui", custom: tui.custom });
        const command = main.commands.get("subagents");
        assert.ok(command);
        try {
          for (const handler of main.handlers.get("session_start") ?? []) await handler({}, context.ctx);
          for (const route of ["", "settings"]) {
            signal.throwIfAborted();
            const running = command.handler(route, context.ctx);
            try {
              await tui.waitForOpen();
              assert.match(tui.render().join("\n"), route === "" ? /Jobs/u : /Show widget/u);
            } finally {
              tui.press("ctrl+c");
              await running;
            }
          }
          assert.deepEqual(context.notifications, []);
          await assert.rejects(() => readFile(join(agentDir, "pi-subagents.json")), { code: "ENOENT" });
        } finally {
          for (const handler of main.handlers.get("session_shutdown") ?? []) await handler({}, context.ctx);
        }
      },
    );
  });

  test("child Jiti entrypoints stay inactive without broker credentials", async ({ signal }) => {
    await ensureFixture();
    await loaders.run(
      () =>
        new DefaultResourceLoader({
          cwd: root,
          agentDir,
          settingsManager: SettingsManager.inMemory({}),
          additionalExtensionPaths: [
            join(output, "child-communication-bridge.ts"),
            join(output, "child-readiness-probe.ts"),
          ],
        }),
      signal,
      (loader) => {
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 2);
        assert.deepEqual([...(loaded.extensions[0]?.tools.keys() ?? [])], []);
        assert.deepEqual([...(loaded.extensions[1]?.handlers.keys() ?? [])], []);
      },
    );
  });

  test("fresh credential-backed child loads the bridge and readiness entrypoints", async ({ signal }) => {
    await ensureFixture();
    signal.throwIfAborted();
    const childReady = loadCredentialBackedChild(output, agentDir, root, signal);
    children.push(childReady);
    const result = await childReady;
    signal.throwIfAborted();
    assert.deepEqual(result, {
      errors: 0,
      tools: ["subagent_send", "subagent_wait"],
      sendParameters: ["requestId", "message"],
      readinessHandlers: ["resources_discover", "session_shutdown"],
    });
  });

  test("cancellation releases a credential-backed child before reading its result", async ({ signal }) => {
    await ensureFixture();
    signal.throwIfAborted();
    const controller = new AbortController();
    const childReady = loadCredentialBackedChild(output, agentDir, root, AbortSignal.any([controller.signal, signal]));
    children.push(childReady);
    controller.abort();
    await assert.rejects(childReady, { name: "AbortError" });
  });
});

async function loadCredentialBackedChild(
  output: string,
  agentDir: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ errors: number; tools: string[]; sendParameters: string[]; readinessHandlers: string[] }> {
  const source = `
import fs from "node:fs";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
const [output, agentDir, cwd] = process.argv.slice(1);
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: SettingsManager.inMemory({}),
  additionalExtensionPaths: [
    output + "/child-communication-bridge.ts",
    output + "/child-readiness-probe.ts",
  ],
});
await loader.reload();
const loaded = loader.getExtensions();
const send = loaded.extensions[0]?.tools.get("subagent_send");
process.stdout.write(JSON.stringify({
  errors: loaded.errors.length,
  tools: [...(loaded.extensions[0]?.tools.keys() ?? [])],
  sendParameters: Object.keys(send?.definition.parameters.properties ?? {}),
  readinessHandlers: [...(loaded.extensions[1]?.handlers.keys() ?? [])],
}));
fs.closeSync(4);
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, output, agentDir, cwd], {
    cwd: resolve("."),
    signal,
    env: {
      ...process.env,
      PI_SUBAGENT_BROKER_FD: "3",
      PI_SUBAGENT_READINESS_FD: "4",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const credentials = child.stdio[3];
    assert.ok(credentials && "end" in credentials);
    let credentialError: Error | undefined;
    credentials.once("error", (error) => {
      credentialError = error;
    });
    credentials.end(
      JSON.stringify({
        communication: { host: "127.0.0.1", port: 31_337, token: "a".repeat(64) },
        expectedTools: ["subagent_send", "subagent_wait"],
        selection: { provider: "test", model: "model", thinkingLevel: "off" },
      }),
    );
    const code = await closed;
    if (spawnError) throw spawnError;
    if (credentialError) throw credentialError;
    assert.equal(code, 0, stderr);
    assert.ok(stdout, "credential-backed child exited without a result");
    return JSON.parse(stdout) as {
      errors: number;
      tools: string[];
      sendParameters: string[];
      readinessHandlers: string[];
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

function requireOutput(metadata: BuildMetadata, path: string) {
  const output = metadata.outputs?.[path];
  assert.ok(output, `missing fixture output: ${path}`);
  return output;
}
