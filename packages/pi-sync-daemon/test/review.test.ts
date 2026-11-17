import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonConnection } from "../src/client.js";
import { runtimePaths } from "../src/identity.js";
import { type Callback, type ClientFacts, MAX_REVIEW_BYTES, REVIEW_PAGE_CHARS } from "../src/protocol.js";
import { startServer } from "../src/server.js";

function facts(root: string): ClientFacts {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    mode: "rpc",
    hasUI: true,
    idle: true,
  };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-review-")));
  try {
    await run(root);
  } finally {
    const paths = await runtimePaths(root);
    await fs.rm(paths.directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("exact reviews larger than an IPC body preserve whitespace and split Unicode through bounded pages", () =>
  fixture(async (root) => {
    const content = `${" ".repeat(REVIEW_PAGE_CHARS - 1)}😀\t\n${"  exact  \t\n".repeat(500_000)}`;
    let seen: unknown;
    let calls = 0;
    const server = await startServer(root, async (_operation, _payload, execution) =>
      execution.request("merge-review", { title: "Exact review", content }),
    );
    const connection = new DaemonConnection(server.paths, server.identity, facts(root), {
      callback: async (callback) => {
        calls++;
        seen = (callback.payload as { content: unknown }).content;
        return true;
      },
    });
    try {
      await connection.attach();
      assert.equal(await connection.run("review", {}), true);
      assert.equal(seen, content);
      assert.equal(calls, 1);
    } finally {
      await connection.dispose();
      await server.close();
    }
  }));

test("oversized reviews fail before presentation or approval", () =>
  fixture(async (root) => {
    let calls = 0;
    const server = await startServer(root, async (_operation, _payload, execution) =>
      execution.request("merge-review", { title: "Too large", content: "x".repeat(MAX_REVIEW_BYTES + 1) }),
    );
    const connection = new DaemonConnection(server.paths, server.identity, facts(root), {
      callback: async () => {
        calls++;
        return true;
      },
    });
    try {
      await connection.attach();
      await assert.rejects(connection.run("review", {}), /review exceeds/iu);
      assert.equal(calls, 0);
    } finally {
      await connection.dispose();
      await server.close();
    }
  }));

test("a delayed older callback snapshot cannot cancel a newer live component", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => undefined);
    let entered = 0;
    let aborted = false;
    const connection = new DaemonConnection(server.paths, server.identity, facts(root), {
      callback: async (_callback, signal) => {
        entered++;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return false;
      },
    });
    // This is a unit boundary in this package, not a private SDK API.
    const snapshots = connection as unknown as { consume(value: unknown): void };
    const callback: Callback = { id: randomUUID(), job: randomUUID(), kind: "confirm", payload: {} };
    try {
      snapshots.consume({ cursor: 2, events: [], callbacks: [callback] });
      snapshots.consume({ cursor: 1, events: [], callbacks: [] });
      assert.equal(entered, 1);
      assert.equal(aborted, false);
      snapshots.consume({ cursor: 3, events: [], callbacks: [] });
      assert.equal(aborted, true);
    } finally {
      await connection.dispose();
      await server.close();
    }
  }));

test("handoff protection is removed only after its matching replacement is published", () =>
  fixture(async (root) => {
    const server = await startServer(root, async () => undefined);
    const oldFacts = { ...facts(root), sessionFile: path.join(root, "old.jsonl"), sessionId: randomUUID() };
    const nextFile = path.join(root, "next.jsonl");
    const old = new DaemonConnection(server.paths, server.identity, oldFacts, { callback: async () => false });
    const unrelated = new DaemonConnection(
      server.paths,
      server.identity,
      { ...facts(root), sessionFile: path.join(root, "other.jsonl") },
      { callback: async () => false },
    );
    const replacement = new DaemonConnection(
      server.paths,
      server.identity,
      { ...facts(root), sessionFile: nextFile },
      { callback: async () => false },
    );
    try {
      await old.attach();
      await old.dispose({ kind: "replace", file: nextFile });
      assert.equal(server.participants().length, 1);
      assert.equal(server.participants()[0]?.idle, false);
      await unrelated.attach();
      assert.equal(server.participants().length, 2);
      await replacement.attach();
      assert.ok(!server.participants().some((peer) => peer.id === oldFacts.id));
      assert.ok(!server.liveClients().some((peer) => peer.id === oldFacts.id));
      assert.ok(server.liveClients().some((peer) => peer.sessionFile === nextFile));
      assert.ok(server.participants().some((peer) => peer.sessionFile === nextFile));
      await assert.rejects(
        new DaemonConnection(server.paths, server.identity, oldFacts, { callback: async () => false }).attach(),
        /retired/u,
      );
    } finally {
      await unrelated.dispose();
      await replacement.dispose();
      await server.close();
    }
  }));
