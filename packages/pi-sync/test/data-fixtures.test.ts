import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import * as fixtures from "./data-fixtures.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("snapshot fixtures retain metadata, file order, payloads, and SHA-256 hashes", () => {
  const metadata = {
    version: 1,
    id: "snap",
    createdAt: "2026-01-01T00:00:00.000Z",
    machine: "test",
    profile: "default",
  };
  assert.deepEqual(fixtures.snapshot([]), { ...metadata, files: [] });
  assert.deepEqual(
    fixtures.snapshot([
      { path: "empty", content: Buffer.alloc(0) },
      { path: "nested/abc", content: Buffer.from("abc") },
    ]),
    {
      ...metadata,
      files: [
        {
          path: "empty",
          contentBase64: "",
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        {
          path: "nested/abc",
          contentBase64: "YWJj",
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
      ],
    },
  );
});

test("S3 settings fixtures retain their complete default payload", () => {
  assert.deepEqual(fixtures.v3S3Settings(), {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "ask-before-pull",
    skipSecretScan: false,
    storageConnections: {
      r2: {
        type: "s3",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
        credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
      },
    },
    syncSetups: {
      home: {
        storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/home" },
        sync: { include: ["settings.json"], automatic: false },
      },
    },
  });
});

test("S3 fixture overrides preserve supplied arrays, booleans, and empty strings", () => {
  const include = ["skills"];
  const settings = fixtures.v3S3Settings({ automatic: true, include, path: "", bucket: "", skipSecretScan: true });
  assert.equal(settings.skipSecretScan, true);
  assert.deepEqual(settings.syncSetups.home, {
    storage: { connection: "r2", bucket: "", path: "" },
    sync: { include: ["skills"], automatic: true },
  });
  assert.equal(settings.syncSetups.home.sync.include, include);
  const explicit = fixtures.v3S3Settings({ automatic: false, skipSecretScan: false, include: [] });
  assert.equal(explicit.skipSecretScan, false);
  assert.deepEqual(explicit.syncSetups.home.sync, { include: [], automatic: false });
});

test("WebDAV settings fixtures retain defaults and override semantics", () => {
  assert.deepEqual(fixtures.v3WebDavSettings(), {
    version: 3,
    activeSyncSetup: "home",
    onSwitch: "ask-before-pull",
    storageConnections: {
      dav: {
        type: "webdav",
        url: "https://cloud.example.com/dav",
        credentials: { username: "user", password: "pass" },
      },
    },
    syncSetups: {
      home: {
        storage: { connection: "dav", path: "pi-sync/home" },
        sync: { include: ["settings.json"], automatic: false },
      },
    },
  });
  const include: string[] = [];
  const settings = fixtures.v3WebDavSettings({ automatic: true, include });
  assert.deepEqual(settings.syncSetups.home.sync, { include: [], automatic: true });
  assert.equal(settings.syncSetups.home.sync.include, include);
  assert.equal(fixtures.v3WebDavSettings({ automatic: false }).syncSetups.home.sync.automatic, false);
});

test("legacy backend fixture retains its flat payload", () => {
  assert.deepEqual(fixtures.requiredConfig(), {
    backend: "s3",
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "pi-sync-test",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    extraFiles: [],
  });
});

test("default fixture objects and arrays are independent between calls", () => {
  const s3 = fixtures.v3S3Settings();
  s3.syncSetups.home.sync.include.push("skills");
  s3.storageConnections.r2.credentials.accessKeyId = "changed";
  assert.deepEqual(fixtures.v3S3Settings().syncSetups.home.sync.include, ["settings.json"]);
  assert.equal(fixtures.v3S3Settings().storageConnections.r2.credentials.accessKeyId, "access-key");
  const webdav = fixtures.v3WebDavSettings();
  webdav.syncSetups.home.sync.include.push("skills");
  assert.deepEqual(fixtures.v3WebDavSettings().syncSetups.home.sync.include, ["settings.json"]);
  assert.notEqual(fixtures.requiredConfig().extraFiles, fixtures.requiredConfig().extraFiles);
  assert.notEqual(fixtures.snapshot([]).files, fixtures.snapshot([]).files);
});

test("lifecycle helpers retain compatible data-factory re-exports", async () => {
  const helpers = await import("./helpers.js");
  assert.equal(helpers.snapshot, fixtures.snapshot);
  assert.equal(helpers.v3S3Settings, fixtures.v3S3Settings);
  assert.equal(helpers.v3WebDavSettings, fixtures.v3WebDavSettings);
  assert.equal(helpers.requiredConfig, fixtures.requiredConfig);
});

test("fresh-process data fixtures load only crypto, without Pi or engine-host initialization", () => {
  const url = pathToFileURL(
    path.join(root, "node_modules/.cache/pi-extensions-test/packages/pi-sync/test/data-fixtures.js"),
  ).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { registerHooks } from "node:module";
      const loaded = [];
      registerHooks({ load(url, context, next) {
        if (url !== ${JSON.stringify(url)} && url !== "node:crypto") throw new Error("Unexpected fixture import: " + url);
        loaded.push(url);
        return next(url, context);
      }});
      const fixtures = await import(${JSON.stringify(url)});
      fixtures.snapshot([{ path: "probe", content: Buffer.from("abc") }]);
      fixtures.v3S3Settings();
      fixtures.v3WebDavSettings();
      fixtures.requiredConfig();
      console.log(JSON.stringify(loaded));
      `,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), [url, "node:crypto"]);
});
