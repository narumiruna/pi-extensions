import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commandFromEnv, timeoutFromEnv } from "./command.js";
import { collectSupportedFiles, resolveRoot, resolveSupportedFile } from "./files.js";
import { LspClient } from "./lsp-client.js";
import { applyTextEdits, collectWorkspaceEdits, hasOverlappingTextEdits } from "./text-edits.js";
import type { CodeAction, DiagnosticEntry, LspServerAdapter, StatusContext } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_FILE_LIMIT = 50;

export async function runDiagnostics(
	adapter: LspServerAdapter,
	params: { root?: string; paths?: string[]; limit?: number },
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
) {
	const root = resolveRoot(params.root);
	const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
	const files = collectSupportedFiles(adapter, root, params.paths, params.limit ?? DEFAULT_FILE_LIMIT);
	if (files.length === 0) {
		return textResult(adapter.emptyDiagnosticsMessage, {
			root,
			command,
			files: [],
			summary: { files: 0, diagnostics: 0 },
		});
	}

	const client = new LspClient(adapter, command, root, timeoutFromEnv(adapter.timeoutEnvVar, DEFAULT_TIMEOUT_MS));
	const abort = () => client.close();
	signal?.addEventListener("abort", abort, { once: true });
	throwIfAborted(signal, adapter);
	ctx.ui.setStatus(statusKey, `${adapter.statusPrefix} diagnostics`);

	try {
		await client.start();
		await client.initialize(root);

		const entries: DiagnosticEntry[] = [];
		for (const file of files) {
			throwIfAborted(signal, adapter);
			const uri = pathToFileURL(file).href;
			const text = readFileSync(file, "utf8");
			client.didOpen(uri, text, adapter.languageIdFor(file));
			try {
				const diagnostics = await client.diagnostics(uri);
				entries.push({ path: path.relative(root, file) || file, uri, diagnostics });
			} finally {
				client.didClose(uri);
			}
		}

		return textResult(formatDiagnostics(adapter, entries), {
			root,
			command,
			files: entries,
			summary: summarize(entries),
		});
	} finally {
		ctx.ui.setStatus(statusKey, undefined);
		signal?.removeEventListener("abort", abort);
		await client.shutdown();
	}
}

export async function runFormat(
	adapter: LspServerAdapter,
	params: { root?: string; path: string; write?: boolean },
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
) {
	const root = resolveRoot(params.root);
	const file = resolveSupportedFile(adapter, root, params.path);
	const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
	const client = new LspClient(adapter, command, root, timeoutFromEnv(adapter.timeoutEnvVar, DEFAULT_TIMEOUT_MS));
	const abort = () => client.close();
	signal?.addEventListener("abort", abort, { once: true });
	throwIfAborted(signal, adapter);
	ctx.ui.setStatus(statusKey, `${adapter.statusPrefix} format`);

	try {
		await client.start();
		await client.initialize(root);
		throwIfAborted(signal, adapter);
		const uri = pathToFileURL(file).href;
		const text = readFileSync(file, "utf8");
		client.didOpen(uri, text, adapter.languageIdFor(file));
		let newText: string;
		let edits;
		try {
			edits = await client.format(uri);
			newText = applyTextEdits(text, edits);
		} finally {
			client.didClose(uri);
		}
		const changed = newText !== text;

		if (params.write && changed) writeFileSync(file, newText);

		return textResult(formatEditSummary(adapter, "format", root, file, changed, params.write, newText), {
			path: path.relative(root, file) || file,
			uri,
			changed,
			write: params.write ?? false,
			edits,
			text: params.write ? undefined : newText,
		});
	} finally {
		ctx.ui.setStatus(statusKey, undefined);
		signal?.removeEventListener("abort", abort);
		await client.shutdown();
	}
}

