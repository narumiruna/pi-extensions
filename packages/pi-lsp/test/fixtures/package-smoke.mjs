// Non-interactive package-directory smoke with a loopback-only scripted provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-package-smoke-"));
const agentDir = path.join(root, "agent");
mkdirSync(agentDir);
const file = path.join(root, "main.go");
const log = path.join(root, "lsp.jsonl");
const lifecycleLog = path.join(root, "lifecycle.jsonl");
writeFileSync(file, "package main\n");
let requestCount = 0;
const server = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		assert.equal(request.url, "/v1/chat/completions");
		assert.deepEqual(
			input.tools.map((tool) => tool.function.name),
			["lsp_diagnostics", "lsp_fix"],
		);
		requestCount++;
		const last = input.messages.at(-1);
		const toolResult = last.role === "tool";
		const content = input.messages.findLast((message) => message.role === "user").content;
		const prompt =
			typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
		const name = prompt.includes("diagnostics") ? "lsp_diagnostics" : "lsp_fix";
		const args =
			name === "lsp_diagnostics"
				? { root, paths: ["main.go"] }
				: { root, path: "main.go", write: prompt.includes("write") };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(
			`data: ${JSON.stringify({ id: `fixture-${requestCount}`, object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: toolResult ? { role: "assistant", content: "done" } : { role: "assistant", tool_calls: [{ index: 0, id: `call-${requestCount}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: toolResult ? "stop" : "tool_calls" }] })}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	} catch (error) {
		response.writeHead(500);
		response.end(String(error));
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
writeFileSync(
	path.join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			"lifecycle-fixture": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "fixture",
				models: [{ id: "fixture" }],
			},
		},
	}),
);
writeFileSync(
	path.join(agentDir, "settings.json"),
	JSON.stringify({ enableInstallTelemetry: false, retry: { enabled: false } }),
);
writeFileSync(
	path.join(agentDir, "pi-lsp.json"),
	JSON.stringify({
		timeout: 1_000,
		servers: {
			fixture: {
				command: [
					process.execPath,
					path.resolve("packages/pi-lsp/test/fixtures/diagnostics-server.mjs"),
					"lifecycle-normal",
				],
				extensions: [".go"],
				env: { PI_LSP_TEST_LOG: log },
			},
		},
	}),
);
const helper = path.join(root, "smoke.ts");
writeFileSync(
	helper,
	`import { appendFileSync } from "node:fs";
export default function(pi) {
	pi.registerCommand("smoke-reload", { handler: async (_args, ctx) => { await ctx.reload(); return; } });
	pi.registerCommand("smoke-quit", { handler: async (_args, ctx) => { ctx.shutdown(); } });
	for (const event of ["session_start", "session_shutdown"]) pi.on(event, (data) => {
		appendFileSync(${JSON.stringify(lifecycleLog)}, JSON.stringify(data) + "\\n");
	});
}`,
);
const args = [
	"--mode",
	"rpc",
	"--offline",
	"--no-approve",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-builtin-tools",
	"--provider",
	"lifecycle-fixture",
	"--model",
	"fixture",
	"-e",
	"./packages/pi-lsp",
	"-e",
	helper,
];
const child = spawn("pi", args, {
	cwd: process.cwd(),
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	stdio: "pipe",
});
const exited = once(child, "exit");
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
let buffer = "";
const events = [];
const listeners = new Set();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	while (buffer.includes("\n")) {
		const newline = buffer.indexOf("\n");
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
			for (const notify of listeners) notify();
		} catch {
			stderr += `Invalid RPC line: ${line}\n`;
		}
	}
});
const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
let deadline;
function waitFor(predicate, offset = 0) {
	return new Promise((resolve, reject) => {
		function check() {
			const event = events.slice(offset).find(predicate);
			if (event) {
				cleanup();
				resolve(event);
			}
		}
		function failed() {
			cleanup();
			reject(new Error(`Pi exited before expected event: ${stderr}`));
		}
		function cleanup() {
			listeners.delete(check);
			child.off("exit", failed);
		}
		listeners.add(check);
		child.once("exit", failed);
		check();
	});
}
async function command(id, message) {
	const offset = events.length;
	send({ id, type: "prompt", message });
	const response = await waitFor((event) => event.type === "response" && event.id === id, offset);
	assert.equal(response.success, true, JSON.stringify(response));
	return offset;
}
async function run(id, message) {
	const offset = await command(id, message);
	await waitFor((event) => event.type === "agent_settled", offset);
	const result = events.slice(offset).find((event) => event.type === "tool_execution_end");
	assert.ok(result, JSON.stringify(events.slice(offset)));
	assert.equal(result.isError, false, JSON.stringify(result));
	return result.result;
}
try {
	send({ id: "ready", type: "get_commands" });
	const ready = await waitFor((event) => event.type === "response" && event.id === "ready");
	assert.equal(ready.success, true);
	assert.ok(ready.data.commands.some((command) => command.name === "lsp"));
	// The subprocess deadline begins only after its RPC readiness handshake.
	deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
	const diagnostic = await run("diagnostics", "diagnostics");
	assert.match(diagnostic.content[0].text, /0 diagnostic\(s\)/);
	const preview = await run("preview", "preview");
	assert.equal(preview.details.text, "// fixed\npackage main\n");
	assert.equal(readFileSync(file, "utf8"), "package main\n");
	const written = await run("write", "write");
	assert.equal(written.details.write, true);
	assert.equal(readFileSync(file, "utf8"), "// fixed\npackage main\n");
	await command("reload", "/smoke-reload");
	await run("after-reload", "diagnostics after reload");
	await command("quit", "/smoke-quit");
	const [code, signal] = await exited;
	assert.equal(code, 0, `${signal}: ${stderr}`);
	assert.ok(!events.some((event) => event.type === "extension_error"), JSON.stringify(events));
	const records = readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const pids = [...new Set(records.map((event) => event.pid))];
	assert.equal(pids.length, 4);
	for (const pid of pids) {
		assert.ok(records.some((event) => event.pid === pid && event.method === "exited"));
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
	}
	const lifecycle = readFileSync(lifecycleLog, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		lifecycle.map(({ type, reason }) => [type, reason]),
		[
			["session_start", "startup"],
			["session_shutdown", "reload"],
			["session_start", "reload"],
			["session_shutdown", "quit"],
		],
	);
	console.log(
		JSON.stringify({
			package: "pi-lsp",
			mode: "rpc",
			diagnostics: "passed",
			preview: "passed",
			write: "passed",
			reload: "passed",
			shutdown: "passed",
			exitedServers: pids.length,
			providerRequests: requestCount,
			liveProvider: false,
		}),
	);
} finally {
	clearTimeout(deadline);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await exited;
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
