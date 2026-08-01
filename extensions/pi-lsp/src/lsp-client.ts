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

// Quiet period (ms) after each publish before treating push diagnostics as settled.
const PUBLISHED_DIAGNOSTICS_SETTLE_MS = 800;
const PROCESS_DISCOVERY_TIMEOUT_MS = 500;
const PROCESS_LIST_MAX_BYTES = 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 250;

export class LspClient {
	#child?: ChildProcessWithoutNullStreams;
	#terminatedChild?: ChildProcessWithoutNullStreams;
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
	#publishedDiagnostics = new Map<string, { version: number; diagnostics: LspDiagnostic[] }>();
	#diagnosticWaiters = new Map<
		string,
		Set<{
			onPublish: (publication: { version: number; diagnostics: LspDiagnostic[] }) => void;
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
			detached: process.platform !== "win32",
			env: mergeEnvironment(this.#adapter.env),
			stdio: "pipe",
			windowsHide: true,
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
			this.#terminateProcessTree(child);
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
				this.#terminateProcessTree(child);
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
			return this.#waitForPublishedDiagnostics(
				uri,
				this.#adapter.pushDiagnosticsGraceMs
					? {
							afterVersion: 0,
							diagnostics: [],
							waitMs: this.#adapter.pushDiagnosticsGraceMs,
						}
					: undefined,
			);
		}
		const published = this.#publishedDiagnostics.get(uri);
		// Ignore a provisional empty publish, but preserve diagnostics that arrived before the pull.
		const afterVersion = published?.diagnostics.length
			? published.version - 1
			: (published?.version ?? 0);
		const response = await this.request("textDocument/diagnostic", {
			textDocument: { uri },
		});
		const result = response.result as { items?: LspDiagnostic[] } | undefined;
		const diagnostics = result?.items ?? [];
		if (diagnostics.length > 0 || !this.#adapter.pullDiagnosticsGraceMs) return diagnostics;
		return this.#waitForPublishedDiagnostics(uri, {
			afterVersion,
			diagnostics,
			waitMs: this.#adapter.pullDiagnosticsGraceMs,
		});
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
		this.#terminateProcessTree();
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
		this.#terminateProcessTree();
	}

	#terminateProcessTree(child = this.#child) {
		if (!child || this.#terminatedChild === child) return;
		this.#terminatedChild = child;
		if (this.#child === child) this.#child = undefined;

		terminateProcessTree(child);
	}

	private request(method: string, params: unknown) {
		const id = this.#nextId++;

		return new Promise<JsonRpcMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				const message = `${this.#adapter.name} LSP request timed out: ${method}.${this.#formatStderr()}`;
				reject(new Error(message));
				this.#fail(message);
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
				const previousVersion = this.#publishedDiagnostics.get(params.uri)?.version ?? 0;
				const publication = {
					version: previousVersion + 1,
					diagnostics: params.diagnostics ?? [],
				};
				this.#publishedDiagnostics.set(params.uri, publication);
				const waiters = this.#diagnosticWaiters.get(params.uri);
				if (waiters) {
					for (const waiter of [...waiters]) waiter.onPublish(publication);
				}
			}
			return;
		}

		if (Object.hasOwn(message, "id") && message.method) {
			this.#respondToServerRequest(message);
		}
	}

	#waitForPublishedDiagnostics(
		uri: string,
		fallback?: { afterVersion: number; diagnostics: LspDiagnostic[]; waitMs: number },
	) {
		// See PUBLISHED_DIAGNOSTICS_SETTLE_MS. Bounded by #timeoutMs.
		return new Promise<LspDiagnostic[]>((resolve, reject) => {
			let settleTimer: NodeJS.Timeout | undefined;
			let fallbackTimer: NodeJS.Timeout | undefined;
			let overallTimer: NodeJS.Timeout | undefined;
			let sawNonEmptyPublication = false;
			const afterVersion = fallback?.afterVersion ?? 0;

			const dispose = () => {
				if (settleTimer) clearTimeout(settleTimer);
				if (fallbackTimer) clearTimeout(fallbackTimer);
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
			const onPublish = (publication: { version: number; diagnostics: LspDiagnostic[] }) => {
				if (publication.version <= afterVersion) return;
				if (fallback && publication.diagnostics.length === 0 && !sawNonEmptyPublication) return;
				sawNonEmptyPublication ||= publication.diagnostics.length > 0;
				if (fallbackTimer) clearTimeout(fallbackTimer);
				if (settleTimer) clearTimeout(settleTimer);
				settleTimer = setTimeout(
					() => settleWith(this.#publishedDiagnostics.get(uri)?.diagnostics ?? []),
					this.#adapter.diagnosticsSettleMs ?? PUBLISHED_DIAGNOSTICS_SETTLE_MS,
				);
			};

			const waiter = { onPublish, reject: fail, dispose };
			const set = this.#diagnosticWaiters.get(uri) ?? new Set<typeof waiter>();
			set.add(waiter);
			this.#diagnosticWaiters.set(uri, set);

			if (fallback) {
				fallbackTimer = setTimeout(
					() => {
						const latest = this.#publishedDiagnostics.get(uri);
						settleWith(
							latest && latest.version > afterVersion ? latest.diagnostics : fallback.diagnostics,
						);
					},
					Math.min(fallback.waitMs, this.#timeoutMs),
				);
			}
			overallTimer = setTimeout(() => {
				const latest = this.#publishedDiagnostics.get(uri);
				if (latest && latest.version > afterVersion) {
					settleWith(latest.diagnostics);
				} else if (fallback) {
					settleWith(fallback.diagnostics);
				} else {
					fail(
						new Error(
							`${this.#adapter.name} LSP did not return diagnostics for ${uri} before timeout.`,
						),
					);
				}
			}, this.#timeoutMs);

			const existing = this.#publishedDiagnostics.get(uri);
			if (existing) onPublish(existing);
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

function terminateProcessTree(child: ChildProcessWithoutNullStreams) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		terminateWindowsProcessTree(child);
		return;
	}
	void discoverDescendantPids(child.pid).then((descendants) =>
		terminateKnownProcessTree(child, descendants),
	);
}

function terminateKnownProcessTree(child: ChildProcessWithoutNullStreams, descendants: number[]) {
	const descendantsFirst = [...descendants].reverse();
	for (const pid of descendantsFirst) signalProcess(pid, "SIGTERM");
	signalProcessGroup(child, "SIGTERM");
	const escalation = setTimeout(() => {
		for (const pid of descendantsFirst) signalProcess(pid, "SIGKILL");
		signalProcessGroup(child, "SIGKILL");
	}, PROCESS_KILL_GRACE_MS);
	escalation.unref();
}

function discoverDescendantPids(rootPid: number) {
	return new Promise<number[]>((resolve) => {
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const processList = spawn("ps", ["-A", "-o", "ppid=", "-o", "pid="], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const finish = (descendants: number[]) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve(descendants);
		};
		processList.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > PROCESS_LIST_MAX_BYTES) {
				processList.kill("SIGKILL");
				finish([]);
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		processList.once("error", () => finish([]));
		processList.once("close", (code) => {
			finish(code === 0 ? parseDescendantPids(Buffer.concat(chunks).toString(), rootPid) : []);
		});
		timeout = setTimeout(() => {
			processList.kill("SIGKILL");
			finish([]);
		}, PROCESS_DISCOVERY_TIMEOUT_MS);
	});
}

function parseDescendantPids(output: string, rootPid: number) {
	const childrenByParent = new Map<number, number[]>();
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		const parentPid = Number(match[1]);
		const pid = Number(match[2]);
		const children = childrenByParent.get(parentPid) ?? [];
		children.push(pid);
		childrenByParent.set(parentPid, children);
	}

	const descendants: number[] = [];
	const pendingParents = [rootPid];
	const seen = new Set(pendingParents);
	for (let index = 0; index < pendingParents.length; index += 1) {
		for (const pid of childrenByParent.get(pendingParents[index]) ?? []) {
			if (seen.has(pid)) continue;
			seen.add(pid);
			descendants.push(pid);
			pendingParents.push(pid);
		}
	}
	return descendants;
}

function terminateWindowsProcessTree(child: ChildProcessWithoutNullStreams) {
	if (!child.pid) return;
	const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
		stdio: "ignore",
		windowsHide: true,
	});
	const killImmediateChild = () => {
		if (child.pid) signalProcess(child.pid, "SIGKILL");
	};
	killer.once("error", killImmediateChild);
	killer.once("close", (code) => {
		if (code !== 0) killImmediateChild();
	});
	killer.unref();
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
	if (child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall back only while the immediate child is still running.
		}
	}
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill(signal);
	} catch {
		// The process may already have exited.
	}
}

function signalProcess(pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(pid, signal);
	} catch {
		// The process may already have exited or be unavailable to this user.
	}
}

function formatErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
