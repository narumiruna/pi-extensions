import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const STATUS_KEY = "python-lsp";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_FILE_LIMIT = 50;
const SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".venv",
	"__pycache__",
	"node_modules",
	"venv",
]);

type ServerKind = "ty" | "ruff";

interface ServerCommand {
	command: string;
	args: string[];
}

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

interface LspPosition {
	line: number;
	character: number;
}

interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: string | number;
	codeDescription?: { href?: string };
	source?: string;
	message: string;
}

interface LspTextEdit {
	range: LspRange;
	newText: string;
}

interface WorkspaceEdit {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: Array<{
		textDocument?: { uri?: string; version?: number | null };
		edits?: LspTextEdit[];
	}>;
}

interface CodeAction {
	title: string;
	kind?: string;
	edit?: WorkspaceEdit;
	data?: unknown;
}

interface DiagnosticEntry {
	path: string;
	uri: string;
	diagnostics: LspDiagnostic[];
}

interface JsonRpcMessage {
	jsonrpc?: "2.0";
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

const PathsParameters = {
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Python files or directories to check. Defaults to the project root.",
		}),
	),
	root: Type.Optional(
		Type.String({ description: "Workspace root for the language server. Defaults to cwd." }),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum Python files to open when directories are provided." }),
	),
};

const tyDiagnosticsTool = defineTool({
	name: "ty_lsp_diagnostics",
	label: "Python LSP: ty Diagnostics",
	description: "Run ty's language server and return Python type diagnostics for files.",
	promptSnippet: "Get Python type diagnostics from ty's language server",
	promptGuidelines: [
		"Use ty_lsp_diagnostics when Python changes need type-checking through ty's language server.",
		"If ty is missing, report the configuration error and suggest installing ty or setting PI_TY_LSP_COMMAND.",
	],
	parameters: Type.Object(PathsParameters),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runDiagnostics("ty", params, signal, ctx);
	},
});

const ruffDiagnosticsTool = defineTool({
	name: "ruff_lsp_diagnostics",
	label: "Python LSP: Ruff Diagnostics",
	description: "Run Ruff's language server and return Python lint diagnostics for files.",
	promptSnippet: "Get Python lint diagnostics from Ruff's language server",
	promptGuidelines: [
		"Use ruff_lsp_diagnostics when Python changes need Ruff lint checks through the language server.",
		"If ruff is missing, report the configuration error and suggest installing ruff or setting PI_RUFF_LSP_COMMAND.",
	],
	parameters: Type.Object(PathsParameters),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runDiagnostics("ruff", params, signal, ctx);
	},
});

