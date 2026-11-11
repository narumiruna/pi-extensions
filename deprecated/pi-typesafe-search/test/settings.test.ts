import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { loadSettings } from "../src/settings.js";

async function withTempDirectory(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-jev-settings-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("settings loading is side-effect free and accepts a private API key file", async () => {
  await withTempDirectory(async (directory) => {
    const settingsPath = path.join(directory, "pi-typesafe-search.json");
    assert.deepEqual(await loadSettings(settingsPath), { kind: "missing", path: settingsPath });

    await writeFile(settingsPath, '{"apiKey":"  secret-key  ","future":true}\n', { mode: 0o600 });
    assert.deepEqual(await loadSettings(settingsPath), {
      kind: "loaded",
      path: settingsPath,
      settings: { apiKey: "secret-key" },
    });
  });
});

test("settings reject malformed, invalid, oversized, non-regular, and symlink paths without leaking content", async () => {
  await withTempDirectory(async (directory) => {
    const settingsPath = path.join(directory, "settings.json");
    await writeFile(settingsPath, "{secret-key", { mode: 0o600 });
    const malformed = await loadSettings(settingsPath);
    assert.equal(malformed.kind, "invalid");
    assert.doesNotMatch(malformed.kind === "invalid" ? malformed.reason : "", /secret-key/);

    await writeFile(settingsPath, '{"apiKey":""}', { mode: 0o600 });
    assert.match(((await loadSettings(settingsPath)) as { reason: string }).reason, /non-empty string/);

    await writeFile(settingsPath, JSON.stringify({ apiKey: "x".repeat(4_097) }), { mode: 0o600 });
    assert.match(((await loadSettings(settingsPath)) as { reason: string }).reason, /4096 characters/);

    await writeFile(settingsPath, "x".repeat(70 * 1024), { mode: 0o600 });
    assert.match(((await loadSettings(settingsPath)) as { reason: string }).reason, /exceeds/);

    await rm(settingsPath);
    await mkdir(settingsPath);
    assert.match(((await loadSettings(settingsPath)) as { reason: string }).reason, /regular file/);

    await rm(settingsPath, { recursive: true });
    const target = path.join(directory, "target.json");
    await writeFile(target, '{"apiKey":"secret-key"}', { mode: 0o600 });
    await symlink(target, settingsPath);
    assert.match(((await loadSettings(settingsPath)) as { reason: string }).reason, /symbolic link/);
  });
});

test("settings require private POSIX permissions", async () => {
  if (process.platform === "win32") return;
  await withTempDirectory(async (directory) => {
    const settingsPath = path.join(directory, "settings.json");
    await writeFile(settingsPath, '{"apiKey":"secret-key"}', { mode: 0o600 });
    await chmod(settingsPath, 0o644);
    assert.match(((await loadSettings(settingsPath)) as { reason: string }).reason, /chmod 600/);
  });
});
