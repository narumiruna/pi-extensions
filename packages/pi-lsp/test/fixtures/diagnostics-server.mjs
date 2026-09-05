import { appendFileSync, writeFileSync } from "node:fs";

const scenario = process.argv[2];
const expectedFiles = Number(process.argv[3] ?? "0");
let buffer = Buffer.alloc(0);
const openedUris = [];

if (scenario === "delayed-sigterm") process.on("SIGTERM", exitAfterDelay);

const lifecycle = scenario.startsWith("lifecycle-");
function record(event) {
	if (process.env.PI_LSP_TEST_LOG) {
		appendFileSync(
			process.env.PI_LSP_TEST_LOG,
			`${JSON.stringify({ pid: process.pid, ...event })}\n`,
		);
	}
}
if (lifecycle) {
	process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25));
	process.on("exit", () => record({ method: "exited" }));
	record({ method: "ready" });
}

function exitAfterDelay() {
	setTimeout(() => {
		writeFileSync(process.env.PI_LSP_TEST_EXIT_MARKER, "exited\n");
		process.exit(0);
	}, 100);
}

function send(message) {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function diagnostic(message, line = 0) {
	return {
		range: {
			start: { line, character: 0 },
			end: { line, character: 1 },
		},
		severity: 1,
		source: "fixture",
		message,
	};
}

// Re-encode a file URI the way editors and some servers do, addressing the same
// file as the URI the client sent. Percent-encode the first letter of the file
// name so the result always differs from the input and the test cannot pass by
// comparing a URI to itself. Servers are selected by file extension, so an
// opened name always contains a letter. Windows also gets the lowercase drive
// letter and encoded colon that marksman and VS Code send.
function alternateEncoding(uri) {
	const withEncodedDrive = uri.replace(
		/^file:\/\/\/([A-Za-z]):\//,
		(_match, drive) => `file:///${drive.toLowerCase()}%3A/`,
	);
	const lastSeparator = withEncodedDrive.lastIndexOf("/");
	const fileName = withEncodedDrive
		.slice(lastSeparator + 1)
		.replace(/[A-Za-z]/, (letter) => `%${letter.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${withEncodedDrive.slice(0, lastSeparator + 1)}${fileName}`;
}

function publish(uri, diagnostics) {
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: { uri, diagnostics },
	});
}

function handle(message) {
	record(message);
	if (lifecycle) {
		if (scenario === `lifecycle-hang-${message.method}`) return;
		if (scenario === `lifecycle-error-${message.method}`) {
			send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32603, message: "intentional operation failure" },
			});
			return;
		}
		if (message.method === "initialize") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					capabilities: { diagnosticProvider: {}, codeActionProvider: { resolveProvider: true } },
				},
			});
			return;
		}
		if (message.method === "textDocument/diagnostic") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { items: scenario === "lifecycle-large" ? [diagnostic("x".repeat(60_000))] : [] },
			});
			return;
		}
		if (message.method === "textDocument/codeAction") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result:
					scenario === "lifecycle-unchanged"
						? []
						: [
								{
									title: "fixture fix",
									kind: "source.fixAll",
									data: { uri: message.params.textDocument.uri },
								},
							],
			});
			return;
		}
		if (message.method === "codeAction/resolve") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					...message.params,
					edit: {
						changes: {
							[message.params.data.uri]: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
									newText: scenario === "lifecycle-large" ? "x".repeat(60_000) : "// fixed\n",
								},
							],
						},
					},
				},
			});
			return;
		}
	}
	if (message.method === "initialize") {
		if (scenario === "require-environment" && process.env.PI_LSP_TEST_ENV !== "forwarded") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32002, message: "required server environment was not forwarded" },
			});
			return;
		}
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				capabilities:
					scenario === "pull-error" ||
					scenario === "pull-strict-optional-params" ||
					scenario === "pull-empty-then-push" ||
					scenario === "pull-empty-after-push" ||
					scenario === "pull-empty-only"
						? {
								diagnosticProvider: {
									interFileDependencies: false,
									workspaceDiagnostics: false,
								},
							}
						: scenario === "resolve-enabled"
							? { codeActionProvider: { resolveProvider: true } }
							: scenario === "resolve-disabled"
								? { codeActionProvider: true }
								: {},
			},
		});
		return;
	}

	if (message.method === "textDocument/didOpen") {
		const uri = message.params.textDocument.uri;
		openedUris.push(uri);
		if (
			scenario !== "push-silent" &&
			scenario !== "push-silent-then-diagnostic" &&
			scenario !== "push-alternate-uri-encoding"
		) {
			publish(uri, []);
		}
		if (scenario === "push-alternate-uri-encoding") {
			setTimeout(
				() => publish(alternateEncoding(uri), [diagnostic("alternate uri encoding diagnostic")]),
				40,
			);
		} else if (scenario === "push-silent-then-diagnostic") {
			setTimeout(() => publish(uri, [diagnostic("late push-only diagnostic")]), 40);
		} else if (scenario === "push-sequence") {
			setTimeout(() => publish(uri, [diagnostic("first")]), 20);
			setTimeout(() => publish(uri, [diagnostic("first"), diagnostic("second", 1)]), 40);
		} else if (scenario === "pull-empty-then-push") {
			setTimeout(() => publish(uri, [diagnostic("late pull-capable diagnostic")]), 40);
		} else if (scenario === "pull-empty-after-push") {
			publish(uri, [diagnostic("already published diagnostic")]);
		} else if (scenario === "batch-push" && openedUris.length === expectedFiles) {
			setTimeout(() => {
				for (const openedUri of openedUris) {
					publish(openedUri, [diagnostic(`ready:${openedUri}`)]);
				}
			}, 5);
		}
		return;
	}

	if (message.method === "textDocument/diagnostic") {
		if (scenario === "pull-strict-optional-params") {
			const hasUnsupportedOptionalParam =
				Object.hasOwn(message.params, "identifier") ||
				Object.hasOwn(message.params, "previousResultId");
			send(
				hasUnsupportedOptionalParam
					? {
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32602, message: "optional diagnostic params must be omitted" },
						}
					: {
							jsonrpc: "2.0",
							id: message.id,
							result: { kind: "full", items: [diagnostic("strict pull diagnostic")] },
						},
			);
			return;
		}
		send(
			scenario === "pull-empty-then-push" ||
				scenario === "pull-empty-after-push" ||
				scenario === "pull-empty-only"
				? { jsonrpc: "2.0", id: message.id, result: { kind: "full", items: [] } }
				: {
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32603, message: "intentional pull failure" },
					},
		);
		return;
	}

	if (message.method === "codeAction/resolve") {
		if (scenario === "resolve-enabled") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { ...message.params, title: `${message.params.title}:resolved` },
			});
		} else {
			send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32603, message: "unexpected code-action resolve" },
			});
		}
		return;
	}

	if (message.method === "shutdown") {
		send({ jsonrpc: "2.0", id: message.id, result: null });
		return;
	}

	if (message.method === "exit") {
		if (scenario === "delayed-exit") exitAfterDelay();
		else process.exit(0);
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const separator = buffer.indexOf("\r\n\r\n");
		if (separator < 0) return;
		const header = buffer.subarray(0, separator).toString("utf8");
		const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
		const bodyStart = separator + 4;
		if (!Number.isFinite(length) || buffer.length < bodyStart + length) return;
		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		handle(JSON.parse(body));
	}
});
