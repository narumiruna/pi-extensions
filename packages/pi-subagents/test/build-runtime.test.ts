import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type BuildMetadata, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-subagents",
  forbiddenEagerInputs: [],
  forbiddenEagerExternals: [],
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

test("Pi's Jiti loader loads the generated extension, child bridge, and readiness probe", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-subagents-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const mainLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await mainLoader.reload();
    const loadedMain = mainLoader.getExtensions();
    assert.deepEqual(loadedMain.errors, []);
    assert.equal(loadedMain.extensions.length, 1);
    const main = loadedMain.extensions[0];
    assert.ok(main?.handlers.has("session_start"));
    assert.ok(main?.handlers.has("session_shutdown"));
    assert.deepEqual([...(main?.messageRenderers.keys() ?? [])], ["pi-subagents-completion"]);
    assert.deepEqual(
      [...(main?.tools.keys() ?? [])],
      ["subagent_spawn", "subagent_inspect", "subagent_cancel", "subagent_wait", "subagent_send"],
    );
    assert.deepEqual(
      Object.keys(
        (
          main?.tools.get("subagent_send")?.definition.parameters as {
            properties?: Record<string, unknown>;
          }
        )?.properties ?? {},
      ),
      ["recipient", "requestId", "message"],
    );

    const childLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [
        join(output, "child-communication-bridge.ts"),
        join(output, "child-readiness-probe.ts"),
      ],
    });
    await childLoader.reload();
    const loadedChild = childLoader.getExtensions();
    assert.deepEqual(loadedChild.errors, []);
    assert.equal(loadedChild.extensions.length, 2);
    assert.deepEqual([...(loadedChild.extensions[0]?.tools.keys() ?? [])], []);
    assert.deepEqual([...(loadedChild.extensions[1]?.handlers.keys() ?? [])], []);
    assert.deepEqual(await loadCredentialBackedChild(output, agentDir, root), {
      errors: 0,
      tools: ["subagent_send", "subagent_wait"],
      sendParameters: ["requestId", "message"],
      readinessHandlers: ["resources_discover", "session_shutdown"],
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

async function loadCredentialBackedChild(
  output: string,
  agentDir: string,
  cwd: string,
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
    env: {
      ...process.env,
      PI_SUBAGENT_BROKER_FD: "3",
      PI_SUBAGENT_READINESS_FD: "4",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const credentials = child.stdio[3];
  assert.ok(credentials && "end" in credentials);
  credentials.end(
    JSON.stringify({
      communication: { host: "127.0.0.1", port: 31_337, token: "a".repeat(64) },
      expectedTools: ["subagent_send", "subagent_wait"],
    }),
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as {
    errors: number;
    tools: string[];
    sendParameters: string[];
    readinessHandlers: string[];
  };
}

function requireOutput(metadata: BuildMetadata, path: string) {
  const output = metadata.outputs?.[path];
  assert.ok(output, `missing fixture output: ${path}`);
  return output;
}
