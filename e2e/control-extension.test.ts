import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type RpcRecord, spawnPiRpc } from "./support/pi-rpc-harness.js";

const root = process.cwd();
const controlExtension = path.join(root, "e2e", "fixtures", "control-extension.ts");

function notificationWith(prefix: string): (record: RpcRecord) => boolean {
	return (record) =>
		record.type === "extension_ui_request" &&
		record.method === "notify" &&
		typeof record.message === "string" &&
		record.message.startsWith(prefix);
}

test("control fixture inspects an isolated RPC session and shuts it down gracefully", async (t) => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-extension-e2e-control-"));
	const cwd = path.join(temporaryRoot, "workspace");
	const agentDir = path.join(temporaryRoot, "agent");
	const sessionDir = path.join(temporaryRoot, "sessions");
	const sentinel = path.join(temporaryRoot, "shutdown.json");
	await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
	const rpc = spawnPiRpc({
		root,
		cwd,
		agentDir,
		sessionDir,
		extensionPaths: [controlExtension],
		env: {
			ANTHROPIC_API_KEY: "must-not-reach-the-child",
			AWS_ACCESS_KEY_ID: "must-not-reach-the-child",
			AWS_SECRET_ACCESS_KEY: "must-not-reach-the-child",
			AWS_SESSION_TOKEN: "must-not-reach-the-child",
			E2E_SECRET_API_KEY: "must-not-reach-the-child",
			GH_TOKEN: "must-not-reach-the-child",
			GITHUB_TOKEN: "must-not-reach-the-child",
			NPM_TOKEN: "must-not-reach-the-child",
			PI_E2E_SAFE_MARKER: "expected-safe-marker",
			PI_E2E_SHUTDOWN_SENTINEL: sentinel,
		},
		requestTimeoutMs: 5_000,
		shutdownTimeoutMs: 1_000,
	});
	t.after(async () => {
		await rpc.close();
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	const state = await rpc.request({ type: "get_state" });
	assert.equal(state.success, true, rpc.diagnostics());
	const commands = await rpc.request({ type: "get_commands" });
	assert.equal(commands.success, true, rpc.diagnostics());
	assert.ok(
		(commands.data as { commands: Array<{ name: string }> }).commands.some(
			(command) => command.name === "e2e-control",
		),
	);

	const inspectionRecord = rpc.waitForRecord(
		notificationWith("PI_E2E_CONTROL "),
		"control inspection notification",
	);
	const inspectionResponse = await rpc.request({ type: "prompt", message: "/e2e-control inspect" });
	assert.equal(inspectionResponse.success, true, rpc.diagnostics());
	const inspection = await inspectionRecord;
	const details = JSON.parse((inspection.message as string).slice("PI_E2E_CONTROL ".length)) as {
		agentDir: string;
		commands: string[];
		credentialLeaks: string[];
		home: string;
		safeMarker: string;
	};
	assert.equal(details.agentDir, agentDir);
	assert.deepEqual(details.credentialLeaks, []);
	assert.equal(details.home, agentDir);
	assert.equal(details.safeMarker, "expected-safe-marker");
	assert.ok(details.commands.includes("e2e-control"));

	const shutdownRecord = rpc.waitForRecord(
		notificationWith("PI_E2E_CONTROL shutting down"),
		"control shutdown notification",
	);
	const shutdownResponse = await rpc.request({ type: "prompt", message: "/e2e-control shutdown" });
	assert.equal(shutdownResponse.success, true, rpc.diagnostics());
	await shutdownRecord;
	await rpc.waitForExit(5_000);
	assert.deepEqual(rpc.exitStatus(), { code: 0, signal: null });
	const shutdown = JSON.parse(await readFile(sentinel, "utf8")) as {
		reason: string;
		timestamp: number;
	};
	assert.equal(shutdown.reason, "quit");
	assert.ok(Number.isFinite(shutdown.timestamp));
	await rpc.close();
	await rpc.close();
});
