import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const STATUS_KEY = "biome-lsp";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_FILE_LIMIT = 50;
const SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	"coverage",
	"dist",
	"node_modules",
	"out",
]);
const SUPPORTED_EXTENSIONS = new Set([
	".astro",
	".css",
	".cts",
	".cjs",
	".graphql",
	".gql",
	".html",
	".js",
	".json",
	".jsonc",
	".jsx",
	".mjs",
	".mts",
	".svelte",
	".ts",
	".tsx",
	".vue",
]);

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
			description: "Biome-supported files or directories to check. Defaults to the project root.",
		}),
	),
	root: Type.Optional(
		Type.String({ description: "Workspace root for the Biome language server. Defaults to cwd." }),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum files to open when directories are provided." }),
	),
};

const biomeDiagnosticsTool = defineTool({
	name: "biome_lsp_diagnostics",
	label: "Biome LSP: Diagnostics",
	description: "Run Biome's language server and return diagnostics for supported files.",
	promptSnippet: "Get Biome diagnostics through the Biome language server",
	promptGuidelines: [
		"Use biome_lsp_diagnostics when JavaScript, TypeScript, JSON, CSS, GraphQL, or framework files need Biome lint/format diagnostics.",
		"If Biome is missing, report the configuration error and suggest installing @biomejs/biome or setting PI_BIOME_LSP_COMMAND.",
	],
	parameters: Type.Object(PathsParameters),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return runDiagnostics(params, signal, ctx);
	},
});

