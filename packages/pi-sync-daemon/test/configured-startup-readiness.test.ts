import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { requestDaemon } from "../src/client.js";
import type { ClientFacts } from "../src/protocol.js";
import type { startServer } from "../src/server.js";
import { withRpcServer } from "./rpc-server-fixture.js";

const injected = vi.hoisted(() => ({
  probe: undefined as ((signal: AbortSignal) => Promise<() => boolean>) | undefined,
}));
vi.mock("../src/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server.js")>();
  return {
    ...actual,
    startServer: (...args: Parameters<typeof startServer>) =>
      actual.startServer(args[0], args[1], {
        ...args[2],
        startup: {
          captureReviewLock: () => undefined,
          probe: async (_fingerprint, signal) => injected.probe?.(signal),
        },
      }),
  };
});

test.each(["recovery change", "owner facts changed", "request cancellation", "publication failure"] as const)(
  "startup never exposes readiness across %s during ledger staging",
  async (race) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-startup-ready-")));
    try {
      await withRpcServer(
        root,
        async () => {},
        async ({ server, createConnection }) => {
          const facts: ClientFacts = {
            id: randomUUID(),
            generation: randomUUID(),
            pid: process.pid,
            cwd: root,
            ready: false,
            mode: "rpc",
            hasUI: true,
            idle: true,
          };
          const connection = createConnection(facts, { callback: async () => null });
          await connection.attach();
          const peersFile = path.join(server.paths.directory, "clients.json");
          const staged = Promise.withResolvers<void>();
          const restored = Promise.withResolvers<void>();
          const resume = Promise.withResolvers<void>();
          const controller = new AbortController();
          let sound = true;
          let serverSignal: AbortSignal | undefined;
          injected.probe = async (signal) => {
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
