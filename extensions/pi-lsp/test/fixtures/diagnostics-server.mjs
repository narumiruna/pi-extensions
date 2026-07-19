const scenario = process.argv[2];
const expectedFiles = Number(process.argv[3] ?? "0");
let buffer = Buffer.alloc(0);
const openedUris = [];

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

function publish(uri, diagnostics) {
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: { uri, diagnostics },
	});
}

function handle(message) {
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				capabilities:
					scenario === "pull-error"
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
		publish(uri, []);
		if (scenario === "push-sequence") {
			setTimeout(() => publish(uri, [diagnostic("first")]), 20);
			setTimeout(() => publish(uri, [diagnostic("first"), diagnostic("second", 1)]), 40);
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
		send({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32603, message: "intentional pull failure" },
		});
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

	if (message.method === "exit") process.exit(0);
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
