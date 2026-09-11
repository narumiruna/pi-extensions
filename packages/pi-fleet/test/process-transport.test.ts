import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { test } from "vitest";
import { createGroup, type FleetMessage, formatInvite } from "../src/protocol.js";

const posixTest = process.platform === "win32" ? test.skip : test;

class PeerProcess {
  private nextId = 0;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private readonly events: unknown[] = [];
  readonly ready: Promise<void>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    child.stdout.on("data", (chunk) => {
      this.buffer += this.decoder.write(chunk);
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.type === "ready") {
          resolveReady();
          continue;
        }
        if (value.type === "response" && typeof value.id === "string") {
          const request = this.pending.get(value.id);
          if (!request) continue;
          this.pending.delete(value.id);
          clearTimeout(request.timer);
          if (value.ok) request.resolve(value.data);
          else request.reject(new Error(String(value.error)));
          continue;
        }
        this.events.push(value);
      }
    });
    child.once("error", rejectReady);
    child.once("close", (code) => {
      if (code && code !== 0) rejectReady(new Error(`peer exited with ${code}`));
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("peer exited"));
      }
      this.pending.clear();
    });
  }

  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const id = `request-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`peer ${type} timed out`));
      }, 2_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await this.request("stop");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("peer stop timed out")), 2_000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get eventCount(): number {
    return this.events.length;
  }
}

posixTest("separate processes discover, authenticate, deliver once, reject another group, and clean up", async () => {
  const baseDirectory = await mkdtemp("/tmp/pi-fleet-process-test-");
  const fixturePath = compiledFixture("transport-peer-fixture.js");
  const invite = formatInvite(createGroup(Buffer.alloc(32, 13)).secret);
  const otherInvite = formatInvite(createGroup(Buffer.alloc(32, 14)).secret);
  const peers = [
    spawnPeer(fixturePath, baseDirectory, invite, "first"),
    spawnPeer(fixturePath, baseDirectory, invite, "second"),
    spawnPeer(fixturePath, baseDirectory, otherInvite, "outsider"),
  ];
  try {
    await Promise.all(peers.map((peer) => peer.ready));
    const listed = (await peers[0]?.request("list")) as Array<{ sessionId: string }>;
    assert.deepEqual(
      listed.map(({ sessionId }) => sessionId),
      ["second"],
    );
    assert.deepEqual(await peers[2]?.request("list"), []);
    const issuedAt = Date.now();
    const message: FleetMessage = {
      id: "msg_process_123456",
      fromSessionId: "first",
      toSessionId: "second",
      mode: "notify",
      text: "cross-process",
      issuedAt,
      expiresAt: issuedAt + 120_000,
    };
    assert.deepEqual(await peers[0]?.request("send", { targetSessionId: "second", message }), {
      accepted: true,
      duplicate: false,
    });
    assert.equal(await peers[1]?.request("count"), 1);
    assert.deepEqual(await peers[0]?.request("send", { targetSessionId: "second", message }), {
      accepted: true,
      duplicate: true,
    });
    assert.equal(await peers[1]?.request("count"), 1);
    assert.equal(peers[1]?.eventCount, 1);
  } finally {
    await Promise.allSettled(peers.map((peer) => peer.stop()));
    for (const peer of peers) {
      if (peer.child.exitCode === null) peer.child.kill("SIGKILL");
    }
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

function compiledFixture(name: string): string {
  const testHarnessPath = join(process.cwd(), "node_modules/.cache/pi-extensions-test/packages/pi-fleet/test", name);
  if (existsSync(testHarnessPath)) return testHarnessPath;
  execFileSync(
    process.execPath,
    [join(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", "packages/pi-fleet/tsconfig.process-smoke.json"],
    { stdio: "pipe" },
  );
  return join(process.cwd(), "node_modules/.cache/pi-fleet-process/test", name);
}

function spawnPeer(fixturePath: string, baseDirectory: string, invite: string, sessionId: string): PeerProcess {
  const child = spawn(process.execPath, [fixturePath, baseDirectory, invite, sessionId], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("close", (code) => {
    if (code && stderr) process.stderr.write(stderr);
  });
  return new PeerProcess(child);
}
