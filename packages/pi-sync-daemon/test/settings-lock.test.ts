import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/settings-writer.mjs", import.meta.url));
const sdk = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
function child(role: string, root: string) {
  const process = fork(fixture, [role, root, sdk], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const inbox: Record<string, unknown>[] = [];
  const waiting = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  let stderr = "";
  let ended = false;
  process.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  process.on("message", (value) => {
    const event = value as Record<string, unknown>;
    const waiter = waiting.get(String(event.event));
    if (waiter) {
      waiting.delete(String(event.event));
      waiter.resolve(event);
    } else inbox.push(event);
  });
  const exited = new Promise<void>((resolve) =>
    process.once("exit", (code) => {
      ended = true;
      for (const waiter of waiting.values()) waiter.reject(new Error(`Fixture exited ${code}: ${stderr}`));
      resolve();
    }),
  );
  return {
    next(event: string): Promise<Record<string, unknown>> {
      const index = inbox.findIndex((value) => value.event === event);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0] as Record<string, unknown>);
      if (ended) return Promise.reject(new Error(`Fixture ended before ${event}: ${stderr}`));
      return new Promise((resolve, reject) => waiting.set(event, { resolve, reject }));
    },
    send(value: Record<string, unknown>) {
      process.send(value);
    },
    async stop() {
      if (!ended && process.connected) process.send({ action: "stop" });
      await exited;
    },
  };
}

test("the actual Pi settings writer refuses a daemon-held lock and preserves the later daemon fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-settings-lock-"));
  const file = path.join(root, "settings.json");
  await fs.writeFile(file, JSON.stringify({ theme: "before" }));
  const writer = child("writer", root);
  let owner: ReturnType<typeof child> | undefined;
  try {
    await writer.next("ready"); // No subprocess timing window starts before readiness.
    owner = child("owner", root);
    await owner.next("held");
    writer.send({ theme: "blocked-local" });
    const blocked = await writer.next("written");
    assert.ok(Array.isArray(blocked.errors) && blocked.errors.length > 0);
    assert.match(String(blocked.errors[0]), /lock/iu);
    assert.deepEqual(JSON.parse(String(blocked.bytes)), { theme: "before" });
    owner.send({ action: "release" });
    await owner.next("released");
    writer.send({ theme: "local" });
    const applied = await writer.next("written");
    assert.deepEqual(applied.errors, []);
    assert.deepEqual(JSON.parse(String(applied.bytes)), { theme: "local", daemonOnly: "preserve" });
  } finally {
    await owner?.stop();
    await writer.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an absent settings file is refused with a retired live client instead of racing Pi's missing-file branch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-missing-settings-"));
  const owner = child("missing", root);
  let writer: ReturnType<typeof child> | undefined;
  try {
    const refused = await owner.next("refused");
    assert.match(String(refused.message), /Cannot create settings.json while a Pi client is alive/u);
    await assert.rejects(fs.access(path.join(root, "settings.json")), { code: "ENOENT" });
    writer = child("writer", root);
    await writer.next("ready");
    writer.send({ theme: "created-through-pi" });
    const result = await writer.next("written");
    assert.deepEqual(result.errors, []);
    assert.equal(JSON.parse(String(result.bytes)).theme, "created-through-pi");
  } finally {
    await writer?.stop();
    await owner.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
