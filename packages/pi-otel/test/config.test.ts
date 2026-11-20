import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { DEFAULT_BASE_URL, loadSettings, normalizeLangfuseConfig, writeLangfuseConfig } from "../src/config.js";
import { normalizeOtlpConnection } from "../src/otlp-settings.js";

test("loadSettings reads pi-otel.json and enforces private permissions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-config-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-otel.json");
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

  const result = await loadSettings(path);

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

test("loadSettings reports missing and unsafe settings without environment fallbacks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-missing-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-otel.json");

  assert.deepEqual(await loadSettings(path), {
    ok: false,
    path,
    warnings: [],
    missing: true,
    reason: `Configuration file not found: ${path}`,
  });

  await writeFile(path, JSON.stringify({ publicKey: "$LANGFUSE_PUBLIC_KEY", secretKey: "sk" }));
  const invalid = await loadSettings(path);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.reason, /publicKey must be literal/i);
});

test("canonical settings win, and a missing file reads legacy credentials without migration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-otel-legacy-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  t.onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });
  const canonical = join(dir, "pi-otel.json");
  const legacy = join(dir, "pi-langfuse.json");
  assert.equal((await loadSettings()).missing, true);
  assert.deepEqual(await readdir(dir), []);

  const legacyBytes = '{ "publicKey": "pk-old", "secretKey": "sk-old", "future": true }\n';
  await writeFile(legacy, legacyBytes, { mode: 0o644 });
  const fallback = await loadSettings();
  assert.equal(fallback.ok, true);
  assert.equal(fallback.legacy, true);
  assert.equal(fallback.path, legacy);
  assert.deepEqual(await readdir(dir), ["pi-langfuse.json"]);
  assert.equal((await stat(legacy)).mode & 0o777, 0o600);
  assert.equal(await readFile(legacy, "utf8"), legacyBytes);

  await writeFile(canonical, "{broken", { mode: 0o600 });
  const invalid = await loadSettings();
  assert.equal(invalid.ok, false);
  assert.equal(invalid.legacy, undefined);
  assert.equal(invalid.path, canonical);
  assert.equal(await readFile(canonical, "utf8"), "{broken");

  const otlpBytes = JSON.stringify({ backend: "otlp", endpoint: "http://localhost:4318/custom", future: true });
  await writeFile(canonical, otlpBytes);
  assert.deepEqual(await loadSettings(), {
    ok: true,
    path: canonical,
    warnings: [],
    config: {
      backend: "otlp",
      endpoint: "http://localhost:4318/custom",
      headers: {},
      serviceName: "pi",
      captureContent: false,
    },
  });
  await assert.rejects(
    writeLangfuseConfig({ publicKey: "replace", secretKey: "replace" }),
    /invalid recognized fields/u,
  );
  assert.equal(await readFile(canonical, "utf8"), otlpBytes);
  assert.equal(await readFile(legacy, "utf8"), legacyBytes);
});

test("OTLP settings validate URLs and literal headers without exposing the supplied values", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-otel-settings-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-otel.json");
  const defaults = { backend: "otlp", endpoint: "https://receiver.example/v1/traces" };
  const invalid = [
    { endpoint: undefined },
    { endpoint: "grpc://receiver.example" },
    { endpoint: "https://private-marker@receiver.example/v1/traces" },
    { endpoint: "https://receiver.example/v1/traces?private-marker" },
    { endpoint: "https://receiver.example/v1/traces#" },
    { endpoint: "http://receiver.example/v1/traces", headers: { Authorization: "Bearer private-marker" } },
    { headers: [["authorization", "private-marker"]] },
    { headers: { "private-marker:\n": "secret" } },
    { headers: { "x-api-key": "private-marker\r\nInjected: value" } },
    { headers: { "content-type": "private-marker" } },
    { headers: { Authorization: "private-marker", authorization: "duplicate" } },
    { headers: { "x-api-key": 123 } },
    { serviceName: "   " },
    { captureContent: "false" },
    { publicKey: "private-marker", secretKey: "private-marker" },
    { backend: "invalid" },
  ];
  for (const patch of invalid) {
    await writeFile(path, JSON.stringify({ ...defaults, ...patch }));
    const result = await loadSettings(path);
    assert.equal(result.ok, false, JSON.stringify(patch));
    if (!result.ok) assert.doesNotMatch(result.reason, /private-marker/u);
  }
  await writeFile(
    path,
    JSON.stringify({
      ...defaults,
      headers: { Authorization: " Bearer example-token " },
      serviceName: " integration-test ",
      captureContent: true,
      userId: "user-1",
    }),
  );
  const settings = await loadSettings(path);
  assert.deepEqual(settings, {
    ok: true,
    path,
    warnings: [],
    config: {
      ...defaults,
      headers: { authorization: "Bearer example-token" },
      serviceName: "integration-test",
      captureContent: true,
      userId: "user-1",
    },
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("OTLP headers require HTTPS or a literal loopback address", () => {
  const remote = "http://receiver.example/v1/traces";
  assert.deepEqual(normalizeOtlpConnection({ endpoint: remote }).headers, {});
  assert.deepEqual(normalizeOtlpConnection({ endpoint: remote, headers: {} }).headers, {});

  const headers = { Authorization: "Bearer dummy-token" };
  for (const endpoint of [
    "https://receiver.example/v1/traces",
    "http://127.0.0.2/v1/traces",
    "http://[0:0:0:0:0:0:0:1]/v1/traces",
    "http://127.1/v1/traces",
  ]) {
    assert.deepEqual(normalizeOtlpConnection({ endpoint, headers }).headers, { authorization: headers.Authorization });
  }
  for (const endpoint of [
    remote,
    "http://localhost/v1/traces",
    "http://127.example/v1/traces",
    "http://128.0.0.1/v1/traces",
    "http://[::2]/v1/traces",
  ]) {
    assert.throws(
      () => normalizeOtlpConnection({ endpoint, headers }),
      { message: "OTLP headers require HTTPS unless the endpoint uses a loopback IP (127.0.0.0/8 or [::1])." },
      endpoint,
    );
  }
});

test("Langfuse updates preserve unknown fields and refuse malformed files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-update-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-otel.json");
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
  const path = join(dir, "pi-otel.json");
  await writeFile(path, "{broken", { mode: 0o600 });
  const malformed = await loadSettings(path);
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
  const repaired = await loadSettings(path);
  assert.deepEqual(repaired.warnings, [`Restricted ${path} permissions to 0600.`]);
});
