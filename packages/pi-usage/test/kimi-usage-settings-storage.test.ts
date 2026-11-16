import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import {
  createUsageSettingsRuntime,
  DEFAULT_USAGE_SETTINGS,
  loadUsageSettings,
  MAX_USAGE_SETTINGS_BYTES,
  normalizeUsageSettings,
} from "../src/settings.js";

const roots: string[] = [];

async function tempSettingsPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kimi-usage-settings-storage-"));
  roots.push(root);
  return join(root, "pi-usage.json");
}

async function assertPrivate(path: string): Promise<void> {
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Kimi usage credentials are optional without changing the default settings shape", () => {
  assert.equal(Object.hasOwn(DEFAULT_USAGE_SETTINGS, "kimiCodingUsageApiKey"), false);
  assert.deepEqual(normalizeUsageSettings({}), DEFAULT_USAGE_SETTINGS);
  for (const blank of ["", " ", "\t\r\n\v\f", "\u00a0\u2003"]) {
    const document = { kimiCodingUsageApiKey: blank };
    const normalized = normalizeUsageSettings(document);
    assert.deepEqual(normalized, DEFAULT_USAGE_SETTINGS);
    assert.equal(Object.hasOwn(normalized ?? {}, "kimiCodingUsageApiKey"), false);
    assert.deepEqual(document, { kimiCodingUsageApiKey: blank });
  }
});

test("Kimi usage credentials trim surrounding whitespace and accept provider-neutral printable ASCII tokens", () => {
  const printableAsciiToken = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).join("");
  for (const token of ["proxy-token", "key/v2:abc_~.-+=", printableAsciiToken]) {
    const document = { kimiCodingUsageApiKey: ` \t\r\n${token}\n `, future: { keep: true } };
    assert.deepEqual(normalizeUsageSettings(document), { ...DEFAULT_USAGE_SETTINGS, kimiCodingUsageApiKey: token });
    assert.equal(document.kimiCodingUsageApiKey, ` \t\r\n${token}\n `);
    assert.deepEqual(document.future, { keep: true });
  }
});

for (const value of [undefined, null, false, true, 0, 1, [], {}]) {
  test(`Kimi usage credentials reject a present nonstring ${JSON.stringify(value)}`, () => {
    assert.equal(normalizeUsageSettings({ kimiCodingUsageApiKey: value }), undefined);
  });
}

test("Kimi usage credentials reject internal whitespace, controls, DEL, and non-ASCII characters", () => {
  const invalidCharacters = [
    ...Array.from({ length: 33 }, (_, index) => String.fromCharCode(index)),
    "\x7f",
    "\x80",
    "\u00a0",
    "\u2003",
    "\u200b",
    "é",
    "🔑",
  ];
  for (const character of invalidCharacters) {
    assert.equal(normalizeUsageSettings({ kimiCodingUsageApiKey: `before${character}after` }), undefined);
  }
  for (const value of ["\0token", "token\0", "\x1btoken", "token\x7f"]) {
    assert.equal(normalizeUsageSettings({ kimiCodingUsageApiKey: value }), undefined);
  }
});

test("missing Kimi usage settings do not create a file, parent directory, or undefined property", async () => {
  const path = join(dirname(await tempSettingsPath()), "absent", "pi-usage.json");
  const runtime = createUsageSettingsRuntime(path);
  assert.deepEqual(runtime.get().settings, DEFAULT_USAGE_SETTINGS);
  const loaded = await loadUsageSettings(path);
  const reloaded = await runtime.reload();
  await runtime.flush();
  for (const state of [loaded, reloaded]) {
    assert.equal(state.kind, "missing");
    assert.deepEqual(state.settings, DEFAULT_USAGE_SETTINGS);
    assert.equal(Object.hasOwn(state.settings, "kimiCodingUsageApiKey"), false);
  }
  assert.deepEqual(await readdir(dirname(dirname(path))), []);
});

test("JSON loads normalize blank and padded credentials without rewriting the source document", async () => {
  const path = await tempSettingsPath();
  for (const [raw, expected] of [
    [undefined, undefined],
    ["", undefined],
    [" \t\n", undefined],
    [" \tproxy-token\r\n ", "proxy-token"],
  ] as const) {
    const document = raw === undefined ? { future: "kept" } : { future: "kept", kimiCodingUsageApiKey: raw };
    const bytes = `${JSON.stringify(document)}\n`;
    await writeFile(path, bytes);
    const loaded = await loadUsageSettings(path);
    assert.equal(loaded.kind, "loaded");
    assert.equal(loaded.settings.kimiCodingUsageApiKey, expected);
    assert.equal(Object.hasOwn(loaded.settings, "kimiCodingUsageApiKey"), expected !== undefined);
    assert.deepEqual(loaded.document, document);
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
  }
});

