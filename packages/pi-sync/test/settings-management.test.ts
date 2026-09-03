import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
} from "../../../test/support.js";
import {
	configuredSyncSetupNames,
	loadConfig,
	localConfigPath,
	readLocalConfigObject,
	updateLocalConfig,
} from "../src/config.js";
import { withConfigFilePublicationForTest, withLocalConfigFileLock } from "../src/config-file.js";
import {
	addStorageConnection,
	addSyncSetup,
	removeStorageConnection,
	removeSyncSetup,
	updateStorageConnection,
	updateSyncSetup,
} from "../src/settings-management.js";
import { showSyncSettings } from "../src/settings-ui.js";
import { SetupPullRequiresUiError, useSyncSetup } from "../src/setup-switch.js";
import { showStorageConnections } from "../src/storage-connections-ui.js";
import sync from "../src/sync.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);
const execFileAsync = promisify(execFile);

function writeSettings(value = v3S3Settings()) {
	writeFileSync(localConfigPath(), `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
}

test("first Cloudflare R2 setup writes exact paths and masked version 3 credentials", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const mock = createMockPi();
		sync(mock.pi);
		const choices = [
			"Set up sync",
			"Cloudflare R2",
			"Personal / Home",
			"Use suggested location (recommended)",
			"Store credentials privately",
			"Recommended Pi settings",
			"Enable automatic sync",
			"Keep sessions off (recommended)",
			"Save sync setup",
			undefined,
		];
		const inputs = ["https://account.r2.cloudflarestorage.com", "access-key"];
		const rendered: string[] = [];
		const inputTitles: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async (title: string) => {
				rendered.push(title);
				return choices.shift();
			},
			input: async (title: string) => {
				inputTitles.push(title);
				return inputs.shift();
			},
			custom: secretInput("secret-key", rendered),
		});
		await mock.commands.get("sync")?.handler("", ctx);
		const saved = await readLocalConfigObject();
		assert.equal(saved?.skipSecretScan, false);
		assert.deepEqual(saved?.storageConnections.r2, {
			type: "s3",
			endpoint: "https://account.r2.cloudflarestorage.com",
			region: "auto",
			credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
		});
		assert.deepEqual(saved?.syncSetups.home.storage, {
			connection: "r2",
			bucket: "pi-sync",
			path: "pi-sync/home",
		});
		assert.deepEqual(inputTitles, ["Cloudflare R2 endpoint", "Access key ID"]);
		assert.match(rendered.join("\n"), /Storage location: pi-sync\/home/u);
		assert.doesNotMatch(rendered.join("\n"), /profiles\/|secret-key|access-key/u);
	});
});

test("generic S3 setup reviews one complete custom storage path", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const mock = createMockPi();
		sync(mock.pi);
		const choices = [
			"Set up sync",
			"Other S3-compatible storage",
			"Work",
			"Customize remote location",
			"Store credentials privately",
			"Minimal settings",
			"Keep automatic sync off",
			"Keep sessions off (recommended)",
			"Save sync setup",
			undefined,
		];
		const inputs = [
			"https://s3.example.com",
			"ap-northeast-1",
			"archive",
			"company-pi",
			"teams/pi/work",
			"access-key",
		];
		const inputTitles: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => choices.shift(),
			input: async (title: string) => {
				inputTitles.push(title);
				return inputs.shift();
			},
			custom: secretInput("secret-key"),
		});
		await mock.commands.get("sync")?.handler("", ctx);
		const saved = await readLocalConfigObject();
		assert.deepEqual(saved?.syncSetups.work.storage, {
			connection: "archive",
			bucket: "company-pi",
			path: "teams/pi/work",
		});
		assert.ok(inputTitles.includes("Storage path"));
		assert.ok(!inputTitles.includes("Remote prefix"));
		assert.ok(!inputTitles.includes("Remote namespace"));
	});
});

test("session inclusion requires privacy acknowledgement before settings publication", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const mock = createMockPi();
		sync(mock.pi);
		const choices = [
			"Set up sync",
			"Cloudflare R2",
			"Personal / Home",
			"Use suggested location (recommended)",
			"Store credentials privately",
			"Recommended Pi settings",
			"Keep automatic sync off",
			"Include session conversations",
		];
		const inputs = ["https://account.r2.cloudflarestorage.com", "access-key"];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => choices.shift(),
			input: async () => inputs.shift(),
			confirm: async () => false,
			custom: secretInput("secret-key"),
		});
		await mock.commands.get("sync")?.handler("", ctx);
		assert.equal(await readLocalConfigObject(), undefined);
	});
});

test("cancelling first setup creates neither settings nor sync state", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const mock = createMockPi();
		sync(mock.pi);
		const choices = ["Set up sync", undefined];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => choices.shift(),
		});
		await mock.commands.get("sync")?.handler("", ctx);
		assert.equal(await readLocalConfigObject(), undefined);
		assert.equal(existsSync(path.join(agentDir, "pi-sync")), false);
		assert.equal(existsSync(path.join(agentDir, ".pisync")), false);
	});
});

test("S3 storage connection edit preserves masked credentials and reviews dependents", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		const choices = [
			"r2",
			"Edit storage connection…",
			"Keep current credentials",
			"Save storage connection",
			"Back",
			"Back",
		];
		const inputs = ["https://new.example.com", "us-east-1"];
		const rendered: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async (title: string) => {
				rendered.push(title);
				return choices.shift();
			},
			input: async () => inputs.shift(),
		});
		await showStorageConnections(ctx);
		const config = await loadConfig();
		assert.equal(config.backend.type, "s3");
		if (config.backend.type !== "s3") return;
		assert.equal(config.backend.profile.endpoint, "https://new.example.com");
		assert.equal(config.backend.profile.accessKeyId, "access-key");
		assert.match(rendered.join("\n"), /Affected sync setups: home/u);
		assert.doesNotMatch(rendered.join("\n"), /access-key|secret-key/u);
	});
});

test("replacing stored S3 credentials drops the prior session token", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const settings = v3S3Settings();
		(settings.storageConnections.r2.credentials as Record<string, string>).sessionToken =
			"stale-session-token";
		writeSettings(settings);
		const choices = [
			"r2",
			"Edit storage connection…",
			"Change credential source",
			"Store credentials privately",
			"Save storage connection",
			"Back",
			"Back",
		];
		const inputs = [
			settings.storageConnections.r2.endpoint,
			settings.storageConnections.r2.region,
			"replacement-access-key",
		];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => choices.shift(),
			input: async () => inputs.shift(),
			custom: secretInput("replacement-secret-key"),
		});
		await showStorageConnections(ctx);
		assert.deepEqual((await readLocalConfigObject())?.storageConnections.r2.credentials, {
			accessKeyId: "replacement-access-key",
			secretAccessKey: "replacement-secret-key",
		});
	});
});

test("S3 manager reuses a connection and derives a separate complete path", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		const mock = createMockPi();
		sync(mock.pi);
		const choices = [
			"More…",
			"Sync setups…",
			"Add sync setup",
			"r2",
			"Same bucket as “home” (recommended)",
			"Recommended Pi settings",
			"Add sync setup",
			undefined,
			undefined,
		];
		const inputs = ["work"];
		const rendered: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async (title: string) => {
				rendered.push(title);
				return choices.shift();
			},
			input: async () => inputs.shift(),
		});
		await mock.commands.get("sync")?.handler("", ctx);
		const config = await loadConfig("work");
		assert.equal(config.connectionName, "r2");
		assert.equal(config.storagePath, "pi-sync/work");
		assert.match(rendered.join("\n"), /Remote path: pi-sync\/work/u);
		assert.doesNotMatch(rendered.join("\n"), /profiles\//u);
	});
});

test("storage connections are reusable by multiple independently named sync setups", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await addSyncSetup("work", {
			storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
			sync: { include: ["settings.json"], automatic: false },
		});
		assert.deepEqual(await configuredSyncSetupNames(), ["home", "work"]);
		assert.equal((await loadConfig("work")).connectionName, "r2");
		assert.equal((await loadConfig("work")).storagePath, "pi-sync/work");
	});
});

test("duplicate normalized remote locations fail before publication", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await assert.rejects(
			addSyncSetup("duplicate", {
				storage: { connection: "r2", bucket: "pi-sync-test", path: "/pi-sync/home/" },
				sync: { include: [], automatic: false },
			}),
			/duplicates the storage location/u,
		);
	});
});

test("referenced connections and a current setup with alternatives cannot be removed", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await addSyncSetup("work", {
			storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
			sync: { include: ["settings.json"], automatic: false },
		});
		await assert.rejects(removeStorageConnection("r2"), /used by sync setup “home”/u);
		await assert.rejects(removeSyncSetup("home"), /another sync setup/u);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
	});
});

test("removing the sole current setup clears the active reference", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await removeSyncSetup("home");
		const settings = await readLocalConfigObject();
		assert.deepEqual(settings?.syncSetups, {});
		assert.equal(Object.hasOwn(settings ?? {}, "activeSyncSetup"), false);
		assert.ok(settings?.storageConnections.r2);
	});
});

test("storage connection and sync setup CRUD preserve unknown retained fields", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const initial = v3S3Settings() as unknown as Record<string, unknown>;
		initial.futureTop = { keep: true };
		writeSettings(initial as ReturnType<typeof v3S3Settings>);
		await addStorageConnection("git", {
			type: "git",
			remote: "git@github.com:user/pi-sync.git",
			futureConnection: "keep",
		});
		await addSyncSetup("backup", {
			storage: {
				connection: "git",
				branch: "pi-sync/backup",
				path: "pi-sync/backup",
				futureStorage: "keep",
			},
			sync: { include: [], automatic: false, futurePolicy: "keep" },
			futureSetup: "keep",
		});
		await updateStorageConnection("git", (connection) => {
			if (connection.type !== "git") throw new Error("expected Git");
			return { ...connection, remote: "ssh://git@github.com/user/pi-sync.git" };
		});
		await updateSyncSetup("backup", (setup) => ({ ...setup, futureSetup: "still" }));
		const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
		assert.deepEqual(saved.futureTop, { keep: true });
		assert.equal(saved.storageConnections.git.futureConnection, "keep");
		assert.equal(saved.syncSetups.backup.storage.futureStorage, "keep");
		assert.equal(saved.syncSetups.backup.sync.futurePolicy, "keep");
		assert.equal(saved.syncSetups.backup.futureSetup, "still");
	});
});

test("switching setup is atomic and follows all three onSwitch policies", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await addSyncSetup("work", {
			storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
			sync: { include: ["settings.json"], automatic: false },
		});
		await updateLocalConfig((settings) => ({ ...settings, onSwitch: "switch-only" }));
		const mock = createMockContext({ hasUI: true, mode: "tui" });
		assert.deepEqual(await useSyncSetup(mock.ctx, "work"), { pullApplied: false });
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

		await updateLocalConfig((settings) => ({
			...settings,
			onSwitch: "ask-before-pull",
			activeSyncSetup: "home",
		}));
		let pullCalls = 0;
		const declined = createMockContext({
			hasUI: true,
			mode: "tui",
			confirm: async () => false,
		});
		assert.deepEqual(
			await useSyncSetup(declined.ctx, "work", async () => {
				pullCalls += 1;
				return "applied";
			}),
			{ pullApplied: false },
		);
		assert.equal(pullCalls, 0);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

		await updateLocalConfig((settings) => ({ ...settings, onSwitch: "pull-after-switch" }));
		const noUi = createMockContext({ hasUI: false, mode: "print" });
		await assert.rejects(useSyncSetup(noUi.ctx, "home"), SetupPullRequiresUiError);
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "work");

		let pulled: string | undefined;
		await assert.rejects(
			useSyncSetup(mock.ctx, "home", async (name) => {
				pulled = name;
				throw new Error("pull failed");
			}),
			/pull failed/u,
		);
		assert.equal(pulled, "home");
		assert.equal((await readLocalConfigObject())?.activeSyncSetup, "home");
		assert.deepEqual(await useSyncSetup(mock.ctx, "home"), { pullApplied: false });
	});
});

test("cross-process settings mutations serialize under one read-modify-write lock", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		const configModule = pathToFileURL(
			path.join(
				process.cwd(),
				"node_modules/.cache/pi-extensions-test/packages/pi-sync/src/config.js",
			),
		).href;
		const mutate = (field: string) =>
			execFileAsync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`import { updateLocalConfig } from ${JSON.stringify(configModule)}; await updateLocalConfig((settings) => ({ ...settings, ${field}: true }));`,
				],
				{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
			);
		await Promise.all([mutate("processOne"), mutate("processTwo")]);
		const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
		assert.equal(saved.processOne, true);
		assert.equal(saved.processTwo, true);
	});
});

test("concurrent settings mutations serialize without dropping either update", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		await Promise.all([
			updateLocalConfig((settings) => ({ ...settings, firstUnknown: true })),
			updateLocalConfig((settings) => ({ ...settings, secondUnknown: true })),
		]);
		const saved = JSON.parse(readFileSync(localConfigPath(), "utf8"));
		assert.equal(saved.firstUnknown, true);
		assert.equal(saved.secondUnknown, true);
		if (process.platform !== "win32") assert.equal(statSync(localConfigPath()).mode & 0o777, 0o600);
	});
});

test("an aborted settings mutation waiting on the update queue never publishes", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		let releaseLock = () => {};
		let reportLockHeld = () => {};
		const lockHeld = new Promise<void>((resolve) => {
			reportLockHeld = () => resolve();
		});
		const release = new Promise<void>((resolve) => {
			releaseLock = () => resolve();
		});
		const blocker = withLocalConfigFileLock(async () => {
			reportLockHeld();
			await release;
		});
		await lockHeld;
		const first = updateLocalConfig((settings) => ({ ...settings, firstQueued: true }));
		const controller = new AbortController();
		const second = updateLocalConfig(
			(settings) => ({ ...settings, abortedQueued: true }),
			controller.signal,
		);
		const rejected = assert.rejects(second, { name: "AbortError" });
		controller.abort(new DOMException("Session replaced", "AbortError"));
		releaseLock();
		await blocker;
		await first;
		await rejected;
		const saved = await readLocalConfigObject();
		assert.equal(saved?.firstQueued, true);
		assert.equal(saved?.abortedQueued, undefined);
	});
});

test("an aborted settings mutation waiting on the cross-process lock never publishes", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		let releaseLock = () => {};
		let reportLockHeld = () => {};
		const lockHeld = new Promise<void>((resolve) => {
			reportLockHeld = () => resolve();
		});
		const release = new Promise<void>((resolve) => {
			releaseLock = () => resolve();
		});
		const blocker = withLocalConfigFileLock(async () => {
			reportLockHeld();
			await release;
		});
		await lockHeld;
		const controller = new AbortController();
		const update = updateLocalConfig(
			(settings) => ({ ...settings, abortedWhileLocked: true }),
			controller.signal,
		);
		const rejected = assert.rejects(update, { name: "AbortError" });
		controller.abort(new DOMException("Session replaced", "AbortError"));
		releaseLock();
		await blocker;
		await rejected;
		assert.equal((await readLocalConfigObject())?.abortedWhileLocked, undefined);
	});
});

test("settings UI exposes local editing and synced-content comparison", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		let rendered = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 100);
				rendered = harness.render().join("\n");
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});

		await showSyncSettings(ctx, async () => undefined);

		assert.match(rendered, /Included content/u);
		assert.match(rendered, /Compare synced content/u);
		assert.deepEqual(readFileSync(localConfigPath()), before);
	});
});

test("settings UI persists the global secret-scan override", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 100);
				harness.handleInput("tui.select.down");
				harness.handleInput("\r");
				for (let attempt = 0; attempt < 100 && notifications.length === 0; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				harness.handleInput("\u001b");
				return harness.result;
			},
		});

		await showSyncSettings(ctx, async () => undefined);

		assert.equal((await loadConfig()).skipSecretScan, true);
		assert.equal((await readLocalConfigObject())?.skipSecretScan, true);
	});
});

test("settings UI disposes on session replacement without mutating settings", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const before = Buffer.from(`${JSON.stringify(v3S3Settings())}\n`);
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const controller = new AbortController();
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				harness.handleInput("\r");
				controller.abort(new DOMException("Session replaced", "AbortError"));
				harness.dispose();
				return harness.result;
			},
		});
		await showSyncSettings(ctx, async () => undefined, controller.signal);
		assert.deepEqual(readFileSync(localConfigPath()), before);
		assert.deepEqual(notifications, []);
	});
});

test("settings UI restores its displayed value when a private atomic save is rejected", {
	skip: process.platform === "win32",
}, async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeSettings();
		let afterFailure = "";
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				harness.handleInput("tui.select.down");
				harness.handleInput("\r");
				for (let attempt = 0; attempt < 100 && notifications.length === 0; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				afterFailure = harness.render().join("\n");
				harness.handleInput("\u001b");
				return harness.result;
			},
		});
		await withConfigFilePublicationForTest(
			async () => {
				const error = new Error("injected settings failure") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			},
			() => showSyncSettings(ctx, async () => undefined),
		);
		assert.match(afterFailure, /Skip secret scan/u);
		assert.match(afterFailure, /Off/u);
		assert.match(notifications.at(-1)?.message ?? "", /settings save failed/iu);
		assert.equal((await loadConfig()).skipSecretScan, false);
	});
});

test("invalid files block CRUD and remain byte-for-byte unchanged", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const bytes = Buffer.from('{"version":3,"storageConnections":');
		writeFileSync(localConfigPath(), bytes, { mode: 0o600 });
		await assert.rejects(
			addStorageConnection("git", { type: "git", remote: "git@github.com:user/repo.git" }),
			/Invalid JSON/u,
		);
		assert.deepEqual(readFileSync(localConfigPath()), bytes);
	});
});

function secretInput(secret: string, rendered: string[] = []) {
	return async (factory: unknown) => {
		const tui = createTuiHarness({ width: 48 });
		const running = tui.custom(factory as Parameters<typeof tui.custom>[0]);
		await tui.waitForOpen();
		tui.type(secret);
		rendered.push(tui.render().join("\n"));
		tui.press("tui.input.submit");
		return running;
	};
}
