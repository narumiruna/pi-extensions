import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export type RpcRecord = Record<string, unknown>;
export type RpcResponse = RpcRecord & {
	type: "response";
	id?: string;
	command?: string;
	success: boolean;
};

export interface SpawnRpcProcessOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
	shutdownTimeoutMs?: number;
	maxDiagnosticBytes?: number;
	maxRecordBytes?: number;
}

export interface SpawnPiRpcOptions {
	root: string;
	cwd: string;
	agentDir: string;
	sessionDir: string;
	extensionPaths?: readonly string[];
	args?: readonly string[];
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
	shutdownTimeoutMs?: number;
}

export interface CommandInvocation {
	command: string;
	args: string[];
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface RecordWaiter {
	predicate: (record: RpcRecord) => boolean;
	resolve: (record: RpcRecord) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_RECORD_BYTES = 1024 * 1024;
const DEFAULT_DIAGNOSTIC_BYTES = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_RETAINED_RECORDS = 100;
const CHILD_ENV_ALLOWLIST = new Set([
	"CI",
	"COLORTERM",
	"COMSPEC",
	"FORCE_COLOR",
	"LANG",
	"NO_COLOR",
	"PATH",
	"PATHEXT",
	"SHELL",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"TZ",
	"WINDIR",
]);

export class JsonlDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";

	constructor(private readonly maxRecordBytes = DEFAULT_RECORD_BYTES) {
		if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
			throw new Error("maxRecordBytes must be a positive safe integer");
		}
	}

	push(chunk: string | Uint8Array): RpcRecord[] {
		this.buffer +=
			typeof chunk === "string"
				? this.decoder.write(Buffer.from(chunk))
				: this.decoder.write(chunk);
		return this.drain(false);
	}

	end(): RpcRecord[] {
		this.buffer += this.decoder.end();
		return this.drain(true);
	}

	private drain(ended: boolean): RpcRecord[] {
		const records: RpcRecord[] = [];
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			records.push(this.parse(line));
		}

		if (Buffer.byteLength(this.buffer, "utf8") > this.maxRecordBytes) {
			throw new Error(`RPC JSON record exceeds ${this.maxRecordBytes} bytes`);
		}
		if (ended && this.buffer.length > 0) {
			throw new Error("Unterminated RPC JSON record at end of stream");
		}
		return records;
	}

	private parse(line: string): RpcRecord {
		if (Buffer.byteLength(line, "utf8") > this.maxRecordBytes) {
			throw new Error(`RPC JSON record exceeds ${this.maxRecordBytes} bytes`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`Invalid RPC JSON record: ${formatError(error)}`);
		}
		if (!isRecord(parsed)) throw new Error("Invalid RPC JSON record: expected an object");
		return parsed;
	}
}

