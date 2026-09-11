import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { test } from "vitest";
import { ACCOUNTS_FILE, AccountStore, migrateLegacyCodexAccountsFile, parseAccountsData } from "../src/accounts.js";
import { FileAccountStorageBackend, InMemoryAccountStorageBackend } from "../src/storage.js";

const credential = (suffix: string, extra: Record<string, unknown> = {}) => ({
  type: "oauth" as const,
  access: `access-${suffix}`,
  refresh: `refresh-${suffix}`,
  expires: 2_000_000_000_000,
  ...extra,
});

test("default saves preserve unknown settings fields and credential metadata", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.writeRawForTest(
    JSON.stringify({
      version: 1,
      future: { enabled: true },
      providers: {
        anthropic: {
          future: ["keep"],
          accounts: { work: credential("work", { future: "metadata" }) },
        },
      },
    }),
  );
  await store.updateProvider("anthropic", (state) => ({ ...state, active: "work" }));
  const data = await store.readAsync();
  assert.deepEqual(data.future, { enabled: true });
  assert.deepEqual(data.providers.anthropic?.future, ["keep"]);
  assert.equal(data.providers.anthropic?.accounts.work?.future, "metadata");
  await store.updateProvider("anthropic", (state) => ({ ...state, active: undefined }));
  assert.equal(Object.hasOwn((await store.readAsync()).providers.anthropic ?? {}, "active"), false);
});

test("account reads follow queued default writes and recover after a failed write", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = store.updateProviderAsync("anthropic", async () => {
    await gate;
    return { active: "first", accounts: {} };
  });
  const second = store.updateProvider("anthropic", (state) => ({ ...state, active: "second" }));
  const read = store.readAsync();
  release();
  await Promise.all([first, second]);
  assert.equal((await read).providers.anthropic?.active, "second");
  await assert.rejects(
    store.updateProvider("anthropic", () => {
      throw new Error("write failed");
    }),
    /write failed/,
  );
  assert.equal((await store.readProviderAsync("anthropic")).active, "second");
  await store.updateProvider("anthropic", (state) => ({ ...state, active: undefined }));
  assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
});

test("default saves reject invalid existing documents without replacing them", async () => {
  for (const raw of ["", "  ", "{", "[]", '{"version":1,"providers":{"anthropic":{"active":42,"accounts":{}}}}']) {
    const backend = new InMemoryAccountStorageBackend();
    const store = new AccountStore(backend);
    await store.writeRawForTest(raw);
    await assert.rejects(store.updateProvider("anthropic", (state) => ({ ...state, active: "work" })));
    assert.equal(
      backend.read((value) => value),
      raw,
    );
  }
});

test("default publication failure retains private settings and permits retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-default-failure-"));
  const file = join(dir, ACCOUNTS_FILE);
  try {
    const backend = new FileAccountStorageBackend(file);
    const store = new AccountStore(backend);
    await store.updateProvider("anthropic", () => ({
      active: "work",
      accounts: { work: credential("work") },
    }));
    const before = await readFile(file, "utf8");
    const writer = backend as unknown as { writePrivate(contents: string): void };
    const publish = writer.writePrivate.bind(backend);
    writer.writePrivate = () => {
      throw new Error("publication failed");
    };
    await assert.rejects(
      store.updateProvider("anthropic", (state) => ({ ...state, active: undefined })),
      /publication failed/,
    );
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    writer.writePrivate = publish;
    await store.updateProvider("anthropic", (state) => ({ ...state, active: undefined }));
    assert.equal((await store.readProviderAsync("anthropic")).active, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider-scoped storage preserves independent active accounts and OAuth metadata", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.write({
    version: 1,
    providers: {
      anthropic: {
        active: "work",
        accounts: {
          work: credential("claude", { organization: "acme", optionalMetadata: undefined }),
        },
      },
      "github-copilot": {
        active: "personal",
        accounts: {
          personal: credential("copilot", {
            enterpriseUrl: "github.example.com",
            availableModelIds: ["gpt-4.1", "claude-sonnet-4.5"],
          }),
        },
      },
      "kimi-coding": {
        active: "fast",
        accounts: { fast: credential("kimi") },
      },
      openrouter: {
        active: "router",
        accounts: { router: credential("openrouter", { refresh: "" }) },
      },
      radius: {
        active: "gateway",
        accounts: { gateway: credential("radius", { scope: "gateway offline_access" }) },
      },
      xai: {
        active: "grok",
        accounts: { grok: credential("xai") },
      },
    },
  });

  const stored = await store.readAsync();
  assert.equal(stored.providers.anthropic?.active, "work");
  assert.equal(Object.hasOwn(stored.providers.anthropic?.accounts.work ?? {}, "optionalMetadata"), false);
  assert.equal(stored.providers["github-copilot"]?.active, "personal");
  assert.deepEqual(stored.providers["github-copilot"]?.accounts.personal?.availableModelIds, [
    "gpt-4.1",
    "claude-sonnet-4.5",
  ]);
  assert.equal(stored.providers["github-copilot"]?.accounts.personal?.enterpriseUrl, "github.example.com");
  assert.equal(stored.providers["kimi-coding"]?.accounts.fast?.access, "access-kimi");
  assert.equal(stored.providers.openrouter?.accounts.router?.access, "access-openrouter");
  assert.equal(stored.providers.openrouter?.accounts.router?.refresh, "");
  assert.equal(stored.providers.radius?.accounts.gateway?.access, "access-radius");
  assert.equal(stored.providers.radius?.accounts.gateway?.scope, "gateway offline_access");
  assert.equal(stored.providers.xai?.accounts.grok?.access, "access-xai");
});

