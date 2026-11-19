import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonConnection, ensureDaemon, stopDaemon } from "../dist/client.js";
import { type DocumentView, documentFingerprint } from "../dist/document.js";
import { runtimePaths } from "../src/identity.js";

const template = {
  version: 3,
  onSwitch: "ask-before-pull",
  storageConnections: {},
  syncSetups: {},
  future: { preserved: true },
};
async function fixture(run: (root: string, connect: () => Promise<DaemonConnection>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-settings-"));
  const clients: DaemonConnection[] = [];
  const connect = async () => {
    const daemon = await ensureDaemon(root);
    const client = await new DaemonConnection(
      daemon.paths,
      daemon.identity,
      {
        id: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        cwd: root,
        mode: "rpc",
        hasUI: true,
        idle: true,
      },
      {
        callback: async (callback) => {
          if (
            callback.kind === "confirm" &&
            (callback.payload as { title?: string }).title === "Adopt pi-sync-daemon as the synchronization owner?"
          )
            return true;
          throw new Error("Unexpected settings approval.");
        },
      },
    ).attach();
    clients.push(client);
    return client;
  };
  try {
    await run(root, connect);
  } finally {
    await Promise.allSettled(clients.map((client) => client.dispose()));
    await stopDaemon(root);
    const paths = await runtimePaths(root);
    await fs.rm(paths.directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("two clients share one authoritative settings writer and preserve unknown fields", () =>
  fixture(async (root, connect) => {
    const first = await connect();
    const second = await connect();
    assert.equal(first.identity.instance, second.identity.instance);
    assert.equal(await first.run("settings.read", {}), null);
    await first.run("settings.cas", { expected: null, next: template });
    await assert.rejects(
      second.run("settings.cas", { expected: null, next: { ...template, debug: true } }),
      /changed/u,
    );
    const source = (await second.run("settings.read", {})) as DocumentView;
    await second.run("settings.cas", {
      expected: documentFingerprint(source),
      next: { ...source.parsed, debug: true },
    });
    const stored = JSON.parse(await fs.readFile(path.join(root, "pi-sync.json"), "utf8"));
    assert.deepEqual(stored.future, { preserved: true });
    assert.equal(stored.debug, true);
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(root, "pi-sync.json"))).mode & 0o077, 0);
  }));

test("repeated canonical saves round-trip exact bytes without temporary files", () =>
  fixture(async (root, connect) => {
    const client = await connect();
    const file = path.join(root, "pi-sync.json");
    await client.run("settings.cas", { expected: null, next: template });
    const before = await fs.readFile(file);
    for (const next of [{ ...template, debug: true }, template]) {
      const source = (await client.run("settings.read", {})) as DocumentView;
      await client.run("settings.cas", { expected: documentFingerprint(source), next });
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), next);
      assert.deepEqual(
        (await fs.readdir(root)).filter((name) => name.startsWith(".pi-sync.json.")),
        [],
      );
    }
    assert.deepEqual(await fs.readFile(file), before);
  }));

test("formatting-only source changes invalidate an exact settings approval", () =>
  fixture(async (root, connect) => {
    const client = await connect();
    await client.run("settings.cas", { expected: null, next: template });
    const document = (await client.run("settings.read", {})) as DocumentView;
    const replacement = `${JSON.stringify(document.parsed)}\n\n`;
    await fs.writeFile(path.join(root, "pi-sync.json"), replacement);
    await assert.rejects(
      client.run("settings.cas", {
        expected: documentFingerprint(document),
        next: { ...document.parsed, debug: true },
      }),
      /changed/u,
    );
    assert.equal(await fs.readFile(path.join(root, "pi-sync.json"), "utf8"), replacement);
  }));

test("invalid existing settings are never replaced by a default or stale save", () =>
  fixture(async (root, connect) => {
    const file = path.join(root, "pi-sync.json");
    await fs.writeFile(file, "{ broken", { mode: 0o600 });
    const client = await connect();
    await assert.rejects(client.run("settings.read", {}));
    await assert.rejects(client.run("settings.cas", { expected: null, next: template }));
    assert.equal(await fs.readFile(file, "utf8"), "{ broken");
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => !name.startsWith(".pi-sync")),
      ["pi-sync.json"],
    );
  }));