export class RpcProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly decoder: JsonlDecoder;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly waiters = new Set<RecordWaiter>();
	private readonly retainedRecords: RpcRecord[] = [];
	private readonly requestTimeoutMs: number;
	private readonly shutdownTimeoutMs: number;
	private readonly maxDiagnosticBytes: number;
	private stderrTail = "";
	private stderrTruncated = false;
	private nextId = 0;
	private closePromise?: Promise<void>;
	private closed = false;
	private protocolError?: Error;
	private closeCode: number | null | undefined;
	private closeSignal: NodeJS.Signals | null | undefined;
	private readonly exited: Promise<void>;
	private resolveExited!: () => void;

	constructor(options: SpawnRpcProcessOptions) {
		this.requestTimeoutMs = positiveDuration(
			options.requestTimeoutMs,
			DEFAULT_REQUEST_TIMEOUT_MS,
			"requestTimeoutMs",
		);
		this.shutdownTimeoutMs = positiveDuration(
			options.shutdownTimeoutMs,
			DEFAULT_SHUTDOWN_TIMEOUT_MS,
			"shutdownTimeoutMs",
		);
		this.maxDiagnosticBytes = positiveInteger(
			options.maxDiagnosticBytes,
			DEFAULT_DIAGNOSTIC_BYTES,
			"maxDiagnosticBytes",
		);
		this.decoder = new JsonlDecoder(options.maxRecordBytes);
		this.exited = new Promise((resolve) => {
			this.resolveExited = resolve;
		});
		this.child = spawn(options.command, [...(options.args ?? [])], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => this.consumeStderr(chunk));
		this.child.on("error", (error) =>
			this.failProtocol(new Error(`RPC process error: ${error.message}`)),
		);
		this.child.on("close", (code, signal) => this.handleClose(code, signal));
	}

	request(command: RpcRecord, timeoutMs = this.requestTimeoutMs): Promise<RpcResponse> {
		if (this.closed || !this.child.stdin.writable) {
			return Promise.reject(this.processExitError("RPC process is not writable"));
		}
		const type = typeof command.type === "string" ? command.type : "unknown";
		const id = typeof command.id === "string" ? command.id : `e2e-${++this.nextId}`;
		if (this.pending.has(id)) return Promise.reject(new Error(`Duplicate RPC request id: ${id}`));
		const duration = positiveDuration(timeoutMs, this.requestTimeoutMs, "request timeout");

		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`RPC request timed out after ${duration}ms: ${type}\n${this.diagnostics()}`),
				);
			}, duration);
			this.pending.set(id, { resolve, reject, timer });
			const line = `${JSON.stringify({ ...command, id })}\n`;
			this.child.stdin.write(line, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(new Error(`Failed to write RPC request ${type}: ${error.message}`));
			});
		});
	}

	waitForRecord(
		predicate: (record: RpcRecord) => boolean,
		description: string,
		timeoutMs = this.requestTimeoutMs,
	): Promise<RpcRecord> {
		let existing: RpcRecord | undefined;
		try {
			existing = this.retainedRecords.find(predicate);
		} catch (error) {
			return Promise.reject(new Error(`RPC record predicate failed: ${formatError(error)}`));
		}
		if (existing) return Promise.resolve(existing);
		if (this.closed)
			return Promise.reject(this.processExitError(`RPC process closed before ${description}`));
		const duration = positiveDuration(timeoutMs, this.requestTimeoutMs, "record timeout");
		return new Promise((resolve, reject) => {
			const waiter: RecordWaiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(
						new Error(
							`Timed out after ${duration}ms waiting for ${description}\n${this.diagnostics()}`,
						),
					);
				}, duration),
			};
			this.waiters.add(waiter);
		});
	}

	async waitForExit(timeoutMs = this.shutdownTimeoutMs): Promise<void> {
		if (this.closed) return;
		const duration = positiveDuration(timeoutMs, this.shutdownTimeoutMs, "exit timeout");
		await Promise.race([
			this.exited,
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`Timed out after ${duration}ms waiting for RPC process exit`)),
					duration,
				);
				this.exited.finally(() => clearTimeout(timer)).catch(() => {});
			}),
		]);
	}

	isRunning(): boolean {
		return !this.closed;
	}

	exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
		if (!this.closed || this.closeCode === undefined || this.closeSignal === undefined)
			return undefined;
		return { code: this.closeCode, signal: this.closeSignal };
	}

	records(): readonly RpcRecord[] {
		return [...this.retainedRecords];
	}

	stderr(): string {
		return this.stderrTail;
	}

	diagnostics(): string {
		const records = this.retainedRecords
			.slice(-10)
			.map((record) => JSON.stringify(record))
			.join("\n");
		const stderr = `${this.stderrTruncated ? "[stderr truncated to tail]\n" : ""}${this.stderrTail}`;
		return (
			[stderr && `stderr:\n${stderr}`, records && `recent RPC records:\n${records}`]
				.filter(Boolean)
				.join("\n") || "No RPC diagnostics captured."
		);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		if (this.closed) return;
		this.child.stdin.end();
		if (await settlesWithin(this.exited, this.shutdownTimeoutMs)) return;
		this.signalTree("SIGTERM");
		if (await settlesWithin(this.exited, Math.min(this.shutdownTimeoutMs, 500))) return;
		this.signalTree("SIGKILL");
		if (!(await settlesWithin(this.exited, Math.min(this.shutdownTimeoutMs, 500)))) {
			throw new Error(`RPC process did not exit after SIGKILL\n${this.diagnostics()}`);
		}
	}

	private consumeStdout(chunk: Buffer): void {
		if (this.protocolError) return;
		try {
			for (const record of this.decoder.push(chunk)) this.handleRecord(record);
		} catch (error) {
			this.failProtocol(new Error(`RPC stdout protocol failure: ${formatError(error)}`));
		}
	}

	private consumeStderr(chunk: Buffer): void {
		this.stderrTail += chunk.toString("utf8");
		const bytes = Buffer.byteLength(this.stderrTail, "utf8");
		if (bytes <= this.maxDiagnosticBytes) return;
		this.stderrTruncated = true;
		const buffer = Buffer.from(this.stderrTail, "utf8");
		this.stderrTail = buffer.subarray(buffer.length - this.maxDiagnosticBytes).toString("utf8");
	}

	private handleRecord(record: RpcRecord): void {
		this.retainedRecords.push(record);
		if (this.retainedRecords.length > MAX_RETAINED_RECORDS) this.retainedRecords.shift();
		if (record.type === "response" && typeof record.id === "string") {
			const pending = this.pending.get(record.id);
			if (pending) {
				this.pending.delete(record.id);
				clearTimeout(pending.timer);
				pending.resolve(record as RpcResponse);
			}
		}
		for (const waiter of [...this.waiters]) {
			let matches = false;
			try {
				matches = waiter.predicate(record);
			} catch (error) {
				this.waiters.delete(waiter);
				clearTimeout(waiter.timer);
				waiter.reject(new Error(`RPC record predicate failed: ${formatError(error)}`));
				continue;
			}
			if (!matches) continue;
			this.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(record);
		}
	}

	private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.closed) return;
		this.closeCode = code;
		this.closeSignal = signal;
		try {
			for (const record of this.decoder.end()) this.handleRecord(record);
		} catch (error) {
			this.protocolError ??= new Error(`RPC stdout protocol failure: ${formatError(error)}`);
		}
		this.closed = true;
		this.resolveExited();
		const error = this.processExitError("RPC process exited");
		this.rejectOutstanding(error);
	}

	private failProtocol(error: Error): void {
		if (this.protocolError) return;
		this.protocolError = error;
		this.rejectOutstanding(error);
		this.signalTree("SIGTERM");
	}

	private rejectOutstanding(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	private processExitError(prefix: string): Error {
		if (this.protocolError) return this.protocolError;
		const status =
			this.closeCode !== undefined
				? `exit code ${this.closeCode ?? "null"}${this.closeSignal ? ` (${this.closeSignal})` : ""}`
				: "before exit status was available";
		return new Error(`${prefix}: ${status}\n${this.diagnostics()}`);
	}

	private signalTree(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (!pid) return;
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, signal);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					this.child.kill(signal);
				}
				return;
			}
		}
		this.child.kill(signal);
	}
}

