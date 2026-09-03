import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
	configuredSyncSetupNames,
	effectiveSyncSetupRemoteIdentity,
	loadConfig,
	localConfigPath,
	normalizeSyncInclude,
	readLocalConfigObject,
	validateSettingsDocument,
} from "../src/config.js";
import { BUILT_IN_SYNC_ROOTS, isSafeCustomIncludePath } from "../src/sync-policy.js";
import { withTempHome } from "./helpers.js";

function connection(type: "s3" | "git" | "webdav") {
	if (type === "git") return { type, remote: "git@github.com:user/pi-sync.git" };
	if (type === "webdav") {
		return {
			type,
			url: "https://cloud.example.com/remote.php/dav/files/user",
			credentials: { username: "user", password: "webdav-secret" },
		};
	}
	return {
		type,
		endpoint: "https://example.r2.cloudflarestorage.com",
		region: "auto",
		credentials: { accessKeyId: "access", secretAccessKey: "s3-secret" },
	};
}

function setup(type: "s3" | "git" | "webdav", name = "store") {
	const storage =
		type === "s3"
			? { connection: name, bucket: "pi-sync", path: "pi-sync/home" }
			: type === "git"
				? { connection: name, branch: "pi-sync/home", path: "pi-sync/home" }
				: { connection: name, path: "pi-sync/home" };
	return {
		storage,
		sync: { include: ["settings.json", "AGENTS.md", "sessions"], automatic: true },
	};
}

function settings(type: "s3" | "git" | "webdav") {
	return {
		version: 3,
		activeSyncSetup: "home",
		onSwitch: "ask-before-pull",
		storageConnections: { store: connection(type) },
		syncSetups: { home: setup(type) },
	};
}

async function writeSettings(agentDir: string, value: unknown) {
	assert.equal(localConfigPath(), path.join(agentDir, "pi-sync.json"));
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "pi-sync.json"), `${JSON.stringify(value, null, "\t")}\n`, {
		mode: 0o600,
	});
}

test("version 3 resolves exhaustive S3, Git, and WebDAV setup shapes", async () => {
	for (const type of ["s3", "git", "webdav"] as const) {
		await withTempHome(async (agentDir) => {
			await writeSettings(agentDir, settings(type));
			const config = await loadConfig();
			assert.equal(config.setupName, "home");
			assert.equal(config.connectionName, "store");
			assert.equal(config.backend.type, type);
			assert.deepEqual(config.include, ["settings.json", "AGENTS.md", "sessions"]);
			assert.equal(config.automatic, true);
			assert.equal(config.skipSecretScan, false);
			assert.equal(config.storagePath, "pi-sync/home");
		});
	}
});

test("version 3 validates the optional global secret-scan override", () => {
	const enabled = settings("s3") as ReturnType<typeof settings> & {
		skipSecretScan?: unknown;
	};
	enabled.skipSecretScan = true;
	assert.equal(effectiveValidated(enabled), enabled);
	enabled.skipSecretScan = "true";
	assert.throws(() => effectiveValidated(enabled), /skipSecretScan must be boolean/u);
});

test("version 3 accepts an empty catalog only without an active setup", async () => {
	await withTempHome(async (agentDir) => {
		const empty = {
			version: 3,
			onSwitch: "switch-only",
			storageConnections: {},
			syncSetups: {},
		};
		await writeSettings(agentDir, empty);
		assert.deepEqual(await readLocalConfigObject(), empty);
		assert.deepEqual(await configuredSyncSetupNames(), []);
		await assert.rejects(loadConfig(), /No sync setups are configured/u);
	});
});

test("version 3 rejects whitespace-normalized setup references", () => {
	const active = settings("s3");
	active.activeSyncSetup = " home ";
	assert.throws(() => effectiveValidated(active), /activeSyncSetup.*whitespace/u);

	const connectionReference = settings("s3");
	connectionReference.syncSetups.home.storage.connection = " store ";
	assert.throws(
		() => effectiveValidated(connectionReference),
		/storage connection reference.*whitespace/u,
	);
});

