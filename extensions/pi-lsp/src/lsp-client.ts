import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { commandExists } from "./command.js";
import { directoryUri } from "./files.js";
import { positionAt } from "./text-edits.js";
import type {
	CodeAction,
	JsonRpcMessage,
	LspDiagnostic,
	LspServerAdapter,
	LspTextEdit,
	ServerCommand,
} from "./types.js";

export class LspClient {
	#child?: ChildProcessWithoutNullStreams;
	#buffer = Buffer.alloc(0);
	#nextId = 1;
	#pending = new Map<
		number,
		{
			resolve: (message: JsonRpcMessage) => void;
			reject: (reason: unknown) => void;
			timeout: NodeJS.Timeout;
		}
	>();
	#publishedDiagnostics = new Map<string, LspDiagnostic[]>();
	#diagnosticWaiters = new Map<
		string,
		Array<{
			resolve: (diagnostics: LspDiagnostic[]) => void;
			reject: (reason: unknown) => void;
			timeout: NodeJS.Timeout;
		}>
	>();
	#stderr = "";
	#adapter: LspServerAdapter;
	#command: ServerCommand;
	#cwd: string;
	#timeoutMs: number;

	constructor(adapter: LspServerAdapter, command: ServerCommand, cwd: string, timeoutMs: number) {
		this.#adapter = adapter;
		this.#command = command;
		this.#cwd = cwd;
		this.#timeoutMs = timeoutMs;
	}