const biomeFormatTool = defineTool({
	name: "biome_lsp_format",
	label: "Biome LSP: Format",
	description: "Format a Biome-supported file through Biome's language server.",
	promptSnippet: "Format a file through Biome LSP",
	parameters: Type.Object({
		path: Type.String({ description: "File to format." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the Biome language server. Defaults to cwd." }),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write formatted text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const root = resolveRoot(params.root);
		const file = resolveBiomeFile(root, params.path);
		const client = new LspClient(getServerCommand(), root, getTimeoutMs());
		const abort = () => client.close();
		signal?.addEventListener("abort", abort, { once: true });
		ctx.ui.setStatus(STATUS_KEY, "biome-lsp: format");

		try {
			await client.start();
			await client.initialize(root, { codeAction: true });
			const uri = pathToFileURL(file).href;
			const text = readFileSync(file, "utf8");
			client.didOpen(uri, text, languageIdFor(file));
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

const biomeFixTool = defineTool({
	name: "biome_lsp_fix",
	label: "Biome LSP: Fix",
	description: "Apply Biome LSP source fixes or import organization to a file.",
	promptSnippet: "Apply Biome LSP fixes to a file",
	parameters: Type.Object({
		path: Type.String({ description: "File to fix." }),
		root: Type.Optional(
			Type.String({ description: "Workspace root for the Biome language server. Defaults to cwd." }),
		),
		kind: Type.Optional(
			Type.String({
				description:
					"Biome source action kind. Defaults to source.fixAll.biome. Common value: source.organizeImports.biome.",
			}),
		),
		write: Type.Optional(
			Type.Boolean({ description: "Write fixed text back to the file. Defaults to false." }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const root = resolveRoot(params.root);
		const file = resolveBiomeFile(root, params.path);
		const actionKind = params.kind?.trim() || "source.fixAll.biome";
		const client = new LspClient(getServerCommand(), root, getTimeoutMs());
		const abort = () => client.close();
		signal?.addEventListener("abort", abort, { once: true });
		ctx.ui.setStatus(STATUS_KEY, "biome-lsp: fix");

		try {
			await client.start();
			await client.initialize(root, { codeAction: true });
			const uri = pathToFileURL(file).href;
			const text = readFileSync(file, "utf8");
			client.didOpen(uri, text, languageIdFor(file));
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

export default function biomeLsp(pi: ExtensionAPI) {
	pi.registerTool(biomeDiagnosticsTool);
	pi.registerTool(biomeFormatTool);
	pi.registerTool(biomeFixTool);

	pi.registerCommand("biome-lsp", {
		description: "Show Biome LSP extension configuration",
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
	params: { root?: string; paths?: string[]; limit?: number },
	signal: AbortSignal | undefined,
	ctx: StatusContext,
) {
	const root = resolveRoot(params.root);
	const files = collectBiomeFiles(root, params.paths, params.limit ?? DEFAULT_FILE_LIMIT);
	if (files.length === 0) {
		return textResult("Biome LSP found no supported files to check.", { root, files: [] });
	}

	const client = new LspClient(getServerCommand(), root, getTimeoutMs());
	const abort = () => client.close();
	signal?.addEventListener("abort", abort, { once: true });
	ctx.ui.setStatus(STATUS_KEY, "biome-lsp: diagnostics");

	try {
		await client.start();
		await client.initialize(root, { codeAction: true });

		const entries: DiagnosticEntry[] = [];
		for (const file of files) {
			const uri = pathToFileURL(file).href;
			const text = readFileSync(file, "utf8");
			client.didOpen(uri, text, languageIdFor(file));
			const diagnostics = await client.diagnostics(uri);
			entries.push({ path: path.relative(root, file) || file, uri, diagnostics });
		}

		return textResult(formatDiagnostics(entries), {
			root,
			command: getServerCommand(),
			files: entries,
			summary: summarize(entries),
		});
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		signal?.removeEventListener("abort", abort);
		await client.shutdown();
	}
}

function getServerCommand(): ServerCommand {
	const customCommand = process.env.PI_BIOME_LSP_COMMAND?.trim();
	if (customCommand) {
		const [command, ...args] = splitCommand(customCommand);
		if (command) return { command, args };
	}

	return { command: "biome", args: ["lsp-proxy"] };
}

function getTimeoutMs() {
	const rawValue = Number(process.env.PI_BIOME_LSP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : DEFAULT_TIMEOUT_MS;
}

function buildStatusMessage() {
	const command = getServerCommand();
	return [
		`Biome LSP command: ${command.command} ${command.args.join(" ")}`.trim(),
		`Biome status: ${commandExists(command.command) ? "ready" : "command missing"}`,
	].join("\n");
}

function statusLevel() {
	return commandExists(getServerCommand().command) ? "info" : "warning";
}

function resolveRoot(root?: string) {
	return path.resolve(root?.trim() || process.cwd());
}

function directoryUri(directory: string) {
	return pathToFileURL(directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`).href;
}

function resolveBiomeFile(root: string, filePath: string) {
	const resolvedPath = path.resolve(root, filePath);
	if (!existsSync(resolvedPath)) throw new Error(`File does not exist: ${resolvedPath}`);
	if (!statSync(resolvedPath).isFile()) throw new Error(`Expected a file: ${resolvedPath}`);
	if (!isBiomeFile(resolvedPath)) throw new Error(`Expected a Biome-supported file: ${resolvedPath}`);
	return resolvedPath;
}

function collectBiomeFiles(root: string, requestedPaths: string[] | undefined, limit: number) {
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
		if (isBiomeFile(targetPath)) files.push(targetPath);
		return;
	}

	if (!stats.isDirectory()) return;
	for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
		if (files.length >= limit) break;
		if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
		collectPath(path.join(targetPath, entry.name), files, limit);
	}
}

function isBiomeFile(filePath: string) {
	return SUPPORTED_EXTENSIONS.has(path.extname(filePath));
}

function languageIdFor(filePath: string) {
	const extension = path.extname(filePath);
	if (extension === ".js" || extension === ".cjs" || extension === ".mjs") return "javascript";
	if (extension === ".jsx") return "javascriptreact";
	if (extension === ".ts" || extension === ".cts" || extension === ".mts") return "typescript";
	if (extension === ".tsx") return "typescriptreact";
	if (extension === ".gql") return "graphql";
	if (extension === ".jsonc") return "jsonc";
	return extension.slice(1);
}

function formatDiagnostics(entries: DiagnosticEntry[]) {
	const lines = entries.flatMap((entry) => {
		if (entry.diagnostics.length === 0) return [`${entry.path}: no diagnostics`];

		return entry.diagnostics.map((diagnostic) => {
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const severity = severityName(diagnostic.severity);
			const source = diagnostic.source ?? "Biome";
			const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
			return `${entry.path}:${line}:${column}: ${severity} ${source}${code}: ${diagnostic.message}`;
		});
	});

	const summary = summarize(entries);
	return [
		`Biome LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`,
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
	const summary = `Biome LSP ${action} ${status} ${relativePath}.`;
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
	#publishedDiagnostics = new Map<string, LspDiagnostic[]>();
	#stderr = "";
	#command: ServerCommand;
	#cwd: string;
	#timeoutMs: number;

	constructor(command: ServerCommand, cwd: string, timeoutMs: number) {
		this.#command = command;
		this.#cwd = cwd;
		this.#timeoutMs = timeoutMs;
	}

	async start() {
		if (!commandExists(this.#command.command)) {
			throw new Error(
				`Biome LSP command not found: ${this.#command.command}. Install @biomejs/biome or set PI_BIOME_LSP_COMMAND.`,
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
						`Biome LSP server exited before response ${id} (${reason}).${this.#formatStderr()}`,
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
						? {
								codeAction: {
									dynamicRegistration: true,
									resolveSupport: { properties: ["edit"] },
								},
							}
						: {}),
					diagnostic: { dynamicRegistration: true },
					formatting: { dynamicRegistration: true },
					publishDiagnostics: {},
					synchronization: { didSave: true, dynamicRegistration: true },
				},
				workspace: {
					configuration: true,
					didChangeConfiguration: { dynamicRegistration: true },
					workspaceEdit: { documentChanges: true },
					workspaceFolders: true,
				}, 
			},
		});
		this.notify("initialized", {});
		await wait(300);
	}

	didOpen(uri: string, text: string, languageId: string) {
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
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
			if (!isUnsupportedMethodError(error)) throw error;
			await wait(300);
			return this.#publishedDiagnostics.get(uri) ?? [];
		}
	}

	async format(uri: string) {
		const response = await this.request("textDocument/formatting", {
			textDocument: { uri },
			options: { tabSize: 2, insertSpaces: false },
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
				if (!isUnsupportedMethodError(error)) throw error;
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
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Biome LSP request cancelled."));
		}
		this.#pending.clear();

		if (this.#child && !this.#child.killed) this.#child.kill("SIGTERM");
		this.#child = undefined;
	}

	private request(method: string, params: unknown) {
		const id = this.#nextId++;

		return new Promise<JsonRpcMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Biome LSP request timed out: ${method}.${this.#formatStderr()}`));
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
		if (!this.#child) throw new Error("Biome LSP server is not running.");

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
				pending.reject(new Error(`Biome LSP error: ${message.error.message}`));
			} else {
				pending.resolve(message);
			}
			return;
		}

		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
			if (params?.uri) this.#publishedDiagnostics.set(params.uri, params.diagnostics ?? []);
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
		} else if (message.method === "workspace/workspaceFolders") {
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

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
