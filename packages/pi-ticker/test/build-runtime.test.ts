import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { type BuildMetadata, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-ticker",
  forbiddenEagerInputs: ["src/menu.ts", "src/tui-menu.ts"],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
  matchExternalSubpaths: false,
});

const forbiddenEagerInputs = ["src/menu.ts", "src/tui-menu.ts"] as const;

function validMetadata(): BuildMetadata {
  const menuOutput = "dist/chunks/menu.js";
  const tuiOutput = "dist/chunks/tui-menu.js";
  return {
    outputs: {
      "dist/index.ts": {
        entryPoint: "src/index.ts",
        imports: [
          {
            path: "@earendil-works/pi-coding-agent",
            kind: "import-statement",
            external: true,
          },
          {
            path: "@narumitw/pi-tui-kit/terminal-text",
            kind: "import-statement",
            external: true,
          },
          { path: menuOutput, kind: "dynamic-import" },
        ],
        inputs: { "src/index.ts": {}, "src/ticker.ts": {} },
      },
      [menuOutput]: {
        entryPoint: "src/menu.ts",
        imports: [
          { path: tuiOutput, kind: "dynamic-import" },
          { path: "@narumitw/pi-tui-kit", kind: "dynamic-import", external: true },
        ],
        inputs: { "src/menu.ts": {} },
      },
      [tuiOutput]: {
        entryPoint: "src/tui-menu.ts",
        imports: [{ path: "@narumitw/pi-tui-kit", kind: "dynamic-import", external: true }],
        inputs: { "src/tui-menu.ts": {} },
      },
    },
  };
}

test("eager graph validation preserves ticker menu boundaries and external packages", async () => {
  const builder = await loadBuilder();
  assert.doesNotThrow(() => builder.validateEagerGraph(validMetadata()));

  for (const forbidden of forbiddenEagerInputs) {
    const metadata = validMetadata();
    const entry = requireOutput(metadata, "dist/index.ts");
    entry.inputs = { ...(entry.inputs ?? {}), [forbidden]: {} };
    assert.throws(
      () => builder.validateEagerGraph(metadata),
      new RegExp(`First-use implementation is eager: ${forbidden.replaceAll("/", "\\/")}`, "u"),
    );
  }

  const eagerDependency = validMetadata();
  const entry = requireOutput(eagerDependency, "dist/index.ts");
  entry.imports = [
    ...(entry.imports ?? []),
    { path: "@narumitw/pi-tui-kit", kind: "import-statement", external: true },
  ];
  assert.throws(() => builder.validateEagerGraph(eagerDependency), /Eager external dependency: @narumitw\/pi-tui-kit/u);

  const bundledDependency = validMetadata();
  requireOutput(bundledDependency, "dist/index.ts").inputs = {
    "node_modules/example/index.js": {},
  };
  assert.throws(() => builder.validateEagerGraph(bundledDependency), /Bundled package input: .*node_modules\/example/u);
});

test("generated runtime loads with Pi Jiti and exercises lifecycle and a lazy menu", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-ticker-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("ticker"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    const rpc = createRpcHarness([{ kind: "select", response: "Close" }]);
    const widgets: Array<{ key: string; content: unknown }> = [];
    const sessionManager = {};
    const ctx = {
      mode: "rpc",
      hasUI: true,
      sessionManager,
      ui: {
        ...rpc.ui,
        notify() {},
        setWidget(key: string, content: unknown) {
          widgets.push({ key, content });
        },
      },
    } as unknown as ExtensionContext;
    await emit(extension.handlers, "session_start", ctx);
    assert.deepEqual(widgets.at(-1), { key: "ticker", content: undefined });

    const command = extension.commands.get("ticker");
    assert.ok(command);
    await command.handler("", ctx as never);
    rpc.assertConsumed();

    await emit(extension.handlers, "session_shutdown", ctx);
    assert.deepEqual(widgets.at(-1), { key: "ticker", content: undefined });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

async function emit(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
  event: string,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}

function requireOutput(metadata: BuildMetadata, path: string) {
  const output = metadata.outputs?.[path];
  assert.ok(output, `missing fixture output: ${path}`);
  return output;
}
