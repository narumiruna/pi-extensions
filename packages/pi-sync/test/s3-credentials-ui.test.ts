import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, localConfigPath, readLocalConfigObject } from "../src/config.js";
import { S3Client } from "../src/s3-client.js";
import { chooseS3Credentials } from "../src/s3-credentials-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const temporaryChoice = "Store temporary credentials privately";
const credentials = {
	accessKeyId: "temporary-access-id",
	secretAccessKey: "temporary-secret-key",
	sessionToken: "temporary-session-token",
};

for (const backend of ["Cloudflare R2", "Other S3-compatible storage"]) {
	for (const route of ["setup", "add", "edit"] as const) {
		test(`${backend} ${route} persists a masked session token and signs requests with it`, async () => {
			await withTempHome(async (agentDir) => {
				mkdirSync(agentDir, { recursive: true });
				const { showSetupWizard } = await import("../src/manager-ui.js");
				const { showAddStorageConnection, showStorageConnections } = await import(
					"../src/storage-connections-ui.js"
				);
				const settings = v3S3Settings();
				const endpoint =
					backend === "Cloudflare R2"
						? settings.storageConnections.r2.endpoint
						: "https://s3.example.com";
				settings.storageConnections.r2.endpoint = endpoint;
				settings.storageConnections.r2.region = "auto";
				if (route !== "setup") {
					writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
				}
				const choices =
					route === "setup"
						? [
								backend,
								"Personal / Home",
								backend === "Cloudflare R2"
									? "Use suggested location (recommended)"
									: "Use existing bucket with suggested path (recommended)",
								temporaryChoice,
								"Minimal settings",
								"Keep automatic sync off",
								"Keep sessions off (recommended)",
								"Save sync setup",
							]
						: route === "add"
							? [backend, temporaryChoice, "Add storage connection"]
							: [
									"r2",
									"Edit storage connection…",
									"Change credential source",
									temporaryChoice,
									"Save storage connection",
									"Back",
									"Back",
								];
				const frames: string[] = [];
				const secrets = [credentials.secretAccessKey, credentials.sessionToken];
				const { ctx, notifications } = createMockContext({
					hasUI: true,
					mode: "tui",
					input: async (title: string) => {
						if (title === "Access key ID") return credentials.accessKeyId;
						if (title === "Name this storage connection") return "temporary";
						if (title === "Existing bucket") return "pi-sync-test";
						if (/region/iu.test(title)) return "auto";
						if (/endpoint/iu.test(title)) return endpoint;
						throw new Error(`Unexpected input: ${title}`);
					},
					select: async (title: string, options: string[]) => {
						frames.push(title);
						const choice = choices.shift();
						assert.ok(choice && options.includes(choice), `Unexpected choice: ${choice}`);
						return choice;
					},
					custom: async (factory: unknown) => {
						const tui = createTuiHarness({ width: 60 });
						const running = tui.custom(factory as Parameters<typeof tui.custom>[0]);
						await tui.waitForOpen();
						tui.send(`\u001b[200~${secrets.shift()}\u001b[201~`);
						frames.push(tui.render().join("\n"));
						tui.press("tui.input.submit");
						return running;
					},
				});
				if (route === "setup") assert.equal(await showSetupWizard(ctx), true);
				else if (route === "add") assert.equal(await showAddStorageConnection(ctx), true);
				else await showStorageConnections(ctx);
				const saved = await readLocalConfigObject();
				const name =
					route === "add"
						? "temporary"
						: backend === "Cloudflare R2" || route === "edit"
							? "r2"
							: "s3";
				const connection = saved?.storageConnections[name];
				assert.deepEqual(connection?.credentials, credentials);
				assert.equal(secrets.length, 0);
				assert.match(frames.join("\n"), /Session token/u);
				assert.match(frames.join("\n"), /with session token \(values hidden\)/u);
				assert.doesNotMatch(
					JSON.stringify({ frames, notifications }),
					/temporary-secret-key|temporary-session-token/u,
				);
				if (process.platform !== "win32") {
					assert.equal(statSync(localConfigPath()).mode & 0o777, 0o600);
				}
				// Exercise the persisted config rather than constructing signing credentials separately.
				if (route === "add") {
					const { addSyncSetup } = await import("../src/settings-management.js");
					await addSyncSetup("temporary", {
						storage: { connection: name, bucket: "pi-sync-test", path: "pi-sync/temporary" },
						sync: { include: [], automatic: false },
					});
				}
				{
					const config = await loadConfig(route === "add" ? "temporary" : undefined);
					assert.equal(config.backend.type, "s3");
					if (config.backend.type !== "s3") return;
					const originalFetch = globalThis.fetch;
					const tokens: Array<string | null> = [];
					globalThis.fetch = async (_url, init) => {
						tokens.push(new Headers(init?.headers).get("x-amz-security-token"));
						return Response.json({ ok: true });
					};
					try {
						await new S3Client(config.backend).getJson("latest.json");
						assert.deepEqual(tokens, [credentials.sessionToken]);
					} finally {
						globalThis.fetch = originalFetch;
					}
				}
			});
		});
	}
}

for (const end of ["blank", "cancel", "dispose", "replace-session", "shutdown"] as const) {
	test(`temporary token ${end} never returns a partial credential set`, async () => {
		const owner = new AbortController();
		const tui = createTuiHarness({ width: 60 });
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => temporaryChoice,
			input: async () => credentials.accessKeyId,
			custom: tui.custom,
		});
		const running = chooseS3Credentials(ctx, owner.signal);
		const result = running.then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		await tui.waitForOpen();
		tui.type(credentials.secretAccessKey);
		tui.press("tui.input.submit");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Session token/u);
		if (end === "blank") tui.press("tui.input.submit");
		else {
			tui.type(credentials.sessionToken);
			if (end === "cancel") tui.press("ctrl+c");
			else if (end === "dispose") tui.dispose();
			else owner.abort(new DOMException(end, "AbortError"));
		}
		const completed = await result;
		assert.equal(completed.value, undefined);
		if (end === "replace-session" || end === "shutdown") {
			assert.ok(completed.error instanceof Error);
			assert.equal(completed.error.name, "AbortError");
		} else assert.equal(completed.error, undefined);
		assert.equal(tui.isOpen, false);
		if (end === "blank")
			assert.match(notifications.at(-1)?.message ?? "", /Session token is required/u);
	});
}

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
			"Back",
		];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			input: async (title: string) => (title === "Endpoint" ? "https://new.example.com" : "auto"),
			select: async () => choices.shift(),
			custom: async () => assert.fail("Keeping credentials must not prompt for secrets"),
		});
		await showStorageConnections(ctx);
		assert.deepEqual((await readLocalConfigObject())?.storageConnections.r2.credentials, {
			...credentials,
			future: "preserved",
		});
	});
});

test("cancelling a temporary connection review preserves settings bytes", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		const { showAddStorageConnection } = await import("../src/storage-connections-ui.js");
		const before = JSON.stringify(v3S3Settings());
		writeFileSync(localConfigPath(), before, { mode: 0o600 });
		const choices = ["Cloudflare R2", temporaryChoice, "Cancel"];
		const inputs = [
			"temporary",
			"https://account.r2.cloudflarestorage.com",
			credentials.accessKeyId,
		];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			select: async () => choices.shift(),
			input: async () => inputs.shift(),
			custom: async () => credentials.sessionToken,
		});
		assert.equal(await showAddStorageConnection(ctx), false);
		assert.equal(readFileSync(localConfigPath(), "utf8"), before);
	});
});