test("parsed provider and account maps treat prototype-like names as own properties", () => {
  const parsed = parseAccountsData(
    JSON.stringify({
      version: 1,
      providers: {
        anthropic: {
          active: "constructor",
          accounts: JSON.parse(
            `{"__proto__":{"type":"oauth","access":"a","refresh":"r","expires":1},"constructor":{"type":"oauth","access":"b","refresh":"s","expires":2}}`,
          ),
        },
      },
    }),
  );

  const accounts = parsed.providers.anthropic?.accounts;
  assert.ok(accounts);
  assert.equal(Object.hasOwn(accounts, "__proto__"), true);
  assert.equal(Object.hasOwn(accounts, "constructor"), true);
  const constructorCredential = Object.getOwnPropertyDescriptor(accounts, "constructor")?.value as
    | { access?: string }
    | undefined;
  assert.equal(constructorCredential?.access, "b");
  assert.equal(Object.getPrototypeOf(accounts), null);
  assert.equal(Object.getPrototypeOf(parsed.providers), null);
});

test("storage rejects malformed credentials and non-JSON-safe metadata", async () => {
  assert.throws(
    () =>
      parseAccountsData(
        JSON.stringify({
          version: 1,
          providers: { anthropic: { accounts: { work: { access: "a", expires: 1 } } } },
        }),
      ),
    /missing refresh token/,
  );
  assert.throws(
    () =>
      parseAccountsData(
        JSON.stringify({
          version: 1,
          providers: {
            openrouter: {
              accounts: {
                work: { type: "oauth", access: "a", refresh: null, expires: 1 },
              },
            },
          },
        }),
      ),
    /missing refresh token/,
  );

  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await assert.rejects(
    store.write({
      version: 1,
      providers: {
        anthropic: {
          accounts: {
            work: {
              ...credential("bad"),
              metadata: () => undefined,
            },
          },
        },
      },
    }),
    /not JSON-safe/,
  );
});

test("OpenRouter and Radius storage rejects malformed provider data", () => {
  for (const providerId of ["openrouter", "radius"] as const) {
    assert.throws(
      () =>
        parseAccountsData(
          JSON.stringify({
            version: 1,
            providers: { [providerId]: { active: "work", accounts: [] } },
          }),
        ),
      /accounts must be an object/,
    );
  }
});