test("version 3 rejects missing references and backend-field mixing", async () => {
	await withTempHome(async (agentDir) => {
		const missing = settings("s3");
		missing.syncSetups.home.storage.connection = "missing";
		await writeSettings(agentDir, missing);
		await assert.rejects(loadConfig(), /missing storage connection/u);

		const mixed = settings("git") as ReturnType<typeof settings> & {
			syncSetups: { home: { storage: Record<string, unknown> } };
		};
		mixed.syncSetups.home.storage.bucket = "wrong";
		await writeSettings(agentDir, mixed);
		await assert.rejects(loadConfig(), /Git sync setup.*mixes backend fields/u);
	});
});

test("built-in sync roots stay canonical and cannot become custom paths", () => {
	for (const root of BUILT_IN_SYNC_ROOTS) {
		const caseVariant = root.toUpperCase();
		assert.deepEqual(normalizeSyncInclude([caseVariant]), [root]);
		assert.equal(isSafeCustomIncludePath(root), false, root);
		assert.equal(isSafeCustomIncludePath(caseVariant), false, caseVariant);
		assert.equal(isSafeCustomIncludePath(`${root}/child`), false, `${root}/child`);
		assert.throws(() => normalizeSyncInclude([`${root}/child`]), /canonical .* root/u);
		assert.equal(isSafeCustomIncludePath(`${root}.backup`), true, `${root}.backup`);
	}
	assert.equal(isSafeCustomIncludePath("custom.json"), true);
	assert.equal(isSafeCustomIncludePath("custom"), true);
});

test("version 3 rejects reserved names, duplicate remotes, and invalid include values", async () => {
	await withTempHome(async (agentDir) => {
		const reserved = JSON.parse(JSON.stringify(settings("s3"))) as Record<string, unknown>;
		reserved.storageConnections = JSON.parse(
			`{"__proto__":${JSON.stringify(connection("s3"))}}`,
		) as Record<string, unknown>;
		await writeSettings(agentDir, reserved);
		await assert.rejects(readLocalConfigObject(), /invalid storage connection name/u);

		for (const type of ["s3", "git", "webdav"] as const) {
			const duplicate = settings(type);
			(duplicate.syncSetups as Record<string, ReturnType<typeof setup>>).backup = setup(type);
			await writeSettings(agentDir, duplicate);
			await assert.rejects(
				readLocalConfigObject(),
				/same normalized remote location/u,
				`${type} duplicate`,
			);
		}

		assert.throws(() => normalizeSyncInclude(["settings.json", "SETTINGS.JSON"]), /duplicate/u);
		assert.throws(() => normalizeSyncInclude(["../secrets"]), /safe agent-relative path/u);
		assert.throws(() => normalizeSyncInclude(["custom", "custom/file.md"]), /overlapping/u);
		assert.throws(() => normalizeSyncInclude(["pi-sync.json"]), /cannot be synced/u);
		assert.deepEqual(normalizeSyncInclude([]), []);
	});
});

test("version 3 rejects recognized version 1/2 fields without rejecting unknown future fields", () => {
	for (const mutate of [
		(value: ReturnType<typeof settings>) => Object.assign(value, { profiles: {} }),
		(value: ReturnType<typeof settings>) =>
			Object.assign(value.storageConnections.store, { accessKeyId: "legacy" }),
		(value: ReturnType<typeof settings>) =>
			Object.assign(value.syncSetups.home, { syncFiles: ["settings.json"] }),
		(value: ReturnType<typeof settings>) =>
			Object.assign(value.syncSetups.home.storage, { namespace: "legacy" }),
	]) {
		const value = settings("s3");
		mutate(value);
		assert.throws(() => effectiveValidated(value), /unsupported version 1\/2 field/u);
	}
	const future = settings("s3") as ReturnType<typeof settings> & { futureTop?: unknown };
	future.futureTop = { retained: true };
	assert.equal(effectiveValidated(future), future);
});