export async function runFix(
	adapter: LspServerAdapter,
	params: { root?: string; path: string; kind?: string; write?: boolean },
	signal: AbortSignal | undefined,
	ctx: StatusContext,
	statusKey: string,
) {
	const root = resolveRoot(params.root);
	const file = resolveSupportedFile(adapter, root, params.path);
	const actionKind = params.kind?.trim() || adapter.defaultFixKind;
	if (!actionKind) throw new Error(`${adapter.label} LSP adapter does not support source fixes.`);

	const command = commandFromEnv(adapter.commandEnvVar, adapter.defaultCommand);
	const client = new LspClient(adapter, command, root, timeoutFromEnv(adapter.timeoutEnvVar, DEFAULT_TIMEOUT_MS));
	const abort = () => client.close();
	signal?.addEventListener("abort", abort, { once: true });
	throwIfAborted(signal, adapter);
	ctx.ui.setStatus(statusKey, `${adapter.statusPrefix} fix`);

	try {
		await client.start();
		await client.initialize(root);
		throwIfAborted(signal, adapter);
		const uri = pathToFileURL(file).href;
		const text = readFileSync(file, "utf8");
		client.didOpen(uri, text, adapter.languageIdFor(file));
		let resolvedActions: CodeAction[];
		let selectedActions: CodeAction[];
		let edits;
		let newText: string;
		try {
			const diagnostics = await client.diagnostics(uri);
			const actions = await client.codeActions(uri, text, diagnostics, actionKind);
			resolvedActions = await client.resolveActions(actions);
			selectedActions = selectCodeActions(resolvedActions, actionKind);
			edits = selectedActions.flatMap((action) => collectWorkspaceEdits(action.edit, uri));
			if (hasOverlappingTextEdits(text, edits)) {
				const relativePath = path.relative(root, file) || file;
				throw new Error(
					`${adapter.label} LSP returned overlapping code-action edits for ${relativePath}; ` +
						"use a narrower action kind.",
				);
			}
			newText = applyTextEdits(text, edits);
		} finally {
			client.didClose(uri);
		}
		const changed = newText !== text;

		if (params.write && changed) writeFileSync(file, newText);

		return textResult(formatEditSummary(adapter, "fix", root, file, changed, params.write, newText), {
			path: path.relative(root, file) || file,
			uri,
			changed,
			write: params.write ?? false,
			kind: actionKind,
			actions: resolvedActions.map(({ title, kind }) => ({ title, kind })),
			appliedActions: selectedActions.map(({ title, kind }) => ({ title, kind })),
			edits,
			text: params.write ? undefined : newText,
		});
	} finally {
		ctx.ui.setStatus(statusKey, undefined);
		signal?.removeEventListener("abort", abort);
		await client.shutdown();
	}
}

function selectCodeActions(actions: CodeAction[], requestedKind: string) {
	return actions.filter(
		(action) => action.kind === requestedKind || action.kind?.startsWith(`${requestedKind}.`),
	);
}

function formatDiagnostics(adapter: LspServerAdapter, entries: DiagnosticEntry[]) {
	const lines = entries.flatMap((entry) => {
		if (entry.diagnostics.length === 0) return [`${entry.path}: no diagnostics`];

		return entry.diagnostics.map((diagnostic) => {
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const severity = severityName(diagnostic.severity);
			const source = diagnostic.source ?? adapter.label;
			const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
			return `${entry.path}:${line}:${column}: ${severity} ${source}${code}: ${diagnostic.message}`;
		});
	});

	return [adapter.formatDiagnosticsHeader(summarize(entries)), "", ...lines].join("\n");
}

function formatEditSummary(
	adapter: LspServerAdapter,
	action: "fix" | "format",
	root: string,
	file: string,
	changed: boolean,
	write: boolean | undefined,
	text: string,
) {
	const relativePath = path.relative(root, file) || file;
	const status = changed ? (write ? "updated" : "computed changes for") : "left unchanged";
	const summary = `${adapter.editSummaryLabel} LSP ${action} ${status} ${relativePath}.`;
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

function throwIfAborted(signal: AbortSignal | undefined, adapter: LspServerAdapter) {
	if (signal?.aborted) throw new Error(`${adapter.label} LSP request aborted.`);
}

export function textResult(text: string, details: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
