import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DaemonConnection, ensureDaemon, modelSignature } from "@narumitw/pi-sync-daemon";
import { afterAll, aroundEach, describe, test } from "vitest";
import { createSyncBackend } from "../src/backends/backend-factory.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { sessionDirFromContext } from "../src/snapshot/session-paths.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { push } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { snapshot, v3WebDavSettings, withTempHome } from "./helpers.js";
import { mergeOptions } from "./merge-options.js";
import { MockResolverServer } from "./mock-resolver-server.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

type LoadedExtensions = ReturnType<DefaultResourceLoader["getExtensions"]>;
let fixtureRoot: string | undefined;
let fixtureReady: Promise<string> | undefined;
let scenarioReady = Promise.resolve();

function runtimeFixture(): Promise<string> {
  // Build on first use so filtered tests do not depend on another test or a setup hook.
  fixtureReady ??= (async () => {
    fixtureRoot = await fs.mkdtemp(path.resolve("packages/pi-sync/.pi-sync-build-test-"));
    const builderPath = pathToFileURL(path.resolve("packages/pi-sync/scripts/build-runtime.mjs")).href;
    const builder = (await import(builderPath)) as {
      buildRuntime(options: { outputDirectory: string }): Promise<unknown>;
    };
    const output = path.join(fixtureRoot, "dist");
    await builder.buildRuntime({ outputDirectory: output });
    // Never import or change this output. Each test loads its own complete copy.
    return output;
  })();
  return fixtureReady;
}

