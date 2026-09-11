import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { DEFAULT_BASE_URL, loadLangfuseConfig, normalizeLangfuseConfig, writeLangfuseConfig } from "../src/config.js";

test("loadLangfuseConfig reads pi-langfuse.json and enforces private permissions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-config-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-langfuse.json");
  await writeFile(
    path,
    JSON.stringify({
      publicKey: "pk-from-file",
      secretKey: "sk-from-file",
      baseUrl: "http://self-hosted.example/",
      environment: "test",
      release: "v1",
      captureContent: false,
    }),
    { mode: 0o644 },
  );

  const result = await loadLangfuseConfig(path);

  assert.deepEqual(result, {
    ok: true,
    config: {
      publicKey: "pk-from-file",
      secretKey: "sk-from-file",
      baseUrl: "http://self-hosted.example",
      environment: "test",
      release: "v1",
      captureContent: false,
    },
    path,
    warnings: [`Restricted ${path} permissions to 0600.`],
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("loadLangfuseConfig reports missing and unsafe settings without environment fallbacks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-missing-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-langfuse.json");

  assert.deepEqual(await loadLangfuseConfig(path), {
    ok: false,
    path,
    warnings: [],
    reason: `Configuration file not found: ${path}`,
  });

  await writeFile(path, JSON.stringify({ publicKey: "$LANGFUSE_PUBLIC_KEY", secretKey: "sk" }));
  const invalid = await loadLangfuseConfig(path);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.reason, /publicKey must be literal/i);
});

test("Langfuse updates preserve unknown fields and refuse malformed files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-update-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-langfuse.json");
  await writeFile(path, JSON.stringify({ publicKey: "old-pk", secretKey: "old-sk", future: { kept: true } }), {
    mode: 0o600,
  });
  await writeLangfuseConfig(
    {
      publicKey: "new-pk",
      secretKey: "new-sk",
      baseUrl: "https://us.cloud.langfuse.com",
      captureContent: false,
    },
    path,
  );
  const updated = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(updated.future, { kept: true });
  assert.equal(updated.secretKey, "new-sk");
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writeFile(
    path,
    JSON.stringify({
      ...updated,
      secretKey: "rotated-sk",
      environment: "concurrent",
      release: "v2",
      captureContent: false,
    }),
    { mode: 0o600 },
  );
  await writeLangfuseConfig({ baseUrl: "https://updated.example" }, path);
  const patched = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(patched.secretKey, "rotated-sk");
  assert.equal(patched.environment, "concurrent");
  assert.equal(patched.release, "v2");
  assert.equal(patched.captureContent, false);

  const malformed = '{"publicKey":"secret-marker"';
  await writeFile(path, malformed, { mode: 0o600 });
  await assert.rejects(
    writeLangfuseConfig(
      {
        publicKey: "replacement",
        secretKey: "replacement-secret",
        baseUrl: "https://us.cloud.langfuse.com",
        captureContent: true,
      },
      path,
    ),
    /invalid|read|repair/i,
  );
  assert.equal(await readFile(path, "utf8"), malformed);

  await writeFile(path, JSON.stringify({ publicKey: "repair", secretKey: "repair-secret", future: 2 }), {
    mode: 0o600,
  });
  const first = writeLangfuseConfig(
    {
      publicKey: "first",
      secretKey: "first-secret",
      baseUrl: DEFAULT_BASE_URL,
      captureContent: true,
    },
    path,
  );
  const second = writeLangfuseConfig(
    {
      publicKey: "second",
      secretKey: "second-secret",
      baseUrl: DEFAULT_BASE_URL,
      captureContent: false,
    },
    path,
  );
  await Promise.all([first, second]);
  const final = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(final.publicKey, "second");
  assert.equal(final.future, 2);
});

test("configuration covers malformed JSON, normalization, and captureContent false", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-invalid-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-langfuse.json");
  await writeFile(path, "{broken", { mode: 0o600 });
  const malformed = await loadLangfuseConfig(path);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.match(malformed.reason, /failed to parse/i);
    assert.doesNotMatch(malformed.reason, /broken/);
  }

  assert.deepEqual(normalizeLangfuseConfig({ publicKey: " pk ", secretKey: " sk ", baseUrl: "https://x.test///" }), {
    ok: true,
    config: {
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://x.test",
      captureContent: true,
    },
  });
  for (const baseUrl of [
    "ftp://x",
    "https://user:password@x.test",
    "https://x.test?token=private",
    "https://x.test#private",
  ]) {
    assert.equal(normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", baseUrl }).ok, false, baseUrl);
  }
  assert.deepEqual(normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", captureContent: false }), {
    ok: true,
    config: {
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://us.cloud.langfuse.com",
      captureContent: false,
    },
  });

  for (const environment of ["dev", "qa_2", "a".repeat(40)]) {
    const normalized = normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", environment });
    assert.equal(normalized.ok, true, environment);
  }
  for (const environment of ["Production", "with space", "langfuse", "langfuse-prod", "a".repeat(41)]) {
    const normalized = normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", environment });
    assert.equal(normalized.ok, false, environment);
    if (!normalized.ok) assert.match(normalized.reason, /environment/i);
  }

  assert.deepEqual(normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", userId: "  analyst-7  " }), {
    ok: true,
    config: {
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://us.cloud.langfuse.com",
      userId: "analyst-7",
      captureContent: true,
    },
  });
  for (const userId of ["", "   ", 7, null]) {
    const normalized = normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", userId });
    assert.equal(normalized.ok, false, String(userId));
    if (!normalized.ok) assert.match(normalized.reason, /userId/i);
  }
  const maxLengthUserId = "u".repeat(200);
  assert.deepEqual(normalizeLangfuseConfig({ publicKey: "pk", secretKey: "sk", userId: maxLengthUserId }), {
    ok: true,
    config: {
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://us.cloud.langfuse.com",
      userId: maxLengthUserId,
      captureContent: true,
    },
  });
  const tooLongUserId = normalizeLangfuseConfig({
    publicKey: "pk",
    secretKey: "sk",
    userId: "u".repeat(201),
  });
  assert.equal(tooLongUserId.ok, false);
  if (!tooLongUserId.ok) assert.match(tooLongUserId.reason, /userId must be at most 200 characters/);

  await writeFile(path, JSON.stringify({ publicKey: "pk", secretKey: "sk" }), { mode: 0o600 });
  await chmod(path, 0o644);
  const repaired = await loadLangfuseConfig(path);
  assert.deepEqual(repaired.warnings, [`Restricted ${path} permissions to 0600.`]);
});