	async start() {
		if (!commandExists(this.#command.command, this.#cwd)) {
			throw new Error(
				`${this.#adapter.label} LSP command not found: ${this.#command.command}. ${this.#adapter.missingCommandHint}`,
			);
		}

		const child = spawn(this.#command.command, this.#command.args, {
			cwd: this.#cwd,
			stdio: "pipe",
		});
		this.#child = child;
		child.stdout.on("data", (chunk) => {
			try {
				this.#onData(chunk);
			} catch (error) {
				this.#fail(
					`${this.#adapter.label} LSP server sent invalid JSON-RPC data: ${formatErrorMessage(error)}.${this.#formatStderr()}`,
				);
			}
		});
		child.stderr.on("data", (chunk) => {
			this.#stderr += chunk.toString();
		});
		child.once("exit", (code, signal) => {
			if (this.#child === child) this.#child = undefined;
			const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
			this.#rejectPending(
				(id) =>
					`${this.#adapter.label} LSP server exited before response ${id} (${reason}).${this.#formatStderr()}`,
			);
		});

		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error) => {
				const message = `${this.#adapter.label} LSP process failed to start: ${error.message}.${this.#formatStderr()}`;
				this.#rejectPending(message);
				if (this.#child === child) this.#child = undefined;
				reject(new Error(message));
			});
		});
	}

	async initialize(root: string) {
		const rootUri = directoryUri(root);
		const init = this.#adapter.initialize;
		await this.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: path.basename(root) || "workspace" }],
			capabilities: {
				textDocument: {
					...(init.codeAction
						? {
								codeAction: {
									dynamicRegistration: init.codeActionDynamicRegistration,
									resolveSupport: { properties: ["edit"] },
								},
							}
						: {}),
					diagnostic: { dynamicRegistration: init.diagnosticDynamicRegistration },
					...(init.formattingDynamicRegistration === undefined
						? {}
						: { formatting: { dynamicRegistration: init.formattingDynamicRegistration } }),
					publishDiagnostics: {},
					synchronization: {
						didSave: true,
						...(init.didSaveDynamicRegistration === undefined
							? {}
							: { dynamicRegistration: init.didSaveDynamicRegistration }),
					},
				},
				workspace: {
					configuration: true,
					...(init.didChangeConfigurationDynamicRegistration === undefined
						? {}
						: {
								didChangeConfiguration: {
									dynamicRegistration: init.didChangeConfigurationDynamicRegistration,
								},
							}),
					workspaceEdit: { documentChanges: true },
					workspaceFolders: true,
				},
			},
		});
		this.notify("initialized", {});
		if (this.#adapter.fallbackToPublishDiagnostics) await wait(300);
	}

	didOpen(uri: string, text: string, languageId: string) {
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
	}

	didClose(uri: string) {
		if (!this.#child) return false;
		this.notify("textDocument/didClose", {
			textDocument: { uri },
		});
		return true;
	}

	async diagnostics(uri: string) {
		try {
			const response = await this.request("textDocument/diagnostic", {
				textDocument: { uri },
				identifier: null,
				previousResultId: null,
			});
			const result = response.result as { items?: LspDiagnostic[] } | undefined;
			return result?.items ?? [];
		} catch (error) {
			if (!this.#adapter.fallbackToPublishDiagnostics || !isUnsupportedMethodError(error)) throw error;
			return this.#waitForPublishedDiagnostics(uri);
		}
	}

	async format(uri: string) {
		const response = await this.request("textDocument/formatting", {
			textDocument: { uri },
			options: this.#adapter.formattingOptions,
		});
		return (response.result as LspTextEdit[] | null | undefined) ?? [];
	}

	async codeActions(uri: string, text: string, diagnostics: LspDiagnostic[], kind: string) {
		const response = await this.request("textDocument/codeAction", {
			textDocument: { uri },
			range: { start: { line: 0, character: 0 }, end: positionAt(text, text.length) },
			context: { diagnostics, only: [kind] },
		});
		return (response.result as CodeAction[] | null | undefined) ?? [];
	}

	async resolveActions(actions: CodeAction[]) {
		const resolvedActions: CodeAction[] = [];
		for (const action of actions) {
			if (action.edit) {
				resolvedActions.push(action);
				continue;
			}

			try {
				const response = await this.request("codeAction/resolve", action);
				resolvedActions.push((response.result as CodeAction | undefined) ?? action);
			} catch (error) {
				if (!this.#adapter.resolveUnsupportedCodeActions || !isUnsupportedMethodError(error)) throw error;
				resolvedActions.push(action);
			}
		}

		return resolvedActions;
	}

	async shutdown() {
		if (!this.#child) return;

		try {
			await this.request("shutdown", null);
			this.notify("exit", undefined);
		} catch {
			// The process may already be gone; close below still guarantees cleanup.
		} finally {
			this.close();
		}
	}

	close() {
		this.#rejectPending(`${this.#adapter.label} LSP request cancelled.`);

		if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
		this.#child = undefined;
	}

	#rejectPending(message: string | ((id: number | "diagnostics") => string)) {
		for (const [id, pending] of this.#pending.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(typeof message === "string" ? message : message(id)));
		}
		this.#pending.clear();
		for (const waiters of this.#diagnosticWaiters.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timeout);
				waiter.reject(new Error(typeof message === "string" ? message : message("diagnostics")));
			}
		}
		this.#diagnosticWaiters.clear();
	}

	#fail(message: string) {
		this.#rejectPending(message);
		if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
		this.#child = undefined;
	}

	private request(method: string, params: unknown) {
		const id = this.#nextId++;

		return new Promise<JsonRpcMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(
					new Error(`${this.#adapter.label} LSP request timed out: ${method}.${this.#formatStderr()}`),
				);
			}, this.#timeoutMs);
			this.#pending.set(id, { resolve, reject, timeout });

			try {
				this.#send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				clearTimeout(timeout);
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	private notify(method: string, params: unknown) {
		this.#send(
			params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
		);
	}

	#send(message: JsonRpcMessage) {
		if (!this.#child) throw new Error(`${this.#adapter.label} LSP server is not running.`);

		const body = JSON.stringify(message);
		this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	#onData(chunk: Buffer) {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);

		while (true) {
			const separator = this.#buffer.indexOf("\r\n\r\n");
			if (separator < 0) return;

			const header = this.#buffer.subarray(0, separator).toString("utf8");
			const contentLength = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
			if (!contentLength) throw new Error(`Invalid LSP response header: ${header}`);

			const bodyStart = separator + 4;
			const bodyLength = Number(contentLength);
			if (this.#buffer.length < bodyStart + bodyLength) return;

			const rawBody = this.#buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
			this.#buffer = this.#buffer.subarray(bodyStart + bodyLength);
			this.#handleMessage(JSON.parse(rawBody) as JsonRpcMessage);
		}
	}

	#handleMessage(message: JsonRpcMessage) {
		if (Object.hasOwn(message, "id") && !message.method) {
			const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
			if (!pending) return;

			clearTimeout(pending.timeout);
			this.#pending.delete(message.id as number);
			if (message.error) {
				pending.reject(new Error(`${this.#adapter.label} LSP error: ${message.error.message}`));
			} else {
				pending.resolve(message);
			}
			return;
		}

		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
			if (params?.uri) {
				const diagnostics = params.diagnostics ?? [];
				this.#publishedDiagnostics.set(params.uri, diagnostics);
				const waiters = this.#diagnosticWaiters.get(params.uri) ?? [];
				this.#diagnosticWaiters.delete(params.uri);
				for (const waiter of waiters) {
					clearTimeout(waiter.timeout);
					waiter.resolve(diagnostics);
				}
			}
			return;
		}

		if (Object.hasOwn(message, "id") && message.method) {
			this.#respondToServerRequest(message);
		}
	}

	#waitForPublishedDiagnostics(uri: string) {
		const diagnostics = this.#publishedDiagnostics.get(uri);
		if (diagnostics) return Promise.resolve(diagnostics);

		return new Promise<LspDiagnostic[]>((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					const waiters = this.#diagnosticWaiters.get(uri)?.filter((entry) => entry !== waiter) ?? [];
					if (waiters.length) this.#diagnosticWaiters.set(uri, waiters);
					else this.#diagnosticWaiters.delete(uri);
					resolve(this.#publishedDiagnostics.get(uri) ?? []);
				}, this.#timeoutMs),
			};
			this.#diagnosticWaiters.set(uri, [...(this.#diagnosticWaiters.get(uri) ?? []), waiter]);
		});
	}

	#respondToServerRequest(message: JsonRpcMessage) {
		let result: unknown = null;
		if (message.method === "workspace/configuration") {
			const params = message.params as { items?: unknown[] } | undefined;
			result = (params?.items ?? []).map(() => ({}));
		} else if (this.#adapter.serverRequestWorkspaceFolders && message.method === "workspace/workspaceFolders") {
			const rootUri = directoryUri(this.#cwd);
			result = [{ uri: rootUri, name: path.basename(this.#cwd) || "workspace" }];
		} else if (message.method === "client/registerCapability") {
			result = null;
		}

		this.#send({ jsonrpc: "2.0", id: message.id, result });
	}

	#formatStderr() {
		const stderr = this.#stderr.trim();
		return stderr ? `\nServer stderr:\n${stderr}` : "";
	}
}

function isUnsupportedMethodError(error: unknown) {
	return error instanceof Error && /method not found|not supported|unsupported/i.test(error.message);
}

function formatErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