test("missing account storage reads as empty without materializing its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-accounts-store-missing-"));
  const agentDir = join(root, "agent");
  const file = join(agentDir, ACCOUNTS_FILE);
  try {
    const store = new AccountStore(new FileAccountStorageBackend(file));
    const loadedSync = store.read();
    const loadedAsync = await store.readAsync();
    assert.equal(loadedSync.version, 1);
    assert.deepEqual(Object.keys(loadedSync.providers), []);
    assert.deepEqual(loadedAsync, loadedSync);
    assert.equal(existsSync(agentDir), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("account storage keeps the previous version's default lock path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-compatible-lock-"));
  const file = join(dir, ACCOUNTS_FILE);
  const legacyLock = `${file}.lock`;
  try {
    await mkdir(legacyLock);
    const backend = new FileAccountStorageBackend(file);
    let entered = false;
    const write = backend.withLockAsync(async () => {
      entered = true;
      return { result: undefined, next: "published" };
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const enteredWhileLegacyLockHeld = entered;
    await rm(legacyLock, { recursive: true });
    await write;

    assert.equal(enteredWhileLegacyLockHeld, false);
    assert.equal(await readFile(file, "utf8"), "published");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync missing account reads wait on an existing default lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-compatible-sync-lock-"));
  const file = join(dir, ACCOUNTS_FILE);
  try {
    await mkdir(`${file}.lock`);
    const backend = new FileAccountStorageBackend(file, { syncLockTimeoutMs: 20 });
    let entered = false;

    assert.throws(
      () =>
        backend.read(() => {
          entered = true;
        }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ELOCKED",
    );
    assert.equal(entered, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing account reads wait for an in-progress first write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-first-write-"));
  const file = join(dir, ACCOUNTS_FILE);
  try {
    const backend = new FileAccountStorageBackend(file);
    let allowWrite: () => void = () => undefined;
    const writeAllowed = new Promise<void>((resolve) => {
      allowWrite = resolve;
    });
    let markWriteEntered: () => void = () => undefined;
    const writeEntered = new Promise<void>((resolve) => {
      markWriteEntered = resolve;
    });
    const write = backend.withLockAsync(async () => {
      markWriteEntered();
      await writeAllowed;
      return { result: undefined, next: "published" };
    });
    await writeEntered;

    let readSettled = false;
    const read = backend
      .readAsync(async (current) => current)
      .finally(() => {
        readSettled = true;
      });
    await new Promise((resolve) => setImmediate(resolve));
    const settledWhileWriteHeld = readSettled;
    allowWrite();
    await write;

    assert.equal(settledWhileWriteHeld, false);
    assert.equal(await read, "published");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("async account reads reject contained lock compromise errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-compromised-read-"));
  const file = join(dir, ACCOUNTS_FILE);
  try {
    await writeFile(file, "published", { mode: 0o600 });
    const backend = new FileAccountStorageBackend(file);
    const lockOwner = backend as unknown as {
      acquireLockAsync(onCompromised?: (error: Error) => void): Promise<() => Promise<void>>;
    };
    lockOwner.acquireLockAsync = (onCompromised) =>
      lockfile.lock(file, {
        realpath: false,
        stale: 2_000,
        update: 1_000,
        ...(onCompromised ? { onCompromised } : {}),
      });
    let markReaderEntered: () => void = () => undefined;
    const readerEntered = new Promise<void>((resolve) => {
      markReaderEntered = resolve;
    });
    const read = backend.readAsync(async () => {
      markReaderEntered();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return "read";
    });
    await readerEntered;
    await rm(`${file}.lock`, { recursive: true });

    await assert.rejects(read, (error: unknown) => {
      return error instanceof Error && "code" in error && error.code === "ECOMPROMISED";
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage creates private files and serializes concurrent updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-"));
  const file = join(dir, ACCOUNTS_FILE);
  try {
    const first = new AccountStore(new FileAccountStorageBackend(file));
    const second = new AccountStore(new FileAccountStorageBackend(file));
    await Promise.all([
      first.update((data) => ({
        ...data,
        providers: {
          ...data.providers,
          anthropic: { active: "work", accounts: { work: credential("work") } },
        },
      })),
      second.update((data) => ({
        ...data,
        providers: {
          ...data.providers,
          "openai-codex": { active: "home", accounts: { home: credential("home") } },
        },
      })),
    ]);

    const stored = await first.readAsync();
    assert.equal(stored.providers.anthropic?.active, "work");
    assert.equal(stored.providers["openai-codex"]?.active, "home");
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage rejects symlinks without reading or changing their targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-symlink-"));
  const target = join(dir, "target.json");
  const file = join(dir, ACCOUNTS_FILE);
  try {
    await writeFile(target, JSON.stringify({ version: 1, providers: {} }), { mode: 0o644 });
    await symlink(target, file);
    const store = new AccountStore(new FileAccountStorageBackend(file));

    await assert.rejects(store.readAsync(), /regular file/);
    assert.equal((await lstat(target)).mode & 0o777, 0o644);
    assert.equal(await readFile(target, "utf8"), JSON.stringify({ version: 1, providers: {} }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage repairs weakened credential permissions on every read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-store-permissions-"));
  const file = join(dir, ACCOUNTS_FILE);
  try {
    const store = new AccountStore(new FileAccountStorageBackend(file));
    await store.write({ version: 1, providers: {} });
    await chmod(file, 0o644);

    await store.readAsync();
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration copies released Codex schema into provider state and retains rollback source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-migrate-"));
  const legacy = join(dir, "pi-codex-accounts.json");
  const canonical = join(dir, ACCOUNTS_FILE);
  try {
    await writeFile(
      legacy,
      JSON.stringify({
        active: "work",
        accounts: { work: credential("work", { accountId: "acct" }) },
      }),
      { mode: 0o644 },
    );
    const result = await migrateLegacyCodexAccountsFile(legacy, canonical);

    assert.equal(result.status, "migrated");
    assert.equal((await lstat(legacy)).mode & 0o777, 0o600);
    assert.equal((await lstat(canonical)).mode & 0o777, 0o600);
    assert.ok((await readFile(legacy, "utf8")).includes("access-work"));
    const migrated = parseAccountsData(await readFile(canonical, "utf8"));
    assert.equal(migrated.providers["openai-codex"]?.active, "work");
    assert.equal(migrated.providers["openai-codex"]?.accounts.work?.accountId, "acct");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent migrations serialize and install one complete canonical file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-concurrent-migration-"));
  const legacy = join(dir, "pi-codex-accounts.json");
  const canonical = join(dir, ACCOUNTS_FILE);
  try {
    await writeFile(legacy, JSON.stringify({ active: "work", accounts: { work: credential("work") } }), {
      mode: 0o600,
    });
    const results = await Promise.all([
      migrateLegacyCodexAccountsFile(legacy, canonical),
      migrateLegacyCodexAccountsFile(legacy, canonical),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["canonical", "migrated"]);
    assert.equal(parseAccountsData(await readFile(canonical, "utf8")).providers["openai-codex"]?.active, "work");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration recovers from stale interrupted temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-interrupted-migration-"));
  const legacy = join(dir, "pi-codex-accounts.json");
  const canonical = join(dir, ACCOUNTS_FILE);
  const staleTemp = join(dir, `.${ACCOUNTS_FILE}.interrupted.tmp`);
  try {
    await writeFile(legacy, JSON.stringify({ active: "work", accounts: { work: credential("work") } }), {
      mode: 0o600,
    });
    await writeFile(staleTemp, "partial secret", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(staleTemp, old, old);

    assert.equal((await migrateLegacyCodexAccountsFile(legacy, canonical)).status, "migrated");
    await assert.rejects(lstat(staleTemp), /ENOENT/);
    assert.equal(parseAccountsData(await readFile(canonical, "utf8")).providers["openai-codex"]?.active, "work");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration rejects symlink credential paths without changing their targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-symlink-"));
  const target = join(dir, "target.json");
  const legacy = join(dir, "pi-codex-accounts.json");
  const canonical = join(dir, ACCOUNTS_FILE);
  try {
    await writeFile(target, JSON.stringify({ active: "old", accounts: { old: credential("old") } }));
    await symlink(target, legacy);
    await assert.rejects(migrateLegacyCodexAccountsFile(legacy, canonical), /regular file/);
    assert.ok((await readFile(target, "utf8")).includes("access-old"));
    await assert.rejects(readFile(canonical, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration gives an existing canonical file precedence without rewriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-precedence-"));
  const legacy = join(dir, "pi-codex-accounts.json");
  const canonical = join(dir, ACCOUNTS_FILE);
  try {
    await writeFile(legacy, JSON.stringify({ active: "old", accounts: { old: credential("old") } }));
    await writeFile(canonical, JSON.stringify({ version: 1, providers: {} }));
    await chmod(canonical, 0o644);

    const result = await migrateLegacyCodexAccountsFile(legacy, canonical);
    assert.equal(result.status, "canonical");
    assert.deepEqual(parseAccountsData(await readFile(canonical, "utf8")), {
      version: 1,
      providers: Object.assign(Object.create(null), {}),
    });
    assert.equal((await lstat(canonical)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
