import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	DEFAULT_SHORT_NAME,
	loadTelegraphConfig,
	normalizeTelegraphConfig,
	saveTelegraphSetup,
	telegraphConfigPath,
	withTelegraphConfigLock,
	writeTelegraphConfig,
} from "../src/config.js";

test("config normalization defaults tools off and validates settings and credentials", () => {
	assert.deepEqual(normalizeTelegraphConfig({}), {
		shortName: DEFAULT_SHORT_NAME,
		tools: [],
		allowFilesOutsideWorkspace: false,
	});
	assert.deepEqual(
		normalizeTelegraphConfig({
			shortName: " account ",
			authorName: " Author ",
			authorUrl: " https://example.com/me ",
			accessToken: " secret ",
			tools: ["telegraph_edit_page", "telegraph_get_page"],
			allowFilesOutsideWorkspace: true,
		}),
		{
			shortName: "account",
			authorName: "Author",
			authorUrl: "https://example.com/me",
			accessToken: "secret",
			tools: ["telegraph_get_page", "telegraph_edit_page"],
			allowFilesOutsideWorkspace: true,
		},
	);
	assert.throws(() => normalizeTelegraphConfig(null), /JSON object/i);
	assert.throws(() => normalizeTelegraphConfig({ unknown: true }), /unknown field/i);
	assert.throws(() => normalizeTelegraphConfig({ shortName: "" }), /shortName/i);
	assert.throws(() => normalizeTelegraphConfig({ authorUrl: "javascript:bad" }), /authorUrl/i);
	assert.throws(() => normalizeTelegraphConfig({ accessToken: "$TOKEN" }), /literal/i);
	assert.throws(() => normalizeTelegraphConfig({ accessToken: "!command" }), /literal/i);
	assert.throws(() => normalizeTelegraphConfig({ tools: "all" }), /tools/i);
	assert.throws(() => normalizeTelegraphConfig({ tools: ["telegraph_unknown"] }), /tools/i);
	assert.throws(
		() => normalizeTelegraphConfig({ tools: ["telegraph_get_page", "telegraph_get_page"] }),
		/duplicate/i,
	);
	assert.throws(
		() => normalizeTelegraphConfig({ allowFilesOutsideWorkspace: "yes" }),
		/allowFilesOutsideWorkspace/i,
	);
});

test("config uses the canonical private pi-telegraph.json path and atomic 0600 writes", async () => {
	await withTempAgentDir(async (agentDir) => {
		assert.equal(telegraphConfigPath(), path.join(agentDir, "pi-telegraph.json"));
		const missing = await loadTelegraphConfig();
		assert.deepEqual(missing, {
			config: {
				shortName: DEFAULT_SHORT_NAME,
				tools: [],
				allowFilesOutsideWorkspace: false,
			},
			path: path.join(agentDir, "pi-telegraph.json"),
			exists: false,
		});

		await writeTelegraphConfig({ shortName: "private", accessToken: "secret" });
		assert.equal((await stat(telegraphConfigPath())).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(await readFile(telegraphConfigPath(), "utf8")), {
			shortName: "private",
			accessToken: "secret",
			tools: [],
			allowFilesOutsideWorkspace: false,
		});

		const loaded = await loadTelegraphConfig();
		assert.equal(loaded.exists, true);
		assert.equal(loaded.config.accessToken, "secret");
	});
});

test("config repairs readable files but rejects symlink and non-regular paths", async () => {
	await withTempAgentDir(async (agentDir) => {
		const configPath = path.join(agentDir, "pi-telegraph.json");
		await writeFile(configPath, '{"shortName":"fixed"}\n', { mode: 0o644 });
		assert.equal((await loadTelegraphConfig()).config.shortName, "fixed");
		assert.equal((await stat(configPath)).mode & 0o777, 0o600);

		await rm(configPath);
		const target = path.join(agentDir, "target.json");
		await writeFile(target, '{"shortName":"target"}\n', { mode: 0o600 });
		await symlink(target, configPath);
		await assert.rejects(loadTelegraphConfig(), /symbolic link/i);
		await assert.rejects(writeTelegraphConfig({ shortName: "replacement" }), /symbolic link/i);
	});
});

test("setup updates defaults under lock while preserving token and runtime settings", async () => {
	await withTempAgentDir(async () => {
		await writeTelegraphConfig({
			shortName: "old",
			accessToken: "keep-me",
			tools: ["telegraph_get_page"],
			allowFilesOutsideWorkspace: true,
		} as never);
		await saveTelegraphSetup({
			shortName: "new",
			authorName: "Writer",
			authorUrl: "https://example.com/writer",
		});
		assert.deepEqual((await loadTelegraphConfig()).config, {
			shortName: "new",
			authorName: "Writer",
			authorUrl: "https://example.com/writer",
			accessToken: "keep-me",
			tools: ["telegraph_get_page"],
			allowFilesOutsideWorkspace: true,
		});
	});
});

test("config lock removes stale cross-process ownership before entering", async () => {
	await withTempAgentDir(async (agentDir) => {
		const lockPath = path.join(agentDir, "pi-telegraph.json.lock");
		await writeFile(lockPath, JSON.stringify({ id: "stale", pid: 2_147_483_647, startedAt: 0 }), {
			mode: 0o600,
		});
		let entered = false;
		await withTelegraphConfigLock(undefined, async () => {
			entered = true;
		});
		assert.equal(entered, true);
		await assert.rejects(stat(lockPath));
	});
});

test("config lock serializes callers, respects abort, and removes its lock file", async () => {
	await withTempAgentDir(async (agentDir) => {
		const order: string[] = [];
		let release!: () => void;
		const blocker = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withTelegraphConfigLock(undefined, async () => {
			order.push("first-start");
			await blocker;
			order.push("first-end");
		});
		await waitFor(() => order.includes("first-start"));
		const second = withTelegraphConfigLock(undefined, async () => {
			order.push("second");
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(order, ["first-start"]);
		release();
		await Promise.all([first, second]);
		assert.deepEqual(order, ["first-start", "first-end", "second"]);
		await assert.rejects(stat(path.join(agentDir, "pi-telegraph.json.lock")));

		const controller = new AbortController();
		controller.abort(new Error("stop"));
		await assert.rejects(
			withTelegraphConfigLock(controller.signal, async () => undefined),
			/stop|abort/i,
		);

		let releaseHeld!: () => void;
		const held = withTelegraphConfigLock(undefined, async () => {
			await new Promise<void>((resolve) => {
				releaseHeld = resolve;
			});
		});
		await waitFor(() => releaseHeld !== undefined);
		const waitingController = new AbortController();
		const waiting = withTelegraphConfigLock(waitingController.signal, async () => undefined);
		waitingController.abort(new Error("cancel waiting lock"));
		await assert.rejects(waiting, /cancel waiting lock/);
		releaseHeld();
		await held;
		await withTelegraphConfigLock(undefined, async () => order.push("after-abort"));
		assert.equal(order.at(-1), "after-abort");
	});
});

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-telegraph-config-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}

async function waitFor(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for condition");
}
