import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, test } from "vitest";
import {
  type BuildMetadata,
  listFiles,
  registerRuntimeBuilderContract,
} from "../../../test/runtime-builder-contract.js";
import { createMockContext } from "../../../test/support.js";
import { v3WebDavSettings } from "./helpers.js";
import { deferred } from "./startup-check-helpers.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-sync",
  forbiddenEagerInputs: [
    "src/commands/command-handler.ts",
    "src/commands/command-execution.ts",
    "src/snapshot/snapshot.ts",
    "src/snapshot/snapshot-codec.ts",
    "src/snapshot/snapshot-transaction.ts",
    "src/sync/sync-local.ts",
    "src/sync/local-fields.ts",
    "src/sync/json-document.ts",
    "src/sync/agent-sync.ts",
    "src/sync/continuous-sync.ts",
    "src/sync/continuous-record.ts",
    "src/sync/continuous-lease.ts",
    "src/sync/continuous-watch.ts",
    "src/sync/agent-runner.ts",
    "src/sync/agent-plan.ts",
    "src/sync/agent-candidate.ts",
    "src/sync/agent-store.ts",
    "src/sync/setup-switch.ts",
    "src/sync/sync-operations.ts",
    "src/sync/sync-queries.ts",
    "src/sync/sync-inspection.ts",
    "src/sync/sync-mutations.ts",
    "src/ui/manager-ui.ts",
    "src/ui/setup/setup-wizard.ts",
    "src/ui/setup/setup-switcher.ts",
    "src/ui/setup/setup-actions.ts",
    "src/ui/setup/s3-ui.ts",
    "src/ui/setup/setup-location-ui.ts",
    "src/ui/manager-result-dispatcher.ts",
    "src/ui/file-selection.ts",
    "src/ui/remote-selection-ui.ts",
    "src/backends/s3/s3-backend.ts",
    "src/backends/webdav/webdav-backend.ts",
    "src/backends/git/git-backend.ts",
  ],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit", "fast-xml-parser"],
  includeDynamicExternals: true,
});

