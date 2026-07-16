import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import codexAccounts, {
	CODEX_ACCOUNTS_FILE,
	CodexAccountStore,
	ensureActiveCodexAuth,
} from "../src/codex-accounts.js";
import {
	FileCodexAccountStorageBackend as FileAuthStorageBackend,
	InMemoryCodexAccountStorageBackend as InMemoryAuthStorageBackend,
} from "../src/storage.js";

const validCred = (suffix = "") => ({
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: Date.now() + 60 * 60 * 1000,
	accountId: `account-${suffix}`,
});

test("store writes private account files and redacts invalid JSON", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-"));
	const file = join(dir, "pi-codex-accounts.json");
	const store = new CodexAccountStore(new FileAuthStorageBackend(file));

	await store.write({ active: "work", accounts: { work: validCred("work") } });
	const mode = (await stat(file)).mode & 0o777;
	assert.equal(mode, 0o600);

	await store.writeRawForTest('{"active":"work","accounts":{"work":{"access":"secret-token"}}');
	await assert.rejects(store.readAsync(), (error) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /Invalid Codex accounts JSON/);
		assert.doesNotMatch(error.message, /secret-token/);
		return true;
	});
});

test("stored account maps preserve prototype-like account names as own entries", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	const credential = validCred("prototype");
	await store.writeRawForTest(
		`{"active":"__proto__","accounts":{"__proto__":${JSON.stringify(credential)}}}`,
	);

	const data = await store.readAsync();

	assert.deepEqual(Object.keys(data.accounts), ["__proto__"]);
	assert.deepEqual(Object.getOwnPropertyDescriptor(data.accounts, "__proto__")?.value, credential);
});

test("an inherited account-map property is not treated as a stored account", async () => {
	const store = new CodexAccountStore(new InMemoryAuthStorageBackend());
	await store.writeRawForTest('{"active":"constructor","accounts":{}}');
	const runtimeCalls: string[] = [];
	const { ctx } = createMockContext({
		modelRegistry: {
			authStorage: {
				setRuntimeApiKey: (provider: string, key: string) =>
					runtimeCalls.push(`set:${provider}:${key}`),
				removeRuntimeApiKey: (provider: string) => runtimeCalls.push(`remove:${provider}`),
			},
		},
	});

	const result = await ensureActiveCodexAuth(ctx, store, {
		oauthProvider: {
			async refreshToken() {
				throw new Error("unexpected refresh");
			},
			getApiKey() {
				throw new Error("unexpected API-key conversion");
			},
		},
	});

	assert.deepEqual(result, { status: "inactive" });
	assert.equal((await store.readAsync()).active, undefined);
	assert.deepEqual(runtimeCalls, []);
});

test("default store migrates credentials to the canonical package filename", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const legacyPath = join(dir, "codex-accounts.json");
		const canonicalPath = join(dir, "pi-codex-accounts.json");
		const raw = JSON.stringify({
			active: "work",
			accounts: { work: validCred("work") },
			futureOption: true,
		});
		await writeFile(legacyPath, raw, { mode: 0o644 });
		await chmod(legacyPath, 0o644);

		const mock = createMockPi();
		codexAccounts(mock.pi);
		assert.equal(CODEX_ACCOUNTS_FILE, "pi-codex-accounts.json");
		assert.equal(await readFile(canonicalPath, "utf8"), raw);
		assert.equal((await stat(canonicalPath)).mode & 0o777, 0o600);
		await assert.rejects(access(legacyPath));

		const context = createMockContext({
			modelRegistry: {
				authStorage: {
					setRuntimeApiKey: () => undefined,
					removeRuntimeApiKey: () => undefined,
				},
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.match(context.notifications[0]?.message ?? "", /migrated/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});

test("concurrent startup waits for an in-progress legacy account migration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-migration-lock-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let lockHolder: ReturnType<typeof spawn> | undefined;
	try {
		const legacyPath = join(dir, "codex-accounts.json");
		const canonicalPath = join(dir, "pi-codex-accounts.json");
		const raw = JSON.stringify({ active: "work", accounts: { work: validCred("work") } });
		await writeFile(legacyPath, raw, { mode: 0o600 });
		lockHolder = spawn(
			process.execPath,
			[
				"-e",
				`const lockfile = require("proper-lockfile");
(async () => {
	const release = await lockfile.lock(process.argv[1], { realpath: false });
	process.stdout.write("locked\\n");
	await new Promise((resolve) => setTimeout(resolve, 500));
	await release();
})().catch((error) => { console.error(error); process.exitCode = 1; });`,
				legacyPath,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const lockHolderExit = once(lockHolder, "exit");
		assert.ok(lockHolder.stdout);
		await once(lockHolder.stdout, "data");

		const store = new CodexAccountStore();
		assert.equal(store.read().active, "work");
		assert.equal(await readFile(canonicalPath, "utf8"), raw);
		await assert.rejects(access(legacyPath));
		const [exitCode] = await lockHolderExit;
		assert.equal(exitCode, 0);
	} finally {
		lockHolder?.kill();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});

test("migration preserves malformed credential data without leaking tokens", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-invalid-migration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const legacyPath = join(dir, "codex-accounts.json");
		const canonicalPath = join(dir, "pi-codex-accounts.json");
		await writeFile(legacyPath, '{"accounts":{"work":{"access":"secret-token"}}', {
			mode: 0o600,
		});
		const store = new CodexAccountStore();

		await assert.rejects(store.readAsync(), (error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /pi-codex-accounts\.json/);
			assert.doesNotMatch(error.message, /secret-token/);
			return true;
		});
		assert.equal((await stat(canonicalPath)).mode & 0o777, 0o600);
		await assert.rejects(access(legacyPath));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});

test("canonical Codex accounts file wins without deleting the legacy file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-precedence-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const legacyPath = join(dir, "codex-accounts.json");
		const canonicalPath = join(dir, "pi-codex-accounts.json");
		await writeFile(
			legacyPath,
			JSON.stringify({ active: "old", accounts: { old: validCred("old") } }),
			{ mode: 0o600 },
		);
		await writeFile(
			canonicalPath,
			JSON.stringify({ active: "new", accounts: { new: validCred("new") } }),
			{ mode: 0o644 },
		);
		await chmod(canonicalPath, 0o644);

		const store = new CodexAccountStore();
		assert.equal(store.read().active, "new");
		assert.equal((await stat(canonicalPath)).mode & 0o777, 0o600);
		assert.equal((await stat(legacyPath)).isFile(), true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});

test("default store falls back to legacy credentials for a broken canonical symlink", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-accounts-broken-canonical-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const legacyPath = join(dir, "codex-accounts.json");
		const canonicalPath = join(dir, "pi-codex-accounts.json");
		await writeFile(
			legacyPath,
			JSON.stringify({ active: "legacy", accounts: { legacy: validCred("legacy") } }),
			{ mode: 0o600 },
		);
		await symlink("missing-target", canonicalPath);

		const store = new CodexAccountStore();
		assert.equal(store.read().active, "legacy");
		assert.equal((await stat(legacyPath)).mode & 0o777, 0o600);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});
