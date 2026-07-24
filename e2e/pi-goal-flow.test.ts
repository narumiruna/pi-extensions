import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type RpcProcess, type RpcRecord, spawnPiRpc } from "./support/pi-rpc-harness.js";

const root = process.cwd();
const controlExtension = path.join(root, "e2e", "fixtures", "control-extension.ts");
const fauxProvider = path.join(root, "e2e", "fixtures", "goal-faux-provider.ts");
const goalExtension = path.join(root, "extensions", "pi-goal");

test("pi-goal completes a deterministic prompt-to-tool-to-state flow through Pi RPC", async (t) => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pi-extension-e2e-goal-"));
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
		extensionPaths: [goalExtension, fauxProvider, controlExtension],
		args: ["--provider", "e2e-faux", "--model", "faux-1", "--api-key", "e2e-only"],
		env: {
			PI_E2E_REPOSITORY_ROOT: root,
			PI_E2E_SHUTDOWN_SENTINEL: sentinel,
		},
		requestTimeoutMs: 15_000,
		shutdownTimeoutMs: 2_000,
	});
	t.after(async () => {
		await rpc.close();
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	const completion = rpc.waitForRecord(
		(record) => record.type === "tool_execution_end" && record.toolName === "goal_complete",
		"goal_complete tool result",
		20_000,
	);
	let settledCount = 0;
	const settled = rpc.waitForRecord(
		(record) => record.type === "agent_settled" && ++settledCount >= 2,
		"both the initial and continuation goal runs to settle",
		20_000,
	);
	const prompt = await rpc.request(
		{ type: "prompt", message: "/goal deterministic CLI E2E completion" },
		20_000,
	);
	assert.equal(prompt.success, true, rpc.diagnostics());
	const completionEvent = await completion;
	assert.equal(completionEvent.isError, false, rpc.diagnostics());
	await settled;

	const state = await rpc.request({ type: "get_state" });
	assert.equal(state.success, true, rpc.diagnostics());
	assert.equal((state.data as { isStreaming: boolean }).isStreaming, false);
	assert.equal((state.data as { pendingMessageCount: number }).pendingMessageCount, 0);

	const messages = await rpc.request({ type: "get_messages" });
	assert.equal(messages.success, true, rpc.diagnostics());
	assert.ok(hasGoalCompletionToolResult(messages), rpc.diagnostics());
	const entries = await rpc.request({ type: "get_entries" });
	assert.equal(entries.success, true, rpc.diagnostics());
	assert.equal(lastPersistedGoal(entries), null, rpc.diagnostics());
	assert.deepEqual(
		rpc.records().filter((record) => record.type === "extension_error"),
		[],
		rpc.diagnostics(),
	);

	await shutdown(rpc);
	assert.equal((JSON.parse(await readFile(sentinel, "utf8")) as { reason: string }).reason, "quit");
});

function hasGoalCompletionToolResult(response: RpcRecord): boolean {
	const data = response.data;
	if (!isRecord(data) || !Array.isArray(data.messages)) return false;
	return data.messages.some(
		(message) =>
			isRecord(message) && message.role === "toolResult" && message.toolName === "goal_complete",
	);
}

function lastPersistedGoal(response: RpcRecord): unknown {
	const data = response.data;
	if (!isRecord(data) || !Array.isArray(data.entries)) return undefined;
	const goalStates = data.entries.filter(
		(entry) => isRecord(entry) && entry.type === "custom" && entry.customType === "goal-state",
	);
	const last = goalStates.at(-1);
	return isRecord(last) && isRecord(last.data) ? last.data.goal : undefined;
}

async function shutdown(rpc: RpcProcess): Promise<void> {
	const notification = rpc.waitForRecord(
		(record) =>
			record.type === "extension_ui_request" && record.message === "PI_E2E_CONTROL shutting down",
		"control shutdown notification",
	);
	const response = await rpc.request({ type: "prompt", message: "/e2e-control shutdown" });
	assert.equal(response.success, true, rpc.diagnostics());
	await notification;
	await rpc.waitForExit(10_000);
	assert.deepEqual(rpc.exitStatus(), { code: 0, signal: null }, rpc.diagnostics());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