test("every documented connection and setup field is required", () => {
	for (const [type, mutations] of [
		[
			"s3",
			[
				(value: Record<string, unknown>) => delete value.endpoint,
				(value: Record<string, unknown>) => delete value.region,
				(value: Record<string, unknown>) => delete value.credentials,
			],
		],
		["git", [(value: Record<string, unknown>) => delete value.remote]],
		[
			"webdav",
			[
				(value: Record<string, unknown>) => delete value.url,
				(value: Record<string, unknown>) => delete value.credentials,
			],
		],
	] as const) {
		for (const mutate of mutations) {
			const value = settings(type);
			mutate(value.storageConnections.store as Record<string, unknown>);
			assert.throws(
				() => effectiveValidated(value),
				/required|must be|credentials/u,
				`${type} missing field`,
			);
		}
	}

	for (const mutate of [
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home as Partial<ReturnType<typeof setup>>).storage,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home as Partial<ReturnType<typeof setup>>).sync,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home.storage as { path?: string }).path,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home.sync as { include?: string[] }).include,
		(value: ReturnType<typeof settings>) =>
			delete (value.syncSetups.home.sync as { automatic?: boolean }).automatic,
	]) {
		const value = settings("s3");
		mutate(value);
		assert.throws(() => effectiveValidated(value), /must be|missing|safe relative path/u);
	}
});

test("credentials and own-property references fail closed", () => {
	const malformedS3 = settings("s3");
	malformedS3.storageConnections.store.credentials = {
		accessKeyId: "access",
		secretAccessKey: "",
	};
	assert.throws(() => effectiveValidated(malformedS3), /secret access key.*configured/u);

	const malformedWebDav = settings("webdav");
	malformedWebDav.storageConnections.store.credentials = {
		username: "bad:user",
		password: "secret",
	};
	assert.throws(() => effectiveValidated(malformedWebDav), /credentials/u);

	const secretGit = settings("git");
	secretGit.storageConnections.store.remote = "https://user:secret@example.com/repo.git";
	assert.throws(() => effectiveValidated(secretGit), /userinfo are not allowed/u);

	const badActive = settings("s3");
	badActive.activeSyncSetup = "constructor";
	assert.throws(() => effectiveValidated(badActive), /activeSyncSetup/u);
});

function effectiveValidated(value: ReturnType<typeof settings>) {
	// The public validator is deliberately exercised without touching disk for required-field tables.
	return validateSettingsDocument(value as unknown as Record<string, unknown>);
}

test("remote identity uses normalized reviewed coordinates and not the setup name", () => {
	const document = settings("s3");
	const first = effectiveSyncSetupRemoteIdentity(
		document.syncSetups.home,
		document.storageConnections.store,
	);
	const renamed = effectiveSyncSetupRemoteIdentity(
		document.syncSetups.home,
		document.storageConnections.store,
	);
	assert.equal(first, renamed);
	const equivalent = setup("s3");
	equivalent.storage.path = "/pi-sync/home/";
	assert.equal(
		first,
		effectiveSyncSetupRemoteIdentity(equivalent, document.storageConnections.store),
	);
});

test("unsupported and invalid settings remain byte-for-byte unchanged and errors redact secrets", async () => {
	for (const value of [
		{ version: 1, accessKeyId: "do-not-show" },
		{ version: 2, secretAccessKey: "do-not-show" },
		{ profiles: {}, targets: {}, password: "do-not-show" },
	] as const) {
		await withTempHome(async (agentDir) => {
			await writeSettings(agentDir, value);
			const file = path.join(agentDir, "pi-sync.json");
			const before = await readFile(file);
			await assert.rejects(loadConfig(), (error: unknown) => {
				assert.match(String(error), /unsupported.*version 3/iu);
				assert.doesNotMatch(String(error), /do-not-show/u);
				return true;
			});
			assert.deepEqual(await readFile(file), before);
		});
	}
});
