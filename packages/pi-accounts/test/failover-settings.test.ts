import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { AccountStore, InMemoryAccountStorageBackend, type ProviderAccountsData } from "../src/account-store.js";
import { type FailoverSettings, readFailoverSettings, saveFailoverSettings } from "../src/failover-settings.js";
import { FileAccountStorageBackend, type StorageLockResult } from "../src/storage.js";

const credential = { type: "api_key" as const, key: "fixture-only-secret" };
const defaults: FailoverSettings = { enabled: false, accounts: [], minRemainingPercent: 5 };
const policy: FailoverSettings = { enabled: true, accounts: ["primary", "spare"], minRemainingPercent: 5 };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), "accounts-failover-settings-"));
  directories.push(directory);
  return join(directory, "private", "pi-accounts.json");
}
function provider(fallback?: unknown): ProviderAccountsData {
  return {
    active: "primary",
    accounts: { primary: credential, spare: credential, third: credential },
    ...(fallback === undefined ? {} : { fallback }),
  };
}
async function fixture(backend = new InMemoryAccountStorageBackend()) {
  const store = new AccountStore(backend);
  await store.updateProvider("anthropic", () => provider());
  return store;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("absent reads do not create the file, parent, or lock; defaults are detached", async () => {
  const path = temporaryPath();
  const store = new AccountStore(new FileAccountStorageBackend(path));
  const state = (await store.readAsync()).providers.anthropic ?? { accounts: {} };
  const first = readFailoverSettings(state);
  assert.deepEqual(first, { settings: defaults });
  first.settings.accounts.push("changed");
  assert.deepEqual(readFailoverSettings(state), { settings: defaults });
  assert.equal(existsSync(join(path, "..")), false);
  assert.equal(existsSync(`${path}.lock`), false);
  await saveFailoverSettings(store, "anthropic", defaults);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(
    readFailoverSettings((await store.readAsync()).providers.anthropic as ProviderAccountsData).settings,
    defaults,
  );
});

test.each([0, 0.25, 5, 99.999])("threshold %s and ordered one/many backups round trip", async (threshold) => {
  const store = await fixture();
  for (const accounts of [["spare"], ["third", "primary", "spare"]]) {
    const settings = { enabled: true, accounts, minRemainingPercent: threshold };
    await saveFailoverSettings(store, "anthropic", settings);
    assert.deepEqual(readFailoverSettings(await store.readProviderAsync("anthropic")).settings, settings);
  }
  assert.equal((await store.readProviderAsync("anthropic")).active, "primary");
});

test("an omitted threshold defaults to five and returned arrays are detached", () => {
  const state = provider({ enabled: false, accounts: ["spare"] });
  const first = readFailoverSettings(state);
  assert.equal(first.settings.minRemainingPercent, 5);
  first.settings.accounts.reverse();
  first.settings.accounts.push("third");
  assert.deepEqual(readFailoverSettings(state).settings.accounts, ["spare"]);
});

const invalidPolicies: unknown[] = [
  null,
  [],
  true,
  {},
  { enabled: "true", accounts: [] },
  { enabled: false, accounts: "spare" },
  { ...policy, accounts: [" spare"] },
  { ...policy, accounts: ["spare "] },
  { ...policy, accounts: ["default"] },
  { ...policy, accounts: ["spare", "spare"] },
  { ...policy, accounts: ["bad/name"] },
  { ...policy, accounts: [1] },
  { ...policy, accounts: [] },
  ...[-1, 100, Number.NaN, Number.POSITIVE_INFINITY, "5", null].map((value) => ({
    ...policy,
    minRemainingPercent: value,
  })),
];
test.each(invalidPolicies.map((value, index) => ({ value, index })))(
  "invalid optional policy $index disables only the policy",
  ({ value }) => {
    const state = provider(value);
    const result = readFailoverSettings(state);
    assert.deepEqual(result.settings, defaults);
    assert.ok(result.error);
    assert.equal(state.accounts.primary?.key, credential.key);
    assert.equal(result.error?.includes(credential.key), false);
  },
);

test("invalid optional settings do not poison credential reads or get overwritten", async () => {
  const store = await fixture();
  await store.updateProvider("anthropic", () => provider({ enabled: false, accounts: "invalid", future: "keep" }));
  const before = await store.readAsync();
  assert.equal(before.providers.anthropic?.accounts.primary?.key, credential.key);
  assert.ok(readFailoverSettings(before.providers.anthropic as ProviderAccountsData).error);
  await assert.rejects(saveFailoverSettings(store, "anthropic", policy), /Repair/);
  assert.deepEqual(await store.readAsync(), before);
});

test("save preserves unknown fields, credentials, startup default, and other providers", async () => {
  const store = await fixture();
  await store.updateAsync(async (data) => ({
    ...data,
    futureRoot: { preserved: true },
    providers: {
      ...data.providers,
      anthropic: {
        ...provider({ enabled: false, accounts: [], futurePolicy: { keep: [1, 2] } }),
        futureProvider: "keep",
      },
      openai: provider(),
    },
  }));
  const before = await store.readAsync();
  await saveFailoverSettings(store, "anthropic", policy);
  const after = await store.readAsync();
  assert.deepEqual(after.futureRoot, before.futureRoot);
  assert.deepEqual(after.providers.openai, before.providers.openai);
  assert.deepEqual(after.providers.anthropic?.accounts, before.providers.anthropic?.accounts);
  assert.equal(after.providers.anthropic?.active, "primary");
  assert.equal(after.providers.anthropic?.futureProvider, "keep");
  assert.deepEqual(((after.providers.anthropic?.fallback ?? {}) as Record<string, unknown>).futurePolicy, {
    keep: [1, 2],
  });
});

test("missing and cross-provider references are rejected; own-property names remain valid", async () => {
  const store = await fixture();
  await store.updateProvider("openai", () => ({ accounts: { other: credential } }));
  for (const name of ["missing", "other", "constructor", "__proto__"]) {
    await assert.rejects(saveFailoverSettings(store, "anthropic", { ...policy, accounts: [name] }), /no longer exists/);
  }
  await store.updateProvider("anthropic", (state) => ({
    ...state,
    accounts: { ...state.accounts, ["__proto__"]: credential, constructor: credential },
  }));
  const names = ["__proto__", "constructor"];
  await saveFailoverSettings(store, "anthropic", { ...policy, accounts: names });
  assert.deepEqual(readFailoverSettings(await store.readProviderAsync("anthropic")).settings.accounts, names);
  await assert.rejects(saveFailoverSettings(store, "unsupported", defaults), /Unsupported/);
});

test("queued writes and reads use request order, revalidate removals, and detach caller arrays", async () => {
  const store = await fixture();
  const started = deferred();
  const release = deferred();
  const blocker = store.updateProviderAsync("anthropic", async (state) => {
    started.resolve();
    await release.promise;
    return { ...state, futureConcurrent: true, accounts: { primary: credential, spare: credential } };
  });
  await started.promise;
  const settings = { ...policy, accounts: ["spare"] };
  const first = saveFailoverSettings(store, "anthropic", settings);
  settings.accounts.push("caller-edit");
  const missing = saveFailoverSettings(store, "anthropic", { ...policy, accounts: ["third"] });
  const rejection = assert.rejects(missing, /no longer exists/);
  const last = saveFailoverSettings(store, "anthropic", {
    ...policy,
    accounts: ["primary", "spare"],
    minRemainingPercent: 10,
  });
  const read = store.readProviderAsync("anthropic");
  release.resolve();
  await Promise.all([blocker, first, rejection, last]);
  const state = await read;
  assert.deepEqual(readFailoverSettings(state).settings, { ...policy, minRemainingPercent: 10 });
  assert.equal(state.futureConcurrent, true);
});

test("malformed private JSON blocks writes without replacement or temporary artifacts", async () => {
  const path = temporaryPath();
  const store = new AccountStore(new FileAccountStorageBackend(path));
  await saveFailoverSettings(store, "anthropic", defaults);
  writeFileSync(path, "{broken-json", { mode: 0o600 });
  await assert.rejects(saveFailoverSettings(store, "anthropic", defaults), /Invalid accounts JSON/);
  assert.equal(readFileSync(path, "utf8"), "{broken-json");
  assert.deepEqual(readdirSync(join(path, "..")), ["pi-accounts.json"]);
});

test("failed publication keeps previous settings and does not poison the queue", async () => {
  class Backend extends InMemoryAccountStorageBackend {
    fail = false;
    override async withLockAsync<T>(
      mutator: (current: string | undefined) => Promise<StorageLockResult<T>>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (!this.fail) return super.withLockAsync(mutator, signal);
      this.fail = false;
      return super.withLockAsync(async (current) => {
        await mutator(current);
        throw new Error("fixture publication failed");
      }, signal);
    }
  }
  const backend = new Backend();
  const store = await fixture(backend);
  const before = await store.readAsync();
  backend.fail = true;
  await assert.rejects(saveFailoverSettings(store, "anthropic", policy), /publication failed/);
  assert.deepEqual(await store.readAsync(), before);
  await saveFailoverSettings(store, "anthropic", policy);
  assert.deepEqual(readFailoverSettings(await store.readProviderAsync("anthropic")).settings, policy);
});

test.each(["abort", "stale"] as const)("queued %s does not publish settings", async (reason) => {
  const store = await fixture();
  const started = deferred();
  const release = deferred();
  const blocker = store.updateProviderAsync("anthropic", async (state) => {
    started.resolve();
    await release.promise;
    return state;
  });
  await started.promise;
  const controller = new AbortController();
  let current = true;
  const saving = saveFailoverSettings(store, "anthropic", policy, controller.signal, () => current);
  const rejection = assert.rejects(saving, { name: "AbortError" });
  if (reason === "abort") controller.abort();
  else current = false;
  release.resolve();
  await Promise.all([blocker, rejection]);
  assert.deepEqual(readFailoverSettings(await store.readProviderAsync("anthropic")).settings, defaults);
});
