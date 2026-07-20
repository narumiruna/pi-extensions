import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ACCOUNTS_FILE,
	AccountStore,
	migrateLegacyCodexAccountsFile,
	parseAccountsData,
} from "../src/accounts.js";
import { FileAccountStorageBackend, InMemoryAccountStorageBackend } from "../src/storage.js";

const credential = (suffix: string, extra: Record<string, unknown> = {}) => ({
	type: "oauth" as const,
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: 2_000_000_000_000,
	...extra,
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
		},
	});

	const stored = await store.readAsync();
	assert.equal(stored.providers.anthropic?.active, "work");
	assert.equal(
		Object.hasOwn(stored.providers.anthropic?.accounts.work ?? {}, "optionalMetadata"),
		false,
	);
	assert.equal(stored.providers["github-copilot"]?.active, "personal");
	assert.deepEqual(stored.providers["github-copilot"]?.accounts.personal?.availableModelIds, [
		"gpt-4.1",
		"claude-sonnet-4.5",
	]);
	assert.equal(
		stored.providers["github-copilot"]?.accounts.personal?.enterpriseUrl,
		"github.example.com",
	);
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
		await writeFile(
			legacy,
			JSON.stringify({ active: "work", accounts: { work: credential("work") } }),
			{ mode: 0o600 },
		);
		const results = await Promise.all([
			migrateLegacyCodexAccountsFile(legacy, canonical),
			migrateLegacyCodexAccountsFile(legacy, canonical),
		]);
		assert.deepEqual(results.map((result) => result.status).sort(), ["canonical", "migrated"]);
		assert.equal(
			parseAccountsData(await readFile(canonical, "utf8")).providers["openai-codex"]?.active,
			"work",
		);
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
		await writeFile(
			legacy,
			JSON.stringify({ active: "work", accounts: { work: credential("work") } }),
			{ mode: 0o600 },
		);
		await writeFile(staleTemp, "partial secret", { mode: 0o600 });
		const old = new Date(Date.now() - 60_000);
		await utimes(staleTemp, old, old);

		assert.equal((await migrateLegacyCodexAccountsFile(legacy, canonical)).status, "migrated");
		await assert.rejects(lstat(staleTemp), /ENOENT/);
		assert.equal(
			parseAccountsData(await readFile(canonical, "utf8")).providers["openai-codex"]?.active,
			"work",
		);
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
		await writeFile(
			target,
			JSON.stringify({ active: "old", accounts: { old: credential("old") } }),
		);
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
		await writeFile(
			legacy,
			JSON.stringify({ active: "old", accounts: { old: credential("old") } }),
		);
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
