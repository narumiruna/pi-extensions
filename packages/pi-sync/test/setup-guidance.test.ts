import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig, localConfigPath } from "../src/config.js";
import { saveOnSwitch, useSyncSetup } from "../src/setup-switch.js";
import { showSyncSetups } from "../src/sync-setups-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

for (const url of [
	"https://cloud.example.com/dav/owner-a/",
	"https://cloud.example.com/dav/owner-b/",
]) {
	test(`saved WebDAV setup detail exposes the exact collection ${url} without writes`, async () => {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			const settings = v3S3Settings();
			Object.assign(settings.storageConnections, {
				dav: {
					type: "webdav",
					url,
					credentials: { username: "user", password: "private-password" },
				},
			});
			Object.assign(settings.syncSetups, {
				work: {
					storage: { connection: "dav", path: "pi-sync/work" },
					sync: { include: ["settings.json"], automatic: false },
				},
			});
			const before = JSON.stringify(settings);
			writeFileSync(localConfigPath(), before, { mode: 0o600 });
			const { showSyncManager } = await import("../src/manager-ui.js");
			const choices = ["More…", "Sync setups…", "work"];
			const frames: string[] = [];
			const routes: string[] = [];
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "rpc",
				select: async (title: string) => {
					frames.push(title);
					return choices.shift();
				},
			});
			await showSyncManager(ctx, async (route) => {
				routes.push(route);
			});
			assert.ok(frames.some((frame) => frame.includes(`Endpoint: ${url}`)));
			assert.ok(frames.some((frame) => frame.includes("Storage location: WebDAV · pi-sync/work")));
			assert.doesNotMatch(frames.join("\n"), /private-password/u);
			assert.deepEqual(routes, []);
			assert.deepEqual(notifications, []);
			assert.equal(readFileSync(localConfigPath(), "utf8"), before);
		});
	});
}

for (const originalPolicy of ["switch-only", "ask-before-pull", "pull-after-switch"]) {
	test(`guided current-setup selection avoids a pull after ${originalPolicy}`, async () => {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			const settings = v3S3Settings();
			settings.onSwitch = originalPolicy;
			Object.assign(settings.syncSetups, {
				work: {
					storage: { connection: "r2", bucket: "work-bucket", path: "pi-sync/work" },
					sync: { include: ["settings.json"], automatic: false },
				},
			});
			writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
			assert.equal((await loadConfig()).setupName, "home");
			assert.equal((await loadConfig("work")).setupName, "work");
			const { ctx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
			await saveOnSwitch("switch-only");
			let pulls = 0;
			await useSyncSetup(ctx, "work", async () => {
				pulls += 1;
				return "applied";
			});
			assert.equal(pulls, 0);
			assert.equal((await loadConfig()).setupName, "work");
			const { default: sync } = await import("../src/sync.js");
			const mock = createMockPi();
			sync(mock.pi);
			await mock.commands.get("sync")?.handler("config", ctx);
			assert.ok(notifications.some(({ message }) => message.includes("sync setup: work")));
			const selections: string[][] = [];
			const menuContext = createMockContext({
				hasUI: true,
				mode: "rpc",
				select: async (_title: string, options: string[]) => {
					selections.push(options);
					return undefined;
				},
			});
			await showSyncSetups(menuContext.ctx, {
				add: async () => undefined,
				edit: async () => undefined,
				makeCurrent: async () => undefined,
				remove: async () => undefined,
			});
			assert.ok(selections[0]?.includes("work (current)"));
		});
	});
}