test("first save, replacement, and clear publish private canonical JSON and preserve unrelated fields", async () => {
  const path = join(dirname(await tempSettingsPath()), "created", "pi-usage.json");
  const runtime = createUsageSettingsRuntime(path);
  await runtime.update({ kimiCodingUsageApiKey: " \tfirst-token\n " });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { kimiCodingUsageApiKey: "first-token" });
  assert.equal(runtime.get().settings.kimiCodingUsageApiKey, "first-token");
  await assertPrivate(path);
  if (process.platform !== "win32") assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);

  const unrelated = { future: { keep: [1, "two"] }, codexFastMode: true, xaiUsage: false };
  await writeFile(path, JSON.stringify({ ...unrelated, kimiCodingUsageApiKey: "first-token" }));
  if (process.platform !== "win32") await chmod(path, 0o644);
  await runtime.update({ kimiCodingUsageApiKey: " second-token " });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...unrelated, kimiCodingUsageApiKey: "second-token" });
  assert.equal(runtime.get().settings.codexFastMode, true);
  await assertPrivate(path);

  await runtime.update({ kimiCodingUsageApiKey: undefined });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), unrelated);
  assert.equal(Object.hasOwn(runtime.get().settings, "kimiCodingUsageApiKey"), false);
  assert.equal(Object.hasOwn((await runtime.reload()).settings, "kimiCodingUsageApiKey"), false);
  await assertPrivate(path);
  assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
});

test("blank credential saves remove the field while preserving unknown settings and private permissions", async () => {
  const path = await tempSettingsPath();
  const runtime = createUsageSettingsRuntime(path);
  for (const blank of ["", " \t\r\n"]) {
    await writeFile(path, JSON.stringify({ future: "kept", kimiCodingUsageApiKey: "old-token" }));
    await runtime.update({ kimiCodingUsageApiKey: blank });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { future: "kept" });
    assert.equal(Object.hasOwn(runtime.get().settings, "kimiCodingUsageApiKey"), false);
    await assertPrivate(path);
  }
});

test("queued credential saves and reloads observe publication order rather than stale snapshots", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, JSON.stringify({ future: "kept", kimiCodingUsageApiKey: "old-token" }));
  let releasePublication!: () => void;
  const publicationGate = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    publicationStarted = resolve;
  });
  let publications = 0;
  const runtime = createUsageSettingsRuntime({
    path,
    operations: {
      rename: async (from, to) => {
        if (publications++ === 0) {
          publicationStarted();
          await publicationGate;
        }
        await rename(from, to);
      },
    },
  });
  await runtime.reload();
  const first = runtime.update({ kimiCodingUsageApiKey: " first-token " });
  const firstReload = runtime.reload();
  const second = runtime.update({ kimiCodingUsageApiKey: "second-token" });
  const secondReload = runtime.reload();
  try {
    await started;
    assert.equal(runtime.get().settings.kimiCodingUsageApiKey, "old-token");
    assert.equal(JSON.parse(await readFile(path, "utf8")).kimiCodingUsageApiKey, "old-token");
  } finally {
    releasePublication();
    await runtime.flush();
  }
  assert.equal((await first).settings.kimiCodingUsageApiKey, "first-token");
  assert.equal((await firstReload).settings.kimiCodingUsageApiKey, "first-token");
  assert.equal((await second).settings.kimiCodingUsageApiKey, "second-token");
  assert.equal((await secondReload).settings.kimiCodingUsageApiKey, "second-token");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { future: "kept", kimiCodingUsageApiKey: "second-token" });
  await assertPrivate(path);
  assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
});

for (const failure of ["write", "rename"] as const) {
  test(`credential ${failure} failure retains prior bytes and runtime state, cleans up, and permits reload and retry`, async () => {
    const path = await tempSettingsPath();
    const previous = `${JSON.stringify({ future: "kept", kimiCodingUsageApiKey: "old-token" })}\n`;
    await writeFile(path, previous, { mode: 0o600 });
    let fail = true;
    const runtime = createUsageSettingsRuntime({
      path,
      operations: {
        writeFile: async (destination, data, options) => {
          await writeFile(destination, data, options);
          if (fail && failure === "write") throw new Error("synthetic write failure");
        },
        rename: async (from, to) => {
          if (fail && failure === "rename") throw new Error("synthetic rename failure");
          await rename(from, to);
        },
      },
    });
    await runtime.reload();
    await assert.rejects(runtime.update({ kimiCodingUsageApiKey: "new-token" }), /synthetic .* failure/);
    assert.equal(runtime.get().settings.kimiCodingUsageApiKey, "old-token");
    assert.equal(await readFile(path, "utf8"), previous);
    await assertPrivate(path);
    assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
    assert.equal((await runtime.reload()).settings.kimiCodingUsageApiKey, "old-token");

    fail = false;
    await runtime.update({ kimiCodingUsageApiKey: "new-token" });
    assert.equal((await runtime.reload()).settings.kimiCodingUsageApiKey, "new-token");
    await runtime.update({ kimiCodingUsageApiKey: undefined });
    await runtime.flush();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { future: "kept" });
    await assertPrivate(path);
  });
}

