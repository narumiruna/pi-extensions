import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	JsonlDecoder,
	resolveRepositoryPiInvocation,
	spawnRpcProcess,
} from "./support/pi-rpc-harness.js";

const fakeRpcChild = path.join(process.cwd(), "e2e", "fixtures", "fake-rpc-child.mjs");

async function waitUntilNotRunning(pid: number, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}

		// PID 0 probes also succeed for zombies. A zombie cannot execute or retain inherited
		// resources, so treat it as stopped while its new parent finishes reaping it.
		const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
			encoding: "utf8",
		});
		if (status.status !== 0 || /^Z/.test(status.stdout.trim())) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`process ${pid} remained running`);
}

test("repository Pi invocation resolves the installed package binary through Node", () => {
	const invocation = resolveRepositoryPiInvocation(process.cwd());
	assert.equal(invocation.command, process.execPath);
	assert.equal(invocation.args.length, 1);
	assert.match(invocation.args[0] ?? "", /pi-coding-agent.*dist.*cli\.js$/);
});

test("JsonlDecoder handles fragmented UTF-8, CRLF, and Unicode separators", () => {
	const decoder = new JsonlDecoder();
	const payload = `${JSON.stringify({ text: "片段\u2028保留\u2029完成" })}\r\n${JSON.stringify({ ok: true })}\n`;
	const bytes = Buffer.from(payload);
	const records = [
		...decoder.push(bytes.subarray(0, 2)),
		...decoder.push(bytes.subarray(2, 7)),
		...decoder.push(bytes.subarray(7, bytes.length - 1)),
		...decoder.push(bytes.subarray(bytes.length - 1)),
		...decoder.end(),
	];

	assert.deepEqual(records, [{ text: "片段\u2028保留\u2029完成" }, { ok: true }]);
});

test("JsonlDecoder rejects malformed and unterminated records", () => {
	const malformed = new JsonlDecoder();
	assert.throws(() => malformed.push("{bad}\n"), /invalid RPC JSON/i);

	const trailing = new JsonlDecoder();
	trailing.push('{"partial":true}');
	assert.throws(() => trailing.end(), /unterminated RPC JSON/i);
});

test("RPC requests correlate out-of-order responses by id", async (t) => {
	await access(fakeRpcChild);
	const rpc = spawnRpcProcess({
		command: process.execPath,
		args: [fakeRpcChild, "correlate"],
		requestTimeoutMs: 1_000,
		shutdownTimeoutMs: 100,
	});
	t.after(() => rpc.close());

	const first = rpc.request({ type: "first" });
	const second = rpc.request({ type: "second" });
	const [firstResponse, secondResponse] = await Promise.all([first, second]);
	assert.equal(firstResponse.command, "first");
	assert.equal(secondResponse.command, "second");
	await rpc.close();
	assert.deepEqual(rpc.exitStatus(), { code: 0, signal: null });
});

test("record predicate failures reject consistently for retained records", async (t) => {
	const rpc = spawnRpcProcess({
		command: process.execPath,
		args: [fakeRpcChild, "correlate"],
		requestTimeoutMs: 1_000,
		shutdownTimeoutMs: 100,
	});
	t.after(() => rpc.close());
	await Promise.all([rpc.request({ type: "first" }), rpc.request({ type: "second" })]);

	await assert.rejects(
		rpc.waitForRecord(() => {
			throw new Error("predicate exploded");
		}, "impossible record"),
		/predicate failed.*predicate exploded/i,
	);
});

test("RPC diagnostics include bounded stderr when the child exits unexpectedly", async (t) => {
	const rpc = spawnRpcProcess({
		command: process.execPath,
		args: [fakeRpcChild, "fail"],
		requestTimeoutMs: 1_000,
		shutdownTimeoutMs: 100,
	});
	t.after(() => rpc.close());

	await assert.rejects(rpc.request({ type: "explode" }), /exit code 7[\s\S]*fixture failure/);
	assert.match(rpc.diagnostics(), /fixture failure/);
});

test("RPC request deadlines reject and close terminates the child", async () => {
	const rpc = spawnRpcProcess({
		command: process.execPath,
		args: [fakeRpcChild, "hang"],
		requestTimeoutMs: 50,
		shutdownTimeoutMs: 50,
	});
	await assert.rejects(rpc.request({ type: "never" }), /timed out.*never/i);
	await rpc.close();
	assert.equal(rpc.isRunning(), false);
});

test("forced close terminates descendants that retain inherited resources", {
	skip: process.platform === "win32" ? "POSIX process-group assertion" : false,
}, async () => {
	const rpc = spawnRpcProcess({
		command: process.execPath,
		args: [fakeRpcChild, "descendant"],
		requestTimeoutMs: 1_000,
		shutdownTimeoutMs: 50,
	});
	const response = await rpc.request({ type: "child" });
	const childPid = (response.data as { pid: number }).pid;
	await rpc.close();
	await waitUntilNotRunning(childPid);
});
