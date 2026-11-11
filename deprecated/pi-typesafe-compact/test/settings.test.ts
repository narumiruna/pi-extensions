import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import {
  createTypeSafeCompactSettingsRuntime,
  loadTypeSafeCompactSettings,
  MAX_SETTINGS_BYTES,
  readSettingsTextFromValidatedPath,
} from "../src/settings.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-settings-"));
  roots.push(root);
  return join(root, "agent", "pi-typesafe-compact.json");
}

test("missing loads are side-effect free and first save creates a private file", async () => {
  const path = await fixturePath();
  const state = await loadTypeSafeCompactSettings(path);
  assert.equal(state.kind, "missing");
  await assert.rejects(lstat(dirname(path)), /ENOENT/u);

  const runtime = createTypeSafeCompactSettingsRuntime(path);
  await runtime.setApiKey("  secret-value  ");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { apiKey: "secret-value" });
  if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test("saves preserve unknown fields, serialize in request order, and remove only the key", async () => {
  const path = await fixturePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"future":{"enabled":true},"apiKey":"old"}\n', { mode: 0o600 });
  const runtime = createTypeSafeCompactSettingsRuntime(path);
  await runtime.reload();
  const first = runtime.setApiKey("first");
  const second = runtime.setApiKey("second");
  await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    future: { enabled: true },
    apiKey: "second",
  });

  await runtime.removeApiKey();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { future: { enabled: true } });
  assert.equal(runtime.get().settings.apiKey, undefined);
});

test("malformed, invalid, oversized, and symlinked settings remain invalid and unchanged", async () => {
  const malformed = await fixturePath();
  await mkdir(dirname(malformed), { recursive: true });
  const malformedSecret = "super-secret-settings-value";
  await writeFile(malformed, malformedSecret, "utf8");
  const malformedRuntime = createTypeSafeCompactSettingsRuntime(malformed);
  const malformedState = await malformedRuntime.reload();
  assert.equal(malformedState.kind, "invalid");
  assert.match(malformedState.issue ?? "", /malformed JSON/u);
  assert.doesNotMatch(malformedState.issue ?? "", new RegExp(malformedSecret, "u"));
  await assert.rejects(malformedRuntime.setApiKey("new-secret"), /Cannot overwrite an invalid/u);
  assert.equal(await readFile(malformed, "utf8"), malformedSecret);

  const invalid = await fixturePath();
  await mkdir(dirname(invalid), { recursive: true });
  await writeFile(invalid, '{"apiKey":"   "}\n', "utf8");
  assert.equal((await loadTypeSafeCompactSettings(invalid)).kind, "invalid");

  const oversized = await fixturePath();
  await mkdir(dirname(oversized), { recursive: true });
  await writeFile(oversized, "x".repeat(MAX_SETTINGS_BYTES + 1), "utf8");
  assert.match((await loadTypeSafeCompactSettings(oversized)).issue ?? "", /exceeds 64 KiB/u);

  const target = await fixturePath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, '{"apiKey":"target-secret"}\n', "utf8");
  const link = join(dirname(target), "linked.json");
  await symlink(target, link);
  const linked = await loadTypeSafeCompactSettings(link);
  assert.equal(linked.kind, "invalid");
  assert.match(linked.issue ?? "", /symbolic links/u);
});

test("invalid UTF-8 settings remain invalid and byte-for-byte unchanged", async () => {
  const path = await fixturePath();
  await mkdir(dirname(path), { recursive: true });
  const original = Buffer.concat([
    Buffer.from('{"future":"', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('","apiKey":"stored-secret"}\n', "utf8"),
  ]);
  await writeFile(path, original, { mode: 0o600 });

  const runtime = createTypeSafeCompactSettingsRuntime(path);
  const state = await runtime.reload();
  assert.equal(state.kind, "invalid");
  assert.match(state.issue ?? "", /not valid UTF-8/u);
  await assert.rejects(runtime.setApiKey("replacement-secret"), /Cannot overwrite an invalid/u);
  assert.deepEqual(await readFile(path), original);
});

test.runIf(process.platform !== "win32")("non-regular settings paths are rejected without blocking", async () => {
  const path = await fixturePath();
  await mkdir(dirname(path), { recursive: true });
  await execFileAsync("mkfifo", [path]);

  const state = await loadTypeSafeCompactSettings(path);
  assert.equal(state.kind, "invalid");
  assert.match(state.issue ?? "", /not a regular file/u);
  await assert.rejects(readSettingsTextFromValidatedPath(path), /not a regular file/u);
});

test("oversized serialized saves preserve the previous file and effective state", async () => {
  const path = await fixturePath();
  await mkdir(dirname(path), { recursive: true });
  const emptyDocumentBytes = Buffer.byteLength(JSON.stringify({ future: "" }), "utf8");
  const padding = "x".repeat(MAX_SETTINGS_BYTES - emptyDocumentBytes - 1);
  const original = `${JSON.stringify({ future: padding })}\n`;
  assert.equal(Buffer.byteLength(original, "utf8"), MAX_SETTINGS_BYTES);
  await writeFile(path, original, { mode: 0o600 });

  const runtime = createTypeSafeCompactSettingsRuntime(path);
  assert.equal((await runtime.reload()).kind, "loaded");
  const previousState = runtime.get();
  await assert.rejects(runtime.setApiKey("new-secret"), /exceed 64 KiB/u);

  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(runtime.get(), previousState);
  assert.deepEqual(await readdir(dirname(path)), ["pi-typesafe-compact.json"]);
});

test("invalid API keys and aborted writes never replace the previous settings", async () => {
  const path = await fixturePath();
  const runtime = createTypeSafeCompactSettingsRuntime(path);
  await runtime.setApiKey("old-secret");
  await assert.rejects(runtime.setApiKey("bad\nsecret"), /non-empty/u);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.setApiKey("new-secret", controller.signal), /aborted/u);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { apiKey: "old-secret" });
  assert.equal(runtime.get().settings.apiKey, "old-secret");
});

test.runIf(process.platform !== "win32")(
  "a failed atomic write preserves the previous file and effective state",
  async () => {
    const path = await fixturePath();
    const runtime = createTypeSafeCompactSettingsRuntime(path);
    await runtime.setApiKey("old-secret");
    await chmod(dirname(path), 0o500);
    try {
      await assert.rejects(runtime.setApiKey("new-secret"), /EACCES|permission denied/iu);
    } finally {
      await chmod(dirname(path), 0o700);
    }
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { apiKey: "old-secret" });
    assert.equal(runtime.get().settings.apiKey, "old-secret");
  },
);