test("invalid credential patches cannot change a valid file or poison subsequent saves", async () => {
  const path = await tempSettingsPath();
  const previous = JSON.stringify({ future: "kept", kimiCodingUsageApiKey: "old-token" });
  await writeFile(path, previous, { mode: 0o600 });
  const runtime = createUsageSettingsRuntime(path);
  await runtime.reload();
  for (const invalid of ["two tokens", "bad\0token", "non-ASCII-é"]) {
    await assert.rejects(runtime.update({ kimiCodingUsageApiKey: invalid }), /Refusing to save invalid/);
    assert.equal(await readFile(path, "utf8"), previous);
    assert.equal(runtime.get().settings.kimiCodingUsageApiKey, "old-token");
  }
  await runtime.update({ kimiCodingUsageApiKey: "new-token" });
  assert.equal(runtime.get().settings.kimiCodingUsageApiKey, "new-token");
  assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
});

test("invalid credential files block both replacement and clear without exposing their contents", async () => {
  const path = await tempSettingsPath();
  const secret = "fixture-secret-not-for-errors";
  for (const invalid of [null, false, 42, [], {}, `${secret} with-space`, `${secret}\x1b`, `${secret}é`]) {
    const bytes = JSON.stringify({ future: "kept", kimiCodingUsageApiKey: invalid });
    await writeFile(path, bytes);
    const runtime = createUsageSettingsRuntime(path);
    const loaded = await runtime.reload();
    assert.equal(loaded.kind, "invalid");
    assert.equal(loaded.issue, "invalid settings shape");
    assert.deepEqual(loaded.settings, DEFAULT_USAGE_SETTINGS);
    assert.equal(JSON.stringify(loaded).includes(secret), false);
    for (const replacement of ["new-token", undefined]) {
      await assert.rejects(runtime.update({ kimiCodingUsageApiKey: replacement }), /Cannot overwrite an invalid/);
      assert.equal(await readFile(path, "utf8"), bytes);
    }
    assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
  }
});

test("an oversized first credential save cannot create an unreadable settings file", async () => {
  const path = await tempSettingsPath();
  const runtime = createUsageSettingsRuntime(path);
  const oversized = "k".repeat(MAX_USAGE_SETTINGS_BYTES);
  await assert.rejects(runtime.update({ kimiCodingUsageApiKey: oversized }), /larger than 64 KiB/u);
  assert.equal(runtime.get().kind, "missing");
  assert.deepEqual(await readdir(dirname(path)), []);
  await runtime.update({ kimiCodingUsageApiKey: "retry-key" });
  assert.equal((await runtime.reload()).settings.kimiCodingUsageApiKey, "retry-key");
  await assertPrivate(path);
});

test("the serialized UTF-8 size limit preserves near-limit unknown fields and prior credentials", async () => {
  const path = await tempSettingsPath();
  const document = { future: "é".repeat(28_000), kimiCodingUsageApiKey: "prior-key" };
  const bytes = JSON.stringify(document);
  await writeFile(path, bytes, { mode: 0o600 });
  const runtime = createUsageSettingsRuntime(path);
  await runtime.reload();
  const oversized = "k".repeat(10_000);
  assert.ok(JSON.stringify({ ...document, kimiCodingUsageApiKey: oversized }).length < MAX_USAGE_SETTINGS_BYTES);
  await assert.rejects(runtime.update({ kimiCodingUsageApiKey: oversized }), /larger than 64 KiB/u);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal(runtime.get().settings.kimiCodingUsageApiKey, "prior-key");
  assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
  await runtime.update({ kimiCodingUsageApiKey: "retry-key" });
  assert.equal((await runtime.reload()).settings.kimiCodingUsageApiKey, "retry-key");
  assert.equal(JSON.parse(await readFile(path, "utf8")).future, document.future);
  await assertPrivate(path);
});

test("malformed JSON returns only a fixed safe parse issue and never echoes fixture secrets", async () => {
  const path = await tempSettingsPath();
  const secret = "fixture-secret-parser-must-not-echo";
  const malformedDocuments = [
    secret,
    `{"kimiCodingUsageApiKey":"${secret}",}`,
    `{"kimiCodingUsageApiKey":"${secret}`,
    `{"future":"${secret}","kimiCodingUsageApiKey":@}`,
    `{"kimiCodingUsageApiKey":"${secret}","future":\x1b}`,
  ];
  for (const bytes of malformedDocuments) {
    await writeFile(path, bytes);
    const runtime = createUsageSettingsRuntime(path);
    for (const loaded of [await loadUsageSettings(path), await runtime.reload()]) {
      assert.equal(loaded.kind, "invalid");
      assert.equal(loaded.issue, "invalid settings JSON");
      assert.equal(JSON.stringify(loaded).includes(secret), false);
      assert.deepEqual(loaded.settings, DEFAULT_USAGE_SETTINGS);
      assert.equal(loaded.document, undefined);
    }
    await assert.rejects(runtime.update({ kimiCodingUsageApiKey: "new-token" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot overwrite an invalid/);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.deepEqual(await readdir(dirname(path)), ["pi-usage.json"]);
  }
});