afterAll(async () => {
  // Drain timed-out copies and loader operations before removing the shared output.
  await scenarioReady.catch(() => {});
  await fixtureReady?.catch(() => {});
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

const triggers = [
  "command",
  "startup",
  "continuous",
  "retry",
  "after-exit",
  "missing-model",
  "changed-model",
  "parent-only",
  "different-auth",
  "non-agent",
] as const;

async function withJitiFixture(
  trigger: (typeof triggers)[number],
  signal: AbortSignal,
  use: (exercise: () => Promise<void>) => Promise<void>,
) {
  const refusal =
    trigger === "parent-only"
      ? /No independently available daemon resolver model is authorized/u
      : trigger === "missing-model" || trigger === "changed-model"
        ? /No fallback model was selected\. Align the host and daemon Pi model catalogs/u
        : trigger === "different-auth"
          ? /Check model access and retry later/u
          : undefined;
  const foreground = trigger === "command" || trigger === "retry" || trigger === "non-agent" || refusal !== undefined;
  // A timeout can leave an uncancellable build or reload pending; do not overlap HOME scopes.
  await scenarioReady.catch(() => {});
  signal.throwIfAborted();
  scenarioReady = withTempHome(async (agentDir) => {
    let server: MockWebDavServer | undefined;
    let resolver: MockResolverServer | undefined;
    let buildDir: string | undefined;
    let loader: DefaultResourceLoader | undefined;
    let extension: LoadedExtensions["extensions"][number] | undefined;
    let shutdown: Promise<void> | undefined;
    let done: (() => void) | undefined;
    let replies = 0;
    let watcher: FSWatcher | undefined;
    const mock = agentContext(selectRemote);
    mock.ctx.isIdle = () => !foreground && trigger !== "after-exit";
    resolver = new MockResolverServer(({ units }) =>
      trigger === "retry" && ++replies === 1
        ? JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) })
        : selectRemote(units),
    );
    const stop = (): Promise<void> => {
      if (!extension) return Promise.resolve();
      const current = extension;
      shutdown ??= (async () => {
        for (const handler of current.handlers.get("session_shutdown") ?? [])
          await handler({ type: "session_shutdown", reason: trigger === "after-exit" ? "quit" : "reload" }, mock.ctx);
      })();
      return shutdown;
    };
    const cancel = () => {
      done?.();
      // Shutdown aborts and drains an in-flight command, startup check, or scheduler.
      // The finally block observes any shutdown failure before releasing its resources.
      void stop().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const fixture = await runtimeFixture();
      signal.throwIfAborted();
      buildDir = await fs.mkdtemp(path.resolve("packages/pi-sync/.pi-sync-build-test-"));
      signal.throwIfAborted();
      await fs.cp(fixture, path.join(buildDir, "dist"), { recursive: true });
      signal.throwIfAborted();
      server = new MockWebDavServer();
      await server.start();
      signal.throwIfAborted();
      await fs.mkdir(agentDir, { recursive: true });
      await resolver.start();
      await resolver.configure(agentDir, mock.ctx);
      const model = mock.ctx.model;
      assert.ok(model);
      if (trigger === "missing-model") mock.ctx.model = { ...model, id: "resolver-next" };
      if (trigger === "changed-model") {
        mock.ctx.model = { ...model, compat: { ...model.compat, supportsMidConvoEffort: true } };
      }
      if (trigger === "parent-only" || trigger === "non-agent") {
        mock.ctx.modelRegistry.getRegisteredProviderIds = () => [model.provider];
      }
      if (trigger === "different-auth") {
        mock.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
      }
      signal.throwIfAborted();
      const settings = v3WebDavSettings({ include: ["AGENTS.md"] });
      settings.storageConnections.dav.url = server.url;
      Object.assign(settings.syncSetups.home.sync, {
        agentMode: trigger !== "non-agent",
        ...(["continuous", "after-exit"].includes(trigger) ? { continuous: true } : {}),
      });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      signal.throwIfAborted();
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "base\n");
      signal.throwIfAborted();
      await push(mock.ctx, { ...mergeOptions, signal });
      signal.throwIfAborted();
      const config = await loadConfig();
      const acceptedState = refusal ? await readStateForConfig(config) : undefined;
      signal.throwIfAborted();
      const backend = await createSyncBackend(config);
      signal.throwIfAborted();
      const head = await backend.readHead(signal);
      signal.throwIfAborted();
      assert.ok(head);
      const remote = await backend.readSnapshot(head.snapshotRef, signal);
      signal.throwIfAborted();
      await backend.publishSnapshot(
        regenerateSnapshotIdentity({
          ...remote,
          files: snapshot([{ path: "AGENTS.md", content: Buffer.from("remote\n") }]).files,
        }),
        { kind: "revision", revision: head.revision },
        { signal },
      );
      signal.throwIfAborted();
      const conflictHead = await backend.readHead(signal);
      assert.ok(conflictHead);
      if (trigger !== "non-agent") await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
      signal.throwIfAborted();
      await adoptFixtureRoot(agentDir);
      signal.throwIfAborted();
      const entry = path.join(buildDir, "dist/index.ts");
      loader = new DefaultResourceLoader({
        cwd: buildDir,
        agentDir,
        settingsManager: SettingsManager.inMemory({}),
        additionalExtensionPaths: [entry],
      });
      // Retain the loader before reload so cleanup also sees partial initialization.
      await loader.reload();
      const loaded = loader.getExtensions();
      const loadedExtension = loaded.extensions[0];
      extension = loadedExtension;
      signal.throwIfAborted();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      assert.ok(loadedExtension);
      assert.equal(loadedExtension.resolvedPath, entry);
      await use(async () => {
        if (foreground) {
          for (const start of loadedExtension.handlers.get("session_start") ?? [])
            await start({ type: "session_start", reason: "startup" }, mock.ctx);
          signal.throwIfAborted();
          const command = loadedExtension.commands.get("sync");
          assert.ok(command);
          await command.handler(trigger === "non-agent" ? "sync --yes" : "sync", mock.ctx as ExtensionCommandContext);
          signal.throwIfAborted();
          if (trigger === "retry") {
            assert.equal(resolver.requests.length, 1);
            assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
            const choices = ["Retry refused model result…", "Yes, Send one fresh request", undefined];
            mock.ctx.ui.select = async () => choices.shift();
            await command.handler("", mock.ctx as ExtensionCommandContext);
            signal.throwIfAborted();
            assert.equal(choices.length, 0);
            const candidates = await fs.readdir(path.join(agentDir, "pi-sync/agent-resolver"));
            assert.ok(candidates.some((name) => name.includes(".refusal-")));
          }
        } else if (trigger === "after-exit") {
          for (const start of loadedExtension.handlers.get("session_start") ?? [])
            await start({ type: "session_start", reason: "startup" }, mock.ctx);
          const owner = await ensureDaemon(agentDir);
          assert.ok(mock.ctx.model);
          const client = await new DaemonConnection(
            owner.paths,
            owner.identity,
            {
              id: randomUUID(),
              generation: randomUUID(),
              pid: process.pid,
              cwd: mock.ctx.cwd,
              mode: "rpc",
              hasUI: true,
              idle: false,
              ready: false,
              sessionDir: sessionDirFromContext(mock.ctx),
              model: {
                provider: mock.ctx.model.provider,
                id: mock.ctx.model.id,
                signature: modelSignature(mock.ctx.model),
                authSource: "models_json_key",
              },
            },
            {
              callback: async (callback) => {
                if (callback.kind !== "confirm") throw new Error("Unexpected unattended approval.");
                return true;
              },
            },
          ).attach();
          try {
            const policy = (await client.run("daemon.policy", undefined)) as { fingerprint: string };
            await client.run("daemon.authorize", { ...policy, afterExit: true });
          } finally {
            await client.dispose();
          }
          assert.equal(resolver.requests.length, 0, "Busy clients cannot authorize a background request.");
          const applied = new Promise<void>((resolve, reject) => {
            done = resolve;
            watcher = watch(agentDir, (_event, name) => {
              if (name === "AGENTS.md")
                void fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8").then((content) => {
                  if (content === "remote\n") resolve();
                }, reject);
            });
            watcher.on("error", reject);
          });
          await stop();
          assert.equal(
            JSON.parse(await fs.readFile(path.join(agentDir, "pi-sync/daemon.json"), "utf8")).setups.home.afterExit,
            true,
            "Closing clients must not revoke matching reviewed unattended bindings.",
          );
          await applied;
          signal.throwIfAborted();
        } else {
          const complete = new Promise<void>((resolve) => {
            done = resolve;
          });
          const notify = mock.ctx.ui.notify.bind(mock.ctx.ui);
          mock.ctx.ui.notify = (message, level) => {
            notify(message, level);
            if (message.includes("No automatic reload.") || message.includes("stopped:")) done?.();
          };
          for (const start of loadedExtension.handlers.get("session_start") ?? []) {
            await start({ type: "session_start", reason: "startup" }, mock.ctx);
            signal.throwIfAborted();
          }
          // Observe operation completion, not a fixed sleep; cancellation releases this wait.
          await complete;
          signal.throwIfAborted();
        }
        await stop();
        signal.throwIfAborted();
        const expectedRequests = refusal || trigger === "non-agent" ? 0 : trigger === "retry" ? 2 : 1;
        assert.equal(resolver.requests.length, expectedRequests, JSON.stringify(mock.notifications));
        assert.equal(mock.requests.length, 0, "The parent transport must not be captured by the daemon.");
        assert.equal(
          await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"),
          refusal ? "local\n" : "remote\n",
          JSON.stringify(mock.notifications),
        );
        if (refusal) {
          assert.ok(
            mock.notifications.some(({ level, message }) => level === "error" && refusal.test(message)),
            JSON.stringify(mock.notifications),
          );
          assert.deepEqual(await backend.readHead(signal), conflictHead, "Refusal must not publish over the conflict.");
          assert.deepEqual(await readStateForConfig(config), acceptedState, "Refusal must retain the accepted state.");
        }
        signal.throwIfAborted();
        assert.equal(mock.statuses.get("sync"), undefined);
      });
    } finally {
      signal.removeEventListener("abort", cancel);
      watcher?.close();
      try {
        await stop();
      } finally {
        try {
          loader?.getExtensions().runtime.invalidate("agent Jiti test complete");
        } finally {
          try {
            await resolver?.close();
            await server?.close();
          } finally {
            if (buildDir) await fs.rm(buildDir, { recursive: true, force: true });
          }
        }
      }
    }
  });
  await scenarioReady;
}

for (const trigger of triggers) {
  describe(`generated Jiti runtime: ${trigger}`, () => {
    let exercise: (() => Promise<void>) | undefined;
    let running: Promise<void> | undefined;
    // Prepare the daemon, backend, and Jiti loader before timing the sync operation.
    aroundEach(async (runTest, { signal }) => {
      await withJitiFixture(trigger, signal, async (operation) => {
        exercise = operation;
        try {
          await runTest();
        } finally {
          // Vitest can release runTest on timeout while its aborted work is still draining.
          await running?.catch(() => {});
          running = undefined;
          exercise = undefined;
        }
      });
    });
    test("with an isolated WebDAV backend", () => {
      assert.ok(exercise);
      running = exercise();
      return running;
    });
  });
}