export function spawnRpcProcess(options: SpawnRpcProcessOptions): RpcProcess {
	return new RpcProcess(options);
}

export function resolveRepositoryPiInvocation(root: string): CommandInvocation {
	const packageDirectory = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	const manifestPath = path.join(packageDirectory, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		bin?: string | Record<string, unknown>;
	};
	const relativeBin =
		typeof manifest.bin === "string"
			? manifest.bin
			: typeof manifest.bin?.pi === "string"
				? manifest.bin.pi
				: undefined;
	if (!relativeBin) throw new Error(`${manifestPath} does not declare the pi CLI binary`);
	const unresolvedBin = path.resolve(packageDirectory, relativeBin);
	if (!existsSync(unresolvedBin))
		throw new Error(`Repository-local Pi CLI does not exist: ${unresolvedBin}`);
	const packageRealPath = realpathSync(packageDirectory);
	const binPath = realpathSync(unresolvedBin);
	if (binPath !== packageRealPath && !binPath.startsWith(`${packageRealPath}${path.sep}`)) {
		throw new Error(`Repository-local Pi CLI escapes its package: ${binPath}`);
	}
	return { command: process.execPath, args: [binPath] };
}

export function spawnPiRpc(options: SpawnPiRpcOptions): RpcProcess {
	const invocation = resolveRepositoryPiInvocation(options.root);
	const extensionArgs = (options.extensionPaths ?? []).flatMap((extensionPath) => [
		"--extension",
		extensionPath,
	]);
	const env = isolatedChildEnvironment(process.env, options.env);
	Object.assign(env, {
		APPDATA: options.agentDir,
		HOME: options.agentDir,
		LOCALAPPDATA: options.agentDir,
		PI_CODING_AGENT_DIR: options.agentDir,
		PI_CODING_AGENT_SESSION_DIR: options.sessionDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		PWD: options.cwd,
		USERPROFILE: options.agentDir,
		XDG_CACHE_HOME: path.join(options.agentDir, "cache"),
		XDG_CONFIG_HOME: path.join(options.agentDir, "config"),
		XDG_DATA_HOME: path.join(options.agentDir, "data"),
	});
	return spawnRpcProcess({
		command: invocation.command,
		args: [
			...invocation.args,
			"--mode",
			"rpc",
			"--no-session",
			"--session-dir",
			options.sessionDir,
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-builtin-tools",
			"--approve",
			...extensionArgs,
			...(options.args ?? []),
		],
		cwd: options.cwd,
		env,
		requestTimeoutMs: options.requestTimeoutMs,
		shutdownTimeoutMs: options.shutdownTimeoutMs,
	});
}

function isolatedChildEnvironment(
	source: NodeJS.ProcessEnv,
	overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries({ ...source, ...overrides })) {
		const normalizedName = name.toUpperCase();
		if (
			!CHILD_ENV_ALLOWLIST.has(normalizedName) &&
			!normalizedName.startsWith("LC_") &&
			!normalizedName.startsWith("PI_E2E_")
		) {
			continue;
		}
		env[name] = value;
	}
	return env;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive duration`);
	return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return value;
}

function isRecord(value: unknown): value is RpcRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
