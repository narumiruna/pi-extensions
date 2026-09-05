import assert from "node:assert/strict";
import { appendFileSync, closeSync } from "node:fs";

const [scenario, log] = process.argv.slice(2);
let buffer = Buffer.alloc(0);
const requests = [];
const replies = new Map();
function record(method) {
	appendFileSync(log, `${JSON.stringify({ method, pid: process.pid })}\n`);
}
function frame(message) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
function send(message) {
	process.stdout.write(frame(message));
}
async function handle(message) {
	record(message.method ?? `response:${message.id}`);
	if (!message.method) {
		replies.set(message.id, message);
		if (replies.size === 5) {
			assert.deepEqual(replies.get("config").result, [{}, {}, {}]);
			assert.equal(replies.get(0).result.length, 1);
			assert.equal(replies.get("register").result, null);
			assert.equal(replies.get("unregister").result, null);
			assert.equal(replies.get("unknown").error.code, -32601);
			send({ id: requests[0].id, result: { capabilities: {} } });
		}
		return;
	}
	if (message.method === "initialize") {
		if (scenario === "server-requests") {
			requests.push(message);
			for (const [id, method, params] of [
				[
					"config",
					"workspace/configuration",
					{ items: [{}, { section: "ty" }, { section: "ruff" }] },
				],
				[0, "workspace/workspaceFolders", {}],
				["register", "client/registerCapability", {}],
				["unregister", "client/unregisterCapability", {}],
				["unknown", "fixture/unknown", {}],
			])
				send({ id, method, params });
		} else send({ id: message.id, result: { capabilities: {} } });
		return;
	}
	if (message.method === "textDocument/codeAction") {
		const result = [{ title: message.params.context.only[0] }];
		if (scenario === "split") {
			const data = frame({ id: message.id, result });
			// Force separate writes across the header separator and inside a UTF-8 code point.
			const split = data.indexOf(Buffer.from("語")) + 1;
			for (const part of [
				data.subarray(0, 12),
				data.subarray(12, 21),
				data.subarray(21, split),
				data.subarray(split),
			]) {
				await new Promise((resolve) => process.stdout.write(part, resolve));
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		} else if (scenario === "multiple") {
			process.stdout.write(
				Buffer.concat([
					frame({ method: "fixture/ignored", params: { text: "語🙂" } }),
					frame({ id: 999999, result: null }),
					frame({ id: message.id, result }),
				]),
			);
		} else if (scenario === "out-of-order") {
			requests.push({ id: message.id, result });
			if (requests.length === 2) process.stdout.write(Buffer.concat(requests.reverse().map(frame)));
		} else if (scenario === "late") {
			requests.push({ id: message.id, result });
			if (requests.length === 2) process.stdout.write(Buffer.concat(requests.map(frame)));
		} else if (scenario === "bad-header") process.stdout.write("Invalid: header\r\n\r\n");
		else if (scenario === "bad-json") process.stdout.write("Content-Length: 1\r\n\r\n{");
		else if (scenario === "partial") process.stdout.write("Content-Length: 100\r\n\r\n{");
		else if (scenario === "exit") {
			process.stderr.write("intentional transport exit\n", () => process.exit(7));
		} else if (scenario === "stdout-close") process.stdout.end();
		else if (scenario !== "hang") send({ id: message.id, result });
		return;
	}
	if (message.method === "shutdown") send({ id: message.id, result: null });
	if (message.method === "exit") process.exit(0);
}
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => record("exited"));
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const separator = buffer.indexOf("\r\n\r\n");
		if (separator < 0) return;
		const length = Number(
			/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, separator).toString())?.[1],
		);
		const end = separator + 4 + length;
		if (buffer.length < end) return;
		const message = JSON.parse(buffer.subarray(separator + 4, end).toString());
		buffer = buffer.subarray(end);
		void handle(message);
	}
});
if (scenario === "stdin-close") {
	// Keep the process alive after its input pipe closes, then acknowledge the closed fd.
	process.stdin.destroy();
	closeSync(0);
	setInterval(() => {}, 1000);
}
record("ready");
