import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { commandPathValue, mergeEnvironment, resolveCommandPath } from "./command.js";
import { directoryUri } from "./files.js";
import { positionAt } from "./text-edits.js";
import type {
	CodeAction,
	JsonRpcMessage,
	LspDiagnostic,
	LspServerAdapter,
	ServerCommand,
} from "./types.js";

export function resolveSpawnCommand(
	command: ServerCommand,
	platform: NodeJS.Platform = process.platform,
	comSpec = process.env.ComSpec,
): ServerCommand {
	if (platform !== "win32" || !/\.(?:bat|cmd)$/i.test(command.command)) return command;
	return {
		command: comSpec?.trim() || "cmd.exe",
		args: ["/d", "/s", "/c", command.command, ...command.args],
	};
}

// Quiet period (ms) to wait after an empty publish for a later non-empty one
// before settling. Non-empty publishes settle immediately.
const PUBLISHED_DIAGNOSTICS_SETTLE_MS = 800;

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
		Set<{
			onPublish: (diagnostics: LspDiagnostic[]) => void;
			reject: (reason: unknown) => void;
			dispose: () => void;
		}>
	>();
	#stderr = "";
	#serverCapabilities: Record<string, unknown> = {};
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
		const commandPath = resolveCommandPath(
			this.#command.command,
			this.#cwd,
			process.platform,
			commandPathValue(this.#adapter.env),
		);
		if (!commandPath) {
			throw new Error(
				`${this.#adapter.name} LSP command not found: ${this.#command.command}. ${this.#adapter.missingCommandHint}`,
			);
		}

		const spawnCommand = resolveSpawnCommand({ ...this.#command, command: commandPath });
		const child = spawn(spawnCommand.command, spawnCommand.args, {
			cwd: this.#cwd,
			env: mergeEnvironment(this.#adapter.env),
			stdio: "pipe",
		});
		this.#child = child;
		child.stdout.on("data", (chunk) => {
			try {
				this.#onData(chunk);
			} catch (error) {
				this.#fail(
					`${this.#adapter.name} LSP server sent invalid JSON-RPC data: ${formatErrorMessage(error)}.${this.#formatStderr()}`,
				);
			}
		});
		child.stderr.on("data", (chunk) => {
			this.#stderr += chunk.toString();
		});
		child.stdin.on("error", (error) => {
			this.#fail(
				`${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.${this.#formatStderr()}`,
			);
		});
		child.once("exit", (code, signal) => {
			if (this.#child === child) this.#child = undefined;
			const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
			this.#rejectPending(
				(id) =>
					`${this.#adapter.name} LSP server exited before response ${id} (${reason}).${this.#formatStderr()}`,
			);
		});

		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error) => {
				const message = `${this.#adapter.name} LSP process failed to start: ${error.message}.${this.#formatStderr()}`;
				this.#rejectPending(message);
				if (this.#child === child) this.#child = undefined;
				reject(new Error(message));
			});
		});
	}

	async initialize(root: string) {
		const rootUri = directoryUri(root);
		const workspaceFolders = [{ uri: rootUri, name: path.basename(root) || "workspace" }];
		const response = await this.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders,
			initializationOptions: this.#adapter.initialization ?? {},
			capabilities: {
				textDocument: {
					// This spawn-per-call client can't track dynamic registrations, so
					// capabilities must be advertised statically.
					codeAction: {
						dynamicRegistration: false,
						resolveSupport: { properties: ["edit"] },
					},
					diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
					publishDiagnostics: {},
					synchronization: { didSave: true },
				},
				workspace: {
					configuration: true,
					workspaceEdit: { documentChanges: true },
					workspaceFolders: true,
				},
			},
		});
		this.#serverCapabilities =
			(response.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ??
			{};
		this.notify("initialized", {});
		if (this.#adapter.initialization) {
			this.notify("workspace/didChangeConfiguration", { settings: this.#adapter.initialization });
		}
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
		// Only pull if the server advertised it; otherwise use push diagnostics.
		if (!this.#serverCapabilities.diagnosticProvider) {
			return this.#waitForPublishedDiagnostics(uri);
		}
		try {
			const response = await this.request("textDocument/diagnostic", {
				textDocument: { uri },
				identifier: null,
				previousResultId: null,
			});
			const result = response.result as { items?: LspDiagnostic[] } | undefined;
			return result?.items ?? [];
		} catch {
			// Advertised pull but the request failed; fall back to pushed diagnostics.
			return this.#waitForPublishedDiagnostics(uri);
		}
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
		// Only resolve when the server advertised resolveProvider; otherwise use the
		// action as-is. Any error from an advertised resolve is real and propagates.
		const codeActionProvider = this.#serverCapabilities.codeActionProvider;
		const canResolve =
			typeof codeActionProvider === "object" &&
			codeActionProvider !== null &&
			(codeActionProvider as { resolveProvider?: boolean }).resolveProvider === true;

		const resolvedActions: CodeAction[] = [];
		for (const action of actions) {
			if (action.edit || !canResolve) {
				resolvedActions.push(action);
				continue;
			}

			const response = await this.request("codeAction/resolve", action);
			resolvedActions.push((response.result as CodeAction | undefined) ?? action);
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
		this.#rejectPending(`${this.#adapter.name} LSP request cancelled.`);

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
			for (const waiter of [...waiters]) {
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
					new Error(
						`${this.#adapter.name} LSP request timed out: ${method}.${this.#formatStderr()}`,
					),
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
		if (!this.#child) throw new Error(`${this.#adapter.name} LSP server is not running.`);

		const body = JSON.stringify(message);
		try {
			this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
		} catch (error) {
			const errorMessage =
				`${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.` +
				this.#formatStderr();
			this.#fail(errorMessage);
			throw new Error(errorMessage);
		}
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
				pending.reject(new Error(`${this.#adapter.name} LSP error: ${message.error.message}`));
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
				const waiters = this.#diagnosticWaiters.get(params.uri);
				if (waiters) {
					for (const waiter of [...waiters]) waiter.onPublish(diagnostics);
				}
			}
			return;
		}

		if (Object.hasOwn(message, "id") && message.method) {
			this.#respondToServerRequest(message);
		}
	}

	#waitForPublishedDiagnostics(uri: string) {
		// See PUBLISHED_DIAGNOSTICS_SETTLE_MS. Bounded by #timeoutMs.
		return new Promise<LspDiagnostic[]>((resolve, reject) => {
			let settleTimer: NodeJS.Timeout | undefined;
			let overallTimer: NodeJS.Timeout | undefined;

			const dispose = () => {
				if (settleTimer) clearTimeout(settleTimer);
				if (overallTimer) clearTimeout(overallTimer);
				const set = this.#diagnosticWaiters.get(uri);
				set?.delete(waiter);
				if (set && set.size === 0) this.#diagnosticWaiters.delete(uri);
			};
			const settleWith = (diagnostics: LspDiagnostic[]) => {
				dispose();
				resolve(diagnostics);
			};
			const fail = (reason: unknown) => {
				dispose();
				reject(reason);
			};
			const onPublish = (diagnostics: LspDiagnostic[]) => {
				if (diagnostics.length > 0) {
					settleWith(diagnostics);
					return;
				}
				if (settleTimer) clearTimeout(settleTimer);
				settleTimer = setTimeout(
					() => settleWith(this.#publishedDiagnostics.get(uri) ?? []),
					this.#adapter.diagnosticsSettleMs ?? PUBLISHED_DIAGNOSTICS_SETTLE_MS,
				);
			};

			const waiter = { onPublish, reject: fail, dispose };
			const set = this.#diagnosticWaiters.get(uri) ?? new Set<typeof waiter>();
			set.add(waiter);
			this.#diagnosticWaiters.set(uri, set);

			overallTimer = setTimeout(() => {
				const latest = this.#publishedDiagnostics.get(uri);
				if (latest !== undefined) {
					settleWith(latest);
				} else {
					fail(
						new Error(
							`${this.#adapter.name} LSP did not return diagnostics for ${uri} before timeout.`,
						),
					);
				}
			}, this.#timeoutMs);

			const existing = this.#publishedDiagnostics.get(uri);
			if (existing !== undefined) onPublish(existing);
		});
	}

	#respondToServerRequest(message: JsonRpcMessage) {
		if (message.method === "workspace/configuration") {
			const params = message.params as { items?: Array<{ section?: string }> } | undefined;
			this.#send({
				jsonrpc: "2.0",
				id: message.id,
				result: (params?.items ?? []).map((item) => this.#configurationValue(item.section)),
			});
			return;
		}

		if (message.method === "workspace/workspaceFolders") {
			const rootUri = directoryUri(this.#cwd);
			this.#send({
				jsonrpc: "2.0",
				id: message.id,
				result: [{ uri: rootUri, name: path.basename(this.#cwd) || "workspace" }],
			});
			return;
		}

		if (
			message.method === "client/registerCapability" ||
			message.method === "client/unregisterCapability"
		) {
			this.#send({ jsonrpc: "2.0", id: message.id, result: null });
			return;
		}

		this.#send({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: `Method not found: ${message.method ?? "unknown"}` },
		});
	}

	#configurationValue(section: string | undefined) {
		if (!section) return this.#adapter.initialization ?? {};
		return this.#adapter.initialization?.[section] ?? {};
	}

	#formatStderr() {
		const stderr = this.#stderr.trim();
		return stderr ? `\nServer stderr:\n${stderr}` : "";
	}
}

function formatErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
