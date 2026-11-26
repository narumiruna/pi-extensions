import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { requestDaemon } from "../src/client.js";
import type { Callback, ClientFacts, Execute } from "../src/protocol.js";
import type { ServerHooks, startServer } from "../src/server.js";
import { withRpcServer } from "./rpc-server-fixture.js";

type StartupHooks = NonNullable<ServerHooks["startup"]>;
const injected = vi.hoisted(() => ({
  reviewLock: undefined as ReturnType<StartupHooks["captureReviewLock"]>,
  probe: undefined as StartupHooks["probe"] | undefined,
}));
vi.mock("../src/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server.js")>();
  return {
    ...actual,
    startServer: (...args: Parameters<typeof startServer>) =>
      actual.startServer(args[0], args[1], {
        ...args[2],
        startup: {
          captureReviewLock: () => injected.reviewLock,
          probe: async (...args: Parameters<StartupHooks["probe"]>) => injected.probe?.(...args),
        },
      }),
  };
});

function startupFacts(root: string): ClientFacts {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    ready: false,
    mode: "rpc",
    hasUI: true,
    idle: true,
  };
}

test.each(["startup-transfer", "shutdown", "daemon.authorize"])(
  "startup defers to a held review fenced by participant generation (%s)",
  async (operation) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-startup-ready-")));
    const execute: Execute = async (_operation, _payload, execution) => {
      const answer = await execution.request("confirm", {});
      execution.validate();
      return answer;
    };
    try {
      await withRpcServer(root, execute, async ({ server, createConnection }) => {
        const opened = Promise.withResolvers<Callback>();
        const answer = Promise.withResolvers<boolean>();
        const reviewer = await createConnection(
          { ...startupFacts(root), ready: true },
          {
            callback: async (callback) => {
              opened.resolve(callback);
              return answer.promise;
            },
          },
        ).attach();
        const facts = startupFacts(root);
        await createConnection(facts, { callback: async () => null }).attach();
        const generation = server.participantGeneration();
        const probe = vi.fn<StartupHooks["probe"]>(async (_fingerprint, _signal, lock) => lock);
        injected.probe = probe;
        injected.reviewLock = () => true;
        const reviewed = reviewer.run(operation, {});
        void reviewed.catch(() => {});
        try {
          const callback = await Promise.race([
            opened.promise,
            reviewed.then(() => {
              throw new Error("Job finished before opening a review.");
            }),
          ]);
          assert.equal(callback.kind, "confirm");
          const ready = await requestDaemon(server.paths, server.identity, "startup.bootstrap", {
            client: facts.id,
            generation: facts.generation,
            fingerprint: "0".repeat(64),
            debug: true,
          });
          assert.equal(ready, false);
          assert.equal(probe.mock.calls.length, 0);
          assert.equal(server.participants().find((peer) => peer.id === facts.id)?.ready, false);
          assert.equal(server.participantGeneration(), generation);
          answer.resolve(true);
          assert.equal(await reviewed, true);
        } finally {
          answer.resolve(false);
          await reviewed.catch(() => {});
          injected.probe = undefined;
          injected.reviewLock = undefined;
        }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["recovery change", "owner facts changed", "request cancellation", "publication failure"] as const)(
  "startup never exposes readiness across %s during ledger staging",
  async (race) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-startup-ready-")));
    try {
      await withRpcServer(
        root,
        async () => {},
        async ({ server, createConnection }) => {
          const facts = startupFacts(root);
          const connection = createConnection(facts, { callback: async () => null });
          await connection.attach();
          const peersFile = path.join(server.paths.directory, "clients.json");
          const staged = Promise.withResolvers<void>();
          const restored = Promise.withResolvers<void>();
          const resume = Promise.withResolvers<void>();
          const controller = new AbortController();
          let sound = true;
          let serverSignal: AbortSignal | undefined;
          injected.probe = async (_fingerprint, signal) => {
            serverSignal = signal;
            return () => sound;
          };
          const rename = fs.rename;
          let writes = 0;
          const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
            if (target !== peersFile) return rename(source, target);
            const write = ++writes;
            if (write === 1) {
              staged.resolve();
              await resume.promise;
              if (race === "publication failure") throw new Error("fixture ledger publication failed");
            }
            await rename(source, target);
            if (write === 2) restored.resolve();
          });
          const startup = requestDaemon(
            server.paths,
            server.identity,
            "startup.bootstrap",
            {
              client: facts.id,
              generation: facts.generation,
              fingerprint: "0".repeat(64),
              debug: true,
            },
            controller.signal,
          );
          void startup.catch(() => {});
          let update: Promise<unknown> | undefined;
          try {
            await Promise.race([
              staged.promise,
              startup.then(() => {
                throw new Error("Startup returned before staging the ledger.");
              }),
            ]);
            assert.equal(server.participants()[0]?.ready, false);
            if (race === "recovery change") sound = false;
            if (race === "owner facts changed") {
              update = connection.update({ ...facts, idle: false });
              void update.catch(() => {});
              await vi.waitFor(() => assert.equal(server.participants()[0]?.idle, false));
            }
            if (race === "request cancellation") {
              controller.abort();
              await vi.waitFor(() => assert.ok(serverSignal?.aborted));
            }
            resume.resolve();
            if (race === "publication failure") await assert.rejects(startup, /ledger publication failed/u);
            else if (race === "request cancellation") {
              await assert.rejects(startup, { name: "AbortError" });
              await restored.promise;
            } else assert.equal(await startup, false);
            await update;
            assert.equal(server.participants()[0]?.ready, false);
            await vi.waitFor(async () => {
              const peers = JSON.parse(await fs.readFile(peersFile, "utf8"));
              assert.equal(peers.clients[0]?.ready, false);
            });
          } finally {
            resume.resolve();
            await Promise.allSettled([startup, update]);
            spy.mockRestore();
            injected.probe = undefined;
          }
        },
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
