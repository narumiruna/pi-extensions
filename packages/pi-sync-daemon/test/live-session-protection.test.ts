import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonConnection, requestDaemon } from "../src/client.js";
import { engineHost } from "../src/engine/host.js";
import { runtimePaths } from "../src/identity.js";
import { withCleanup } from "../src/lifecycle.js";
import type { ClientFacts, Execution } from "../src/protocol.js";
import { startServer } from "../src/server.js";
import { createServiceContext, installServiceHost } from "../src/service-host.js";

function facts(root: string, name: string, pid = process.pid): ClientFacts {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid,
    cwd: root,
    mode: "rpc",
    hasUI: true,
    idle: true,
    sessionFile: path.join(root, `${name}.jsonl`),
  };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-protection-")));
  try {
    await run(root);
  } finally {
    const paths = await runtimePaths(root);
    await fs.rm(paths.directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const cleanup of ["detach", "exit", "pause", "replace"] as const)
  test(`${cleanup} retains live-session protection through another attach and daemon restart`, () =>
    fixture(async (root) => {
      const host = installServiceHost(root);
      const write = (execution: Execution, target: string) =>
        host.run(execution, () => engineHost().mutate(target, () => fs.writeFile(target, "overwritten")));
      let server = await startServer(root, async (_operation, target, execution) => {
        assert.equal(typeof target, "string");
        await write(execution, target as string);
        return true;
      });
      const oldFacts = facts(root, "retired");
      const otherFacts = facts(root, "other");
      const connect = (peer: ClientFacts) =>
        new DaemonConnection(server.paths, server.identity, peer, { callback: async () => true });
      let other: DaemonConnection | undefined;
      const background = new AbortController();
      const active = cleanup === "pause" || cleanup === "replace";
      try {
        await fs.writeFile(oldFacts.sessionFile as string, "original");
        await requestDaemon(server.paths, server.identity, "attach", oldFacts);
        await requestDaemon(
          server.paths,
          server.identity,
          cleanup === "exit" || cleanup === "replace" ? "handoff" : cleanup,
          {
            client: oldFacts.id,
            generation: oldFacts.generation,
            pid: oldFacts.pid,
            handoff: { kind: cleanup, file: path.join(root, "next.jsonl") },
          },
        );
        assert.equal(
          server.participants().some((peer) => peer.id === oldFacts.id),
          active,
        );
        assert.ok(server.liveClients().some((peer) => peer.id === oldFacts.id));
        // Zero-client/background writes use the same guard, not participation as a proxy for liveness.
        await assert.rejects(
          write(server.backgroundExecution(background.signal), oldFacts.sessionFile as string),
          /session is protected/u,
        );
        other = await connect(otherFacts).attach();
        await assert.rejects(other.run("write", oldFacts.sessionFile), /session is protected/u);
        const peers = JSON.parse(await fs.readFile(path.join(server.paths.directory, "clients.json"), "utf8"));
        assert.ok(peers.clients.some((peer: ClientFacts) => peer.id === oldFacts.id));
        if (!active) {
          // Repeated or late cleanup must not turn a retired exit back into an ambiguous participant.
          await requestDaemon(server.paths, server.identity, "pause", { client: oldFacts.id });
          assert.ok(!server.participants().some((peer) => peer.id === oldFacts.id));
        }
        await other.dispose({ kind: "exit" });
        await server.close();
        server = await startServer(root, async (_operation, target, execution) => {
          const context = createServiceContext(execution);
          assert.ok(context.protectedSessionFiles?.includes(oldFacts.sessionFile as string));
          await write(execution, target as string);
          return true;
        });
        assert.equal(
          server.participants().some((peer) => peer.id === oldFacts.id),
          active,
        );
        if (active) assert.equal(server.participants().find((peer) => peer.id === oldFacts.id)?.idle, false);
        else await assert.rejects(connect(oldFacts).attach(), /retired/u);
        other = await connect(facts(root, "after-restart")).attach();
        await assert.rejects(other.run("write", oldFacts.sessionFile), /session is protected/u);
        assert.equal(await fs.readFile(oldFacts.sessionFile as string, "utf8"), "original");
      } finally {
        background.abort();
        try {
          await other?.dispose();
        } finally {
          await server.close();
        }
      }
    }));

test("only confirmed PID exit releases a retired session for another client's apply", () =>
  fixture(async (root) => {
    const child = spawn(process.execPath, ["--eval", 'process.send("ready"); process.on("message", () => {});'], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    const ready = once(child, "message");
    const host = installServiceHost(root);
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let old: DaemonConnection | undefined;
    let other: DaemonConnection | undefined;
    try {
      server = await startServer(root, async (_operation, target, execution) => {
        await host.run(execution, () =>
          engineHost().mutate(target as string, () => fs.writeFile(target as string, "applied")),
        );
        return true;
      });
      assert.deepEqual(await ready, ["ready", undefined]);
      assert.ok(child.pid);
      const retired = facts(root, "child", child.pid);
      await fs.writeFile(retired.sessionFile as string, "original");
      old = await new DaemonConnection(server.paths, server.identity, retired, { callback: async () => true }).attach();
      await old.dispose({ kind: "exit" });
      other = await new DaemonConnection(server.paths, server.identity, facts(root, "requester"), {
        callback: async () => true,
      }).attach();
      await assert.rejects(other.run("write", retired.sessionFile), /session is protected/u);
      child.kill();
      await exited;
      await server.expireClients();
      assert.ok(!server.liveClients().some((peer) => peer.id === retired.id));
      assert.equal(await other.run("write", retired.sessionFile), true);
      assert.equal(await fs.readFile(retired.sessionFile as string, "utf8"), "applied");
      const peers = JSON.parse(await fs.readFile(path.join(server.paths.directory, "clients.json"), "utf8"));
      assert.ok(!peers.clients.some((peer: ClientFacts) => peer.id === retired.id));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await withCleanup(
        async () => {
          const results = await Promise.allSettled([old?.dispose(), other?.dispose()]);
          for (const result of results) if (result.status === "rejected") throw result.reason;
        },
        async () => server?.close(),
      );
    }
  }));