const ruffFormatTool = defineTool({
	name: "ruff_lsp_format",
	label: "Python LSP: Ruff Format",
	description: "Format a Python file through Ruff's language server.",
	promptSnippet: "Format a Python file through Ruff LSP",
	parameters: Type.Object({
		path: Type.String({ description: "Python file to format." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the language server. Defaults to cwd." }),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write formatted text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const root = resolveRoot(params.root);
		const file = resolvePythonFile(root, params.path);
		const client = new LspClient("ruff", getServerCommand("ruff"), root, getTimeoutMs("ruff"));
		const abort = () => client.close();
		signal?.addEventListener("abort", abort, { once: true });
		ctx.ui.setStatus(STATUS_KEY, "python-lsp: ruff format");

		try {
			await client.start();
			await client.initialize(root, { codeAction: true });
			const uri = pathToFileURL(file).href;
			const text = readFileSync(file, "utf8");
			client.didOpen(uri, text);
			const edits = await client.format(uri);
			const newText = applyTextEdits(text, edits);
			const changed = newText !== text;

			if (params.write && changed) writeFileSync(file, newText);

			return textResult(formatEditSummary("format", root, file, changed, params.write, newText), {
				path: path.relative(root, file) || file,
				uri,
				changed,
				write: params.write ?? false,
				edits,
				text: params.write ? undefined : newText,
			});
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			signal?.removeEventListener("abort", abort);
			await client.shutdown();
		}
	},
});

const ruffFixTool = defineTool({
	name: "ruff_lsp_fix",
	label: "Python LSP: Ruff Fix",
	description: "Apply Ruff LSP source fixes or import organization to a Python file.",
	promptSnippet: "Apply Ruff LSP fixes to a Python file",
	parameters: Type.Object({
		path: Type.String({ description: "Python file to fix." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the language server. Defaults to cwd." }),
		),
		kind: Type.Optional(
			Type.String({
				description:
					"Ruff source action kind. Defaults to source.fixAll.ruff. Common value: source.organizeImports.ruff.",
			}),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write fixed text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const root = resolveRoot(params.root);
		const file = resolvePythonFile(root, params.path);
		const actionKind = params.kind?.trim() || "source.fixAll.ruff";
		const client = new LspClient("ruff", getServerCommand("ruff"), root, getTimeoutMs("ruff"));
		const abort = () => client.close();
		signal?.addEventListener("abort", abort, { once: true });
		ctx.ui.setStatus(STATUS_KEY, "python-lsp: ruff fix");

		try {
			await client.start();
			await client.initialize(root, { codeAction: true });
			const uri = pathToFileURL(file).href;
			const text = readFileSync(file, "utf8");
			client.didOpen(uri, text);
			const diagnostics = await client.diagnostics(uri);
			const actions = await client.codeActions(uri, text, diagnostics, actionKind);
			const resolvedActions = await client.resolveActions(actions);
			const edits = resolvedActions.flatMap((action) => collectWorkspaceEdits(action.edit, uri));
			const newText = applyTextEdits(text, edits);
			const changed = newText !== text;

			if (params.write && changed) writeFileSync(file, newText);

			return textResult(formatEditSummary("fix", root, file, changed, params.write, newText), {
				path: path.relative(root, file) || file,
				uri,
				changed,
				write: params.write ?? false,
				kind: actionKind,
				actions: resolvedActions.map(({ title, kind }) => ({ title, kind })),
				edits,
				text: params.write ? undefined : newText,
			});
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			signal?.removeEventListener("abort", abort);
			await client.shutdown();
		}
	},
});

export default function pythonLsp(pi: ExtensionAPI) {
	pi.registerTool(tyDiagnosticsTool);
	pi.registerTool(ruffDiagnosticsTool);
	pi.registerTool(ruffFormatTool);
	pi.registerTool(ruffFixTool);

	pi.registerCommand("python-lsp", {
		description: "Show Python LSP extension configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildStatusMessage(), statusLevel());
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function runDiagnostics(
	kind: ServerKind,
	params: { root?: string; paths?: string[]; limit?: number },
	signal: AbortSignal | undefined,
	ctx: StatusContext,
) {
	const root = resolveRoot(params.root);
	const files = collectPythonFiles(root, params.paths, params.limit ?? DEFAULT_FILE_LIMIT);
	if (files.length === 0) {
		return textResult(`${labelFor(kind)} LSP found no Python files to check.`, { root, files: [] });
	}

	const client = new LspClient(kind, getServerCommand(kind), root, getTimeoutMs(kind));
	const abort = () => client.close();
	signal?.addEventListener("abort", abort, { once: true });
	ctx.ui.setStatus(STATUS_KEY, `python-lsp: ${kind} diagnostics`);

	try {
		await client.start();
		await client.initialize(root, { codeAction: kind === "ruff" });

		const entries: DiagnosticEntry[] = [];
		for (const file of files) {
			const uri = pathToFileURL(file).href;
			const text = readFileSync(file, "utf8");
			client.didOpen(uri, text);
			const diagnostics = await client.diagnostics(uri);
			entries.push({ path: path.relative(root, file) || file, uri, diagnostics });
		}

		return textResult(formatDiagnostics(entries, kind), {
			root,
			command: getServerCommand(kind),
			files: entries,
			summary: summarize(entries),
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		signal?.removeEventListener("abort", abort);
		await client.shutdown();
	}
}

function getServerCommand(kind: ServerKind): ServerCommand {
	const customCommand = (
		kind === "ty" ? process.env.PI_TY_LSP_COMMAND : process.env.PI_RUFF_LSP_COMMAND
	)?.trim();
	if (customCommand) {
		const [command, ...args] = splitCommand(customCommand);
		if (command) return { command, args };
	}

	return kind === "ty"
		? { command: "ty", args: ["server"] }
		: { command: "ruff", args: ["server"] };
}

function getTimeoutMs(kind: ServerKind) {
	const envValue =
		kind === "ty" ? process.env.PI_TY_LSP_TIMEOUT_MS : process.env.PI_RUFF_LSP_TIMEOUT_MS;
	const rawValue = Number(envValue ?? DEFAULT_TIMEOUT_MS);
	return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : DEFAULT_TIMEOUT_MS;
}

function buildStatusMessage() {
	const ty = getServerCommand("ty");
	const ruff = getServerCommand("ruff");
	return [
		`ty LSP command: ${ty.command} ${ty.args.join(" ")}`.trim(),
		`ty status: ${commandExists(ty.command) ? "ready" : "command missing"}`,
		`Ruff LSP command: ${ruff.command} ${ruff.args.join(" ")}`.trim(),
		`Ruff status: ${commandExists(ruff.command) ? "ready" : "command missing"}`,
	].join("\n");
}

function statusLevel() {
	return commandExists(getServerCommand("ty").command) &&
		commandExists(getServerCommand("ruff").command)
		? "info"
		: "warning";
}

function resolveRoot(root?: string) {
	return path.resolve(root?.trim() || process.cwd());
}

function directoryUri(directory: string) {
	return pathToFileURL(directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`).href;
}

function resolvePythonFile(root: string, filePath: string) {
	const resolvedPath = path.resolve(root, filePath);
	if (!existsSync(resolvedPath)) throw new Error(`Python file does not exist: ${resolvedPath}`);
	if (!statSync(resolvedPath).isFile()) throw new Error(`Expected a Python file: ${resolvedPath}`);
	if (!isPythonFile(resolvedPath)) throw new Error(`Expected a .py or .pyi file: ${resolvedPath}`);
	return resolvedPath;
}

function collectPythonFiles(root: string, requestedPaths: string[] | undefined, limit: number) {
	const cappedLimit = Math.max(1, Math.floor(limit));
	const files: string[] = [];
	const inputs = requestedPaths?.length ? requestedPaths : [root];

	for (const input of inputs) {
		collectPath(path.resolve(root, input), files, cappedLimit);
		if (files.length >= cappedLimit) break;
	}

	return files;
}

function collectPath(targetPath: string, files: string[], limit: number) {
	if (files.length >= limit || !existsSync(targetPath)) return;

	const stats = statSync(targetPath);
	if (stats.isFile()) {
		if (isPythonFile(targetPath)) files.push(targetPath);
		return;
	}

	if (!stats.isDirectory()) return;
	for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
		if (files.length >= limit) break;
		if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
		collectPath(path.join(targetPath, entry.name), files, limit);
	}
}

function isPythonFile(filePath: string) {
	return filePath.endsWith(".py") || filePath.endsWith(".pyi");
}

function formatDiagnostics(entries: DiagnosticEntry[], kind: ServerKind) {
	const lines = entries.flatMap((entry) => {
		if (entry.diagnostics.length === 0) return [`${entry.path}: no diagnostics`];

		return entry.diagnostics.map((diagnostic) => {
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const severity = severityName(diagnostic.severity);
			const source = diagnostic.source ?? labelFor(kind);
			const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
			return `${entry.path}:${line}:${column}: ${severity} ${source}${code}: ${diagnostic.message}`;
		});
	});

	const summary = summarize(entries);
	return [
		`${labelFor(kind)} LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`,
		"",
		...lines,
	].join("\n");
}

function formatEditSummary(
	action: "fix" | "format",
	root: string,
	file: string,
	changed: boolean,
	write: boolean | undefined,
	text: string,
) {
	const relativePath = path.relative(root, file) || file;
	const status = changed ? (write ? "updated" : "computed changes for") : "left unchanged";
	const summary = `Ruff LSP ${action} ${status} ${relativePath}.`;
	if (write || !changed) return summary;
	return `${summary}\n\n${text}`;
}

function summarize(entries: DiagnosticEntry[]) {
	return {
		files: entries.length,
		diagnostics: entries.reduce((total, entry) => total + entry.diagnostics.length, 0),
	};
}

function severityName(severity: number | undefined) {
	if (severity === 1) return "error";
	if (severity === 2) return "warning";
	if (severity === 3) return "info";
	if (severity === 4) return "hint";
	return "diagnostic";
}

function labelFor(kind: ServerKind) {
	return kind === "ty" ? "ty" : "Ruff";
}

function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function commandExists(command: string) {
	if (command.includes("/") || command.includes("\\")) return existsSync(command);

	const pathValue = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
		if (!directory) continue;
		for (const extension of extensions) {
			if (existsSync(path.join(directory, `${command}${extension}`))) return true;
		}
	}

	return false;
}

function splitCommand(input: string) {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}

		if (char === quote) {
			quote = undefined;
			continue;
		}

		if (/\s/.test(char) && !quote) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) parts.push(current);
	return parts;
}

function positionAt(text: string, offset: number): LspPosition {
	const boundedOffset = Math.max(0, Math.min(offset, text.length));
	let line = 0;
	let lineStart = 0;

	for (let index = 0; index < boundedOffset; index += 1) {
		if (text[index] === "\n") {
			line += 1;
			lineStart = index + 1;
		}
	}

	return { line, character: boundedOffset - lineStart };
}

function offsetAt(text: string, position: LspPosition) {
	let line = 0;
	let lineStart = 0;

	for (let index = 0; index < text.length && line < position.line; index += 1) {
		if (text[index] === "\n") {
			line += 1;
			lineStart = index + 1;
		}
	}

	if (line < position.line) return text.length;

	let lineEnd = text.indexOf("\n", lineStart);
	if (lineEnd < 0) lineEnd = text.length;
	return Math.min(lineStart + position.character, lineEnd);
}

function applyTextEdits(text: string, edits: LspTextEdit[]) {
	let output = text;
	const sortedEdits = [...edits].sort((left, right) => {
		const leftOffset = offsetAt(text, left.range.start);
		const rightOffset = offsetAt(text, right.range.start);
		return rightOffset - leftOffset;
	});

	for (const edit of sortedEdits) {
		const start = offsetAt(output, edit.range.start);
		const end = offsetAt(output, edit.range.end);
		output = `${output.slice(0, start)}${edit.newText}${output.slice(end)}`;
	}

	return output;
}

function collectWorkspaceEdits(edit: WorkspaceEdit | undefined, uri: string) {
	if (!edit) return [];
	if (edit.documentChanges) {
		return edit.documentChanges.flatMap((change) =>
			change.textDocument?.uri === uri ? (change.edits ?? []) : [],
		);
	}

	return edit.changes?.[uri] ?? [];
}

class LspClient {
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
	#stderr = "";
	#kind: ServerKind;
	#command: ServerCommand;
	#cwd: string;
	#timeoutMs: number;

	constructor(kind: ServerKind, command: ServerCommand, cwd: string, timeoutMs: number) {
		this.#kind = kind;
		this.#command = command;
		this.#cwd = cwd;
		this.#timeoutMs = timeoutMs;
	}

	async start() {
		if (!commandExists(this.#command.command)) {
			throw new Error(
				`${labelFor(this.#kind)} LSP command not found: ${this.#command.command}. Install ${this.#kind} or set ${this.#kind === "ty" ? "PI_TY_LSP_COMMAND" : "PI_RUFF_LSP_COMMAND"}.`,
			);
		}

		this.#child = spawn(this.#command.command, this.#command.args, {
			cwd: this.#cwd,
			stdio: "pipe",
		});
		this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
		this.#child.stderr.on("data", (chunk) => {
			this.#stderr += chunk.toString();
		});
		this.#child.once("exit", (code, signal) => {
			const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
			for (const [id, pending] of this.#pending.entries()) {
				clearTimeout(pending.timeout);
				pending.reject(
					new Error(
						`${labelFor(this.#kind)} LSP server exited before response ${id} (${reason}).${this.#formatStderr()}`,
					),
				);
			}
			this.#pending.clear();
		});
	}

	async initialize(root: string, options: { codeAction: boolean }) {
		const rootUri = directoryUri(root);
		await this.request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: path.basename(root) || "workspace" }],
			capabilities: {
				textDocument: {
					...(options.codeAction
						? { codeAction: { resolveSupport: { properties: ["edit"] } } }
						: {}),
					diagnostic: { dynamicRegistration: false },
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
		this.notify("initialized", {});
	}

	didOpen(uri: string, text: string) {
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "python", version: 1, text },
		});
	}

	async diagnostics(uri: string) {
		const response = await this.request("textDocument/diagnostic", {
			textDocument: { uri },
			identifier: null,
			previousResultId: null,
		});
		const result = response.result as { items?: LspDiagnostic[] } | undefined;
		return result?.items ?? [];
	}

	async format(uri: string) {
		const response = await this.request("textDocument/formatting", {
			textDocument: { uri },
			options: { tabSize: 4, insertSpaces: true },
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
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(`${labelFor(this.#kind)} LSP request cancelled.`));
		}
		this.#pending.clear();

		if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
		this.#child = undefined;
	}

	private request(method: string, params: unknown) {
		const id = this.#nextId++;
		this.#send({ jsonrpc: "2.0", id, method, params });

		return new Promise<JsonRpcMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(
					new Error(
						`${labelFor(this.#kind)} LSP request timed out: ${method}.${this.#formatStderr()}`,
					),
				);
			}, this.#timeoutMs);
			this.#pending.set(id, { resolve, reject, timeout });
		});
	}

	private notify(method: string, params: unknown) {
		this.#send(
			params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
		);
	}

	#send(message: JsonRpcMessage) {
		if (!this.#child) throw new Error(`${labelFor(this.#kind)} LSP server is not running.`);

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
				pending.reject(new Error(`${labelFor(this.#kind)} LSP error: ${message.error.message}`));
			} else {
				pending.resolve(message);
			}
			return;
		}

		if (Object.hasOwn(message, "id") && message.method) {
			this.#respondToServerRequest(message);
		}
	}

	#respondToServerRequest(message: JsonRpcMessage) {
		let result: unknown = null;
		if (message.method === "workspace/configuration") {
			const params = message.params as { items?: unknown[] } | undefined;
			result = (params?.items ?? []).map(() => ({}));
		}

		this.#send({ jsonrpc: "2.0", id: message.id, result });
	}

	#formatStderr() {
		const stderr = this.#stderr.trim();
		return stderr ? `\nServer stderr:\n${stderr}` : "";
	}
}
