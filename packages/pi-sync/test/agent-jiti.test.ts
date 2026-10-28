import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterAll, test } from "vitest";
import { createSyncBackend } from "../src/backends/backend-factory.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { push } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { snapshot, v3WebDavSettings, withTempHome } from "./helpers.js";
import { mergeOptions } from "./merge-options.js";
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

for (const trigger of ["command", "startup", "continuous", "retry"] as const)
  test(`generated Jiti runtime resolves a real WebDAV conflict via ${trigger}`, async ({ signal }) => {
    // A timeout can leave an uncancellable build or reload pending; do not overlap HOME scopes.
    await scenarioReady.catch(() => {});
    signal.throwIfAborted();
    scenarioReady = withTempHome(async (agentDir) => {
      let server: MockWebDavServer | undefined;
      let buildDir: string | undefined;
      let loader: DefaultResourceLoader | undefined;
      let extension: LoadedExtensions["extensions"][number] | undefined;
      let shutdown: Promise<void> | undefined;
      let done: (() => void) | undefined;
      let replies = 0;
      const mock = agentContext((units) =>
        trigger === "retry" && ++replies === 1
          ? JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) })
          : selectRemote(units),
      );
      const stop = (): Promise<void> => {
        if (!extension) return Promise.resolve();
        const current = extension;
        shutdown ??= (async () => {
          for (const handler of current.handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "reload" }, mock.ctx);
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
        signal.throwIfAborted();
        const settings = v3WebDavSettings({ include: ["AGENTS.md"] });
        settings.storageConnections.dav.url = server.url;
        Object.assign(settings.syncSetups.home.sync, {
          agentMode: true,
          ...(trigger === "continuous" ? { continuous: true } : {}),
        });
        await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        signal.throwIfAborted();
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "base\n");
        signal.throwIfAborted();
        await push(mock.ctx, { ...mergeOptions, signal });
        signal.throwIfAborted();
        const config = await loadConfig();
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
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
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
        extension = loaded.extensions[0];
        signal.throwIfAborted();
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        assert.ok(extension);
        assert.equal(extension.resolvedPath, entry);
        if (trigger === "command" || trigger === "retry") {
          const command = extension.commands.get("sync");
          assert.ok(command);
          await command.handler("sync", mock.ctx as ExtensionCommandContext);
          signal.throwIfAborted();
          if (trigger === "retry") {
            assert.equal(mock.requests.length, 1);
            assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
            const choices = ["Retry refused model result…", "Yes, Send one fresh request", undefined];
            mock.ctx.ui.select = async () => choices.shift();
            await command.handler("", mock.ctx as ExtensionCommandContext);
            signal.throwIfAborted();
            assert.equal(choices.length, 0);
            const candidates = await fs.readdir(path.join(agentDir, "pi-sync/agent-resolver"));
            assert.ok(candidates.some((name) => name.includes(".refusal-")));
          }
        } else {
          const complete = new Promise<void>((resolve) => {
            done = resolve;
          });
          const notify = mock.ctx.ui.notify.bind(mock.ctx.ui);
          mock.ctx.ui.notify = (message, level) => {
            notify(message, level);
            if (message.includes("No automatic reload.") || message.includes("stopped:")) done?.();
          };
          for (const start of extension.handlers.get("session_start") ?? []) {
            await start({ type: "session_start", reason: "startup" }, mock.ctx);
            signal.throwIfAborted();
          }
          // Observe operation completion, not a fixed sleep; cancellation releases this wait.
          await complete;
          signal.throwIfAborted();
        }
        await stop();
        signal.throwIfAborted();
        assert.equal(mock.requests.length, trigger === "retry" ? 2 : 1, JSON.stringify(mock.notifications));
        assert.equal(
          await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"),
          "remote\n",
          JSON.stringify(mock.notifications),
        );
        signal.throwIfAborted();
        assert.equal(mock.statuses.get("sync"), undefined);
      } finally {
        signal.removeEventListener("abort", cancel);
        try {
          await stop();
        } finally {
          try {
            loader?.getExtensions().runtime.invalidate("agent Jiti test complete");
          } finally {
            try {
              await server?.close();
            } finally {
              if (buildDir) await fs.rm(buildDir, { recursive: true, force: true });
            }
          }
        }
      }
    });
    await scenarioReady;
  });
