import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  DaemonConnection,
  type DocumentView,
  documentFingerprint,
  ensureDaemon,
  findDaemon,
  stopDaemon,
} from "../dist/index.js";
import { runtimePaths } from "../src/identity.js";

const template = {
  version: 3,
  onSwitch: "ask-before-pull",
  storageConnections: {},
  syncSetups: {},
  future: { preserved: true },
};
async function fixture(
  run: (root: string, connect: (passive?: boolean) => Promise<DaemonConnection>) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-settings-"));
  const clients: DaemonConnection[] = [];
  const connect = async (passive = false) => {
    const daemon = passive ? await findDaemon(root) : await ensureDaemon(root);
    assert.ok(daemon);
    const client = await new DaemonConnection(
      daemon.paths,
      daemon.identity,
      {
        id: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        cwd: root,
        mode: passive ? "json" : "rpc",
        hasUI: !passive,
        idle: !passive,
      },
      {
        callback: async (callback) => {
          if (passive) return false;
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

test("passive settings clients cannot approve handover but can add an exclusion after handover", () =>
  fixture(async (root, connect) => {
    const owner = await connect();
    const editor = await connect(true);
    const file = path.join(root, "pi-sync.json");
    const original = {
      ...template,
      version: 6,
      activeSyncSetup: "home",
      storageConnections: { git: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
      syncSetups: {
        home: {
          storage: { connection: "git", branch: "sync", path: "./" },
          sync: { include: ["settings.json"], exclude: ["skills/private"], automatic: false },
        },
      },
    };
    assert.equal(await editor.run("settings.read", {}), null);
    await assert.rejects(editor.run("settings.cas", { expected: null, next: original }), /not approved/u);
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
    await owner.run("settings.cas", { expected: null, next: original });
    const source = (await editor.run("settings.read", {})) as DocumentView;
    const next = structuredClone(source.parsed) as typeof original;
    next.syncSetups.home.sync.exclude.push("npm", "sessions");
    const proposal = { expected: documentFingerprint(source), next };
    await editor.run("settings.cas", proposal);
    const saved = (await editor.run("settings.read", {})) as DocumentView;
    assert.deepEqual(saved.parsed, next);
    assert.deepEqual(next.syncSetups.home.sync.exclude, ["skills/private", "npm", "sessions"]);
    assert.deepEqual(next.future, original.future);
    await assert.rejects(editor.run("settings.cas", proposal), /Settings changed/u);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), next);
  }));

test("a passive editor can change a preference in an existing ignore-file setup without changing the rule source", () =>
  fixture(async (root, connect) => {
    const file = path.join(await fs.realpath(root), "pi-sync.json");
    const rule = path.join(root, ".syncignore");
    const rules = "/npm/\n";
    const original = {
      ...template,
      version: 8,
      activeSyncSetup: "home",
      storageConnections: { git: { type: "git", remote: "git@example.invalid:owner/sync.git" } },
      syncSetups: {
        home: {
          storage: { connection: "git", branch: "sync", path: "./" },
          sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
        },
      },
    };
    await fs.writeFile(file, JSON.stringify(original), { mode: 0o600 });
    await fs.writeFile(rule, rules);
    const owner = await connect();
    await owner.run("daemon.handover", {});
    const editor = await connect(true);
    const source = (await editor.run("settings.repair-read", {})) as DocumentView;
    assert.equal(source.path, file);
    const next = { ...source.parsed, debug: true };
    await editor.run("settings.cas", { expected: documentFingerprint(source), next });
    const saved = (await editor.run("settings.repair-read", {})) as DocumentView;
    assert.equal(saved.path, file);
    assert.deepEqual(saved.parsed, { ...original, debug: true });
    assert.equal(await fs.readFile(rule, "utf8"), rules);
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

test("an exact source fingerprint does not authorize relabeling an unsupported or invalid document", () =>
  fixture(async (root, connect) => {
    const file = path.join(root, "pi-sync.json");
    const client = await connect();
    for (const [source, error] of [
      [{ ...template, version: 9 }, /Unsupported pi-sync settings/u],
      [{ ...template, debug: "invalid" }, /debug must be boolean/u],
    ] as const) {
      const original = `${JSON.stringify(source)}\n`;
      await fs.writeFile(file, original, { mode: 0o600 });
      const document = (await client.run("settings.repair-read", {})) as DocumentView;
      await assert.rejects(
        client.run("settings.cas", { expected: documentFingerprint(document), next: { ...template, version: 7 } }),
        error,
      );
      assert.equal(await fs.readFile(file, "utf8"), original);
    }
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