test("generated runtime preserves every first-use import boundary", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-sync-build-test-"));
  try {
    const metadata = await builder.buildRuntime({ outputDirectory: join(root, "dist") });
    const { eagerInputs } = builder.validateEagerGraph(metadata);
    assertSourceBoundaries(metadata);
    for (const lazyInput of [
      "src/commands/command-handler.ts",
      "src/commands/command-execution.ts",
      "src/snapshot/snapshot.ts",
      "src/snapshot/snapshot-codec.ts",
      "src/snapshot/snapshot-transaction.ts",
      "src/sync/sync-local.ts",
      "src/sync/local-fields.ts",
      "src/sync/json-document.ts",
      "src/sync/agent-sync.ts",
      "src/sync/setup-switch.ts",
      "src/sync/sync-operations.ts",
      "src/sync/sync-queries.ts",
      "src/sync/sync-inspection.ts",
      "src/sync/sync-mutations.ts",
      "src/ui/manager-ui.ts",
      "src/ui/setup/setup-wizard.ts",
      "src/ui/setup/setup-switcher.ts",
      "src/ui/setup/setup-actions.ts",
      "src/ui/setup/s3-ui.ts",
      "src/ui/setup/setup-location-ui.ts",
      "src/ui/manager-result-dispatcher.ts",
      "src/ui/file-selection.ts",
      "src/ui/remote-selection-ui.ts",
      "src/backends/s3/s3-backend.ts",
      "src/backends/webdav/webdav-backend.ts",
      "src/backends/git/git-backend.ts",
    ]) {
      assert.equal(
        [...eagerInputs].some((input) => input.endsWith(`/${lazyInput}`)),
        false,
        `${lazyInput} became eager`,
      );
    }
    const protectedInput = "src/sync/sync-mutations.ts";
    const missing = structuredClone(metadata);
    for (const output of Object.values(missing.outputs ?? {})) {
      if (output.inputs) delete output.inputs[protectedInput];
    }
    assert.throws(() => builder.validateEagerGraph(missing), /missing from build inputs/u);

    const eager = structuredClone(metadata);
    const entry = Object.values(eager.outputs ?? {}).find((output) => output.entryPoint === "src/index.ts");
    assert.ok(entry?.inputs);
    entry.inputs[protectedInput] = { bytesInOutput: 1 };
    assert.throws(() => builder.validateEagerGraph(eager), /First-use implementation is eager/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime is mapped, external, self-contained, and loadable by Pi", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-sync-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const metadata = await builder.buildRuntime({ outputDirectory: output });
    const files = await listFiles(output);
    assert.ok(files.includes("index.ts"));
    assert.ok(files.includes("index.ts.map"));
    assert.ok(files.some((path) => path.startsWith("chunks/") && path.endsWith(".ts")));
    for (const runtimePath of files.filter((path) => path.endsWith(".ts"))) {
      const source = await readFile(join(output, runtimePath), "utf8");
      assert.match(source, /^\/\/ @generated by scripts\/build-runtime\.mjs/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']+\.js["']/u);
      assert.doesNotMatch(source, /["']\.\.?\/[^"']*src\//u);
      assert.ok(files.includes(`${runtimePath}.map`), `missing map for ${runtimePath}`);
    }
    assert.match(await readFile(join(output, "index.ts"), "utf8"), /["']\.\/chunks\/[^"']+\.ts["']/u);
    for (const generated of Object.values(metadata.outputs ?? {})) {
      for (const input of Object.keys(generated.inputs ?? {})) {
        assert.equal(input.includes("node_modules/"), false, `bundled package input: ${input}`);
      }
    }

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
    assert.ok(extension);
    const command = extension.commands.get("sync");
    assert.ok(command);
    const titles: string[] = [];
    const { ctx, statuses, notifications } = createMockContext({
      hasUI: true,
      mode: "tui",
      input: async (title: string) =>
        title.startsWith("Sync setup name") ? "default" : "https://account.r2.cloudflarestorage.com",
      select: async (title: string) => {
        titles.push(title);
        return title.startsWith("Set up sync") ? "Cloudflare R2" : "Cancel";
      },
    });
    try {
      const starts = extension.handlers.get("session_start");
      const shutdowns = extension.handlers.get("session_shutdown");
      assert.equal(starts?.length, 1);
      assert.equal(shutdowns?.length, 1);
      statuses.set("unrelated", "keep");
      const transaction = join(agentDir, "pi-sync/transactions/interrupted");
      const target = join(agentDir, "AGENTS.md");
      await mkdir(join(transaction, "before"), { recursive: true });
      await writeFile(join(transaction, "before/0"), "original instructions");
      await writeFile(target, "interrupted instructions");
      await writeFile(
        join(transaction, "journal.json"),
        JSON.stringify({
          version: 2,
          root: agentDir,
          entries: [
            {
              target,
              backupName: "0",
              kind: "file",
              beforeImage: `file:${createHash("sha256").update("original instructions").digest("hex")}`,
              afterImage: `file:${createHash("sha256").update("interrupted instructions").digest("hex")}`,
              postFiles: [],
            },
          ],
        }),
      );
      for (const reason of ["startup", "new"]) {
        statuses.set("sync", "stale");
        for (const handler of starts ?? []) await handler({ type: "session_start", reason }, ctx);
        assert.equal(statuses.get("sync"), undefined);
      }
      assert.equal(await readFile(target, "utf8"), "original instructions");
      await assert.rejects(readFile(join(transaction, "journal.json")), { code: "ENOENT" });
      await command.handler("init", ctx);
      assert.ok(
        titles.some(
          (title) =>
            title.startsWith("Choose storage location") && title.includes("./ stores snapshots at the bucket root"),
        ),
        titles.join("\n"),
      );
      await assert.rejects(
        readFile(join(agentDir, "pi-sync.json")),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      for (const reason of ["reload", "quit", "quit"]) {
        statuses.set("sync", "stale");
        for (const handler of shutdowns ?? []) {
          await handler({ type: "session_shutdown", reason }, ctx);
        }
        assert.equal(statuses.get("sync"), undefined);
      }
      assert.equal(statuses.get("unrelated"), "keep");
      assert.deepEqual(notifications, []);
    } finally {
      loaded.runtime.invalidate("generated setup smoke complete");
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});

// Memoize prerequisites inside each selectable test, never in a longer setup hook.
describe("generated lazy background check", { concurrent: false, shuffle: false }, () => {
  let root: string;
  let agentDir: string;
  let fixtureReady: Promise<void> | undefined;
  let reloadReady: Promise<void> | undefined;
  let foregroundReady = Promise.resolve();
  let loaded: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  function ensureFixture(): Promise<void> {
    fixtureReady ??= (async () => {
      const builder = await loadBuilder();
      root = await mkdtemp(join(packageRoot, ".pi-sync-build-test-"));
      agentDir = join(root, "agent");
      await builder.buildRuntime({ outputDirectory: join(root, "dist") });
      await mkdir(agentDir);
      await writeFile(join(agentDir, "pi-sync.json"), JSON.stringify(v3WebDavSettings({ automatic: true })));
      await writeFile(join(agentDir, "settings.json"), "{}\n");
      process.env.PI_CODING_AGENT_DIR = agentDir;
    })();
    return fixtureReady;
  }

  test("builds the shared background-check fixture within the test budget", ensureFixture);

  afterAll(async () => {
    // A timed-out build can still publish output; finish it before deleting the fixture.
    await fixtureReady?.catch(() => {});
    await reloadReady?.catch(() => {});
    await foregroundReady.catch(() => {});
    loaded?.runtime.invalidate("generated background check smoke complete");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (root) await rm(root, { force: true, recursive: true });
  });

  async function ensureLoaded(signal: AbortSignal): Promise<void> {
    await ensureFixture();
    signal.throwIfAborted();
    reloadReady ??= (async () => {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.inMemory({}),
        additionalExtensionPaths: [join(root, "dist/index.ts")],
      });
      // Retain the runtime before reload so partial initialization is also cleaned up.
      loaded = loader.getExtensions();
      await loader.reload();
      loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      assert.ok(loaded.extensions[0]?.commands.has("sync"));
    })();
    await reloadReady;
    signal.throwIfAborted();
  }

  test("loads the generated registration without starting a session", async ({ signal }) => {
    await ensureLoaded(signal);
  });

  test("accepts foreground help before the lazy remote check completes", async ({ signal }) => {
    foregroundReady = foregroundReady.catch(() => {}).then(() => exerciseForegroundHelp(signal));
    await foregroundReady;
  });

  async function exerciseForegroundHelp(signal: AbortSignal): Promise<void> {
    await ensureLoaded(signal);
    const previousFetch = globalThis.fetch;
    const requested = deferred();
    let aborted = false;
    let requests = 0;
    const extension = loaded?.extensions[0];
    assert.ok(extension);
    const context = createMockContext({ mode: "rpc" });
    globalThis.fetch = (async (_input, init) => {
      assert.equal(init?.method, "GET");
      requests++;
      requested.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;
    const cancelWait = () => requested.resolve();
    signal.addEventListener("abort", cancelWait, { once: true });
    try {
      for (const handler of extension.handlers.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, context.ctx);
        signal.throwIfAborted();
      }
      await requested.promise;
      signal.throwIfAborted();
      assert.equal(aborted, false);
      await extension.commands.get("sync")?.handler("help", context.ctx);
      signal.throwIfAborted();
      assert.equal(aborted, true);
      assert.equal(requests, 1);
      assert.ok(context.notifications.some((n) => n.message.includes("/sync")));
      assert.ok(context.notifications.every((n) => !/failed|skipped/iu.test(n.message)));
    } finally {
      try {
        for (const handler of extension.handlers.get("session_shutdown") ?? [])
          await handler({ type: "session_shutdown", reason: "reload" }, context.ctx);
      } finally {
        signal.removeEventListener("abort", cancelWait);
        globalThis.fetch = previousFetch;
      }
    }
  }
});

test("failed runtime publication restores the previous output", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-sync-build-test-"));
  const output = join(root, "dist");
  try {
    await mkdir(output);
    await writeFile(join(output, "previous.ts"), "previous");
    await assert.rejects(
      builder.buildRuntime({
        outputDirectory: output,
        validateOutput: async (staging) => {
          await builder.validateGeneratedFiles(staging);
          // Simulate staging disappearing after validation but before publication.
          await rm(staging, { recursive: true });
        },
      }),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    assert.deepEqual(await listFiles(root), ["dist/previous.ts"]);
    assert.equal(await readFile(join(output, "previous.ts"), "utf8"), "previous");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("source boundary audit rejects backend UI imports and static cycles", () => {
  assert.throws(
    () =>
      assertSourceBoundaries({
        inputs: {
          "src/backends/transport.ts": {
            imports: [{ path: "src/ui/menu.ts", kind: "dynamic-import" }],
          },
        },
      }),
    /imports UI/u,
  );
  assert.throws(
    () =>
      assertSourceBoundaries({
        inputs: {
          "first.ts": { imports: [{ path: "second.ts", kind: "import-statement" }] },
          "second.ts": { imports: [{ path: "first.ts", kind: "import-statement" }] },
        },
      }),
    /static source import cycle/u,
  );
});

function assertSourceBoundaries(metadata: BuildMetadata) {
  const inputs = metadata.inputs;
  assert.ok(inputs, "source graph must be available for boundary checks");
  const active = new Set<string>();
  const visited = new Set<string>();
  function visit(file: string) {
    assert.equal(active.has(file), false, `static source import cycle at ${file}`);
    if (visited.has(file)) return;
    active.add(file);
    for (const imported of inputs?.[file]?.imports ?? []) {
      if (imported.external) continue;
      if (file.startsWith("src/backends/")) {
        assert.equal(imported.path.startsWith("src/ui/"), false, `${file} imports UI`);
      }
      if (imported.kind !== "dynamic-import") visit(imported.path);
    }
    active.delete(file);
    visited.add(file);
  }
  for (const file of Object.keys(inputs)) visit(file);
}
