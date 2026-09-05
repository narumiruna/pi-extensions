import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath, readLocalConfigObject } from "../src/config.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const credentials = {
	accessKeyId: "temporary-access-id",
	secretAccessKey: "temporary-secret-key",
	sessionToken: "temporary-session-token",
};

test("keeping S3 credentials preserves the session token and unknown fields", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const { showStorageConnections } = await import("../src/storage-connections-ui.js");
		const settings = v3S3Settings();
		Object.assign(settings.storageConnections.r2.credentials, credentials, { future: "preserved" });
		writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
		const choices = [
			"r2",
			"Edit storage connection…",
			"Keep current credentials",
			"Save storage connection",
			"Back",
		];
		let secretPrompts = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async (title: string) => (title === "Endpoint" ? "https://new.example.com" : "auto"),
			select: async () => choices.shift(),
			custom: async () => {
				secretPrompts += 1;
				return undefined;
			},
		});
		await showStorageConnections(ctx);
		assert.equal(secretPrompts, 0);
		const saved = await readLocalConfigObject();
		assert.deepEqual(saved?.storageConnections.r2.credentials, {
			...credentials,
			future: "preserved",
		});
		assert.equal(saved?.storageConnections.r2.endpoint, "https://new.example.com");
		assert.ok(notifications.some(({ message }) => message.includes("Saved storage connection")));
		assert.ok(notifications.every(({ level }) => level !== "error"));
	});
});
