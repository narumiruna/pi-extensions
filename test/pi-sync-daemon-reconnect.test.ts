import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { type ClientFacts, requestDaemon } from "@narumitw/pi-sync-daemon";
import { test, vi } from "vitest";
import type { PiApplyGate } from "../packages/pi-sync/src/daemon/apply-gate.js";
import { withTempHome } from "../packages/pi-sync/test/helpers.js";
// Use the real daemon's admission boundary, not a mocked attach or HTTP response.
import { ParticipantAdmission } from "../packages/pi-sync-daemon/src/participant-admission.js";
import { startServer } from "../packages/pi-sync-daemon/src/server.js";
import { createMockContext } from "./support.js";

vi.mock("@narumitw/pi-sync-daemon", async (original) => {
  const actual = await original<typeof import("@narumitw/pi-sync-daemon")>();
  // The fixture owns an in-process server. Keep real discovery and transport,
  // but do not acquire a second process-startup lock for that same process.
  return { ...actual, ensureDaemon: actual.findDaemon };
});

for (const phase of ["queued", "published"] as const)
  test(`the next command reconnects after cancelling a ${phase} first attach`, () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const root = await fs.realpath(agentDir);
      const target = path.join(root, "protected.md");
      await fs.writeFile(target, "unchanged\n");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const request = new AbortController();
      const executed: ClientFacts[] = [];
      let hookHeld = false;
      const server = await startServer(
        root,
        async (_operation, _payload, execution) => {
          const facts = execution.facts();
          assert.ok(facts);
          executed.push(facts);
          const reservation = randomUUID();
          const grant = await execution.request("queue-acquire", {
            generation: facts.generation,
            reservation,
            targets: [target],
          });
          assert.equal(typeof grant, "string");
          await execution.request("queue-release", { reservation });
          return { id: facts.id, generation: facts.generation };
        },
        {
          factsChanged: async () => {
            if (phase !== "published" || hookHeld) return;
            hookHeld = true;
            entered.resolve();
            await release.promise;
          },
        },
      );
      const manager = SessionManager.create(root, path.join(root, "sessions"));
      const { ctx } = createMockContext({ cwd: root, mode: "rpc", hasUI: true, sessionManager: manager });
      // Install the owned agent-root environment before importing the adapter.
      const { bindPiDaemonClient } = await import("../packages/pi-sync/src/daemon/pi-client.js");
      const client = bindPiDaemonClient(ctx as ExtensionContext, controller.signal);
      const gate = (client as unknown as { gate: PiApplyGate }).gate;
      const old: ClientFacts = {
        id: client.id,
        generation: client.generation,
        pid: process.pid,
        cwd: root,
        mode: "rpc",
        hasUI: true,
        idle: true,
      };
      let held: Promise<unknown> | undefined;
      let running: Promise<unknown> | undefined;
      let observer: ReturnType<typeof vi.spyOn> | undefined;
      try {
        if (phase === "queued") {
          const ready = Promise.withResolvers<void>();
          held = server.backgroundExecution(controller.signal).withParticipants(async () => {
            ready.resolve();
            await release.promise;
          });
          await ready.promise;
          const original = ParticipantAdmission.prototype.run;
          observer = vi.spyOn(ParticipantAdmission.prototype, "run").mockImplementation(function <T>(
            this: ParticipantAdmission,
            action: () => Promise<T>,
            signal?: AbortSignal,
          ) {
            entered.resolve();
            return original.call(this, action, signal) as Promise<T>;
          });
        }
        running = client.run("probe", { cancelled: true }, request.signal);
        const rejected = assert.rejects(running, { name: "AbortError" });
        await entered.promise;
        observer?.mockRestore();
        if (phase === "published") {
          const background = server.backgroundExecution(controller.signal);
          const grant = await background.request(
            "queue-acquire",
            { generation: old.generation, reservation: "old-attempt", targets: [target] },
            old.id,
          );
          assert.equal(typeof grant, "string");
          assert.equal(gate.size, 1, "a published participant can own grants before attach returns");
        }
        request.abort();
        await rejected;
        assert.deepEqual(executed, [], "a cancelled startup must not submit an operation");
        release.resolve();
        await held;
        // Retirement is intentional: a late request must not revive the old attempt.
        await assert.rejects(requestDaemon(server.paths, server.identity, "attach", old), /Client was retired/u);
        const result = await client.run("probe", { next: true });
        assert.notEqual(client.id, old.id);
        assert.notEqual(client.generation, old.generation);
        assert.deepEqual(result, { id: client.id, generation: client.generation });
        assert.equal(gate.size, 0, "old grants must drain before the next command runs");
        assert.equal(executed.length, 1, "only the next explicit command may run");
        const connected = await client.connect();
        assert.equal(connected.facts.id, client.id);
        assert.equal(connected.facts.generation, client.generation);
        assert.equal(connected.facts.sessionId, manager.getSessionId());
        assert.equal(connected.facts.sessionFile, manager.getSessionFile());
        assert.deepEqual(
          server.participants().map((facts) => facts.id),
          [client.id],
        );
        assert.equal(await fs.readFile(target, "utf8"), "unchanged\n");
      } finally {
        observer?.mockRestore();
        request.abort();
        release.resolve();
        await Promise.allSettled([held, running]);
        try {
          await client.dispose();
        } finally {
          controller.abort();
          await server.close();
        }
      }
    }));
