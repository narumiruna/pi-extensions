export interface ServerCommand {
	command: string;
	args: string[];
}

export interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: string | number;
	codeDescription?: { href?: string };
	source?: string;
	message: string;
}

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

export interface WorkspaceEdit {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: Array<{
		textDocument?: { uri?: string; version?: number | null };
		edits?: LspTextEdit[];
	}>;
}

export interface CodeAction {
	title: string;
	kind?: string;
	edit?: WorkspaceEdit;
	data?: unknown;
}

export interface DiagnosticEntry {
	path: string;
	uri: string;
	diagnostics: LspDiagnostic[];
}

export interface JsonRpcMessage {
	jsonrpc?: "2.0";
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface ConfiguredLspServer {
	command: string[];
	extensions: string[];
	env?: Record<string, string>;
	initialization?: Record<string, unknown>;
}

export interface LspConfig {
	timeout?: number;
	servers: InternalLspServer[];
}

export interface InternalLspServer extends ConfiguredLspServer {
	name: string;
}

export interface LspServerAdapter {
	name: string;
	defaultCommand: ServerCommand;
	commandEnvVar: string;
	missingCommandHint: string;
	extensions: string[];
	env?: Record<string, string>;
	initialization?: Record<string, unknown>;
	skipDirectories: Set<string>;
	isSupportedFile: (filePath: string) => boolean;
	languageIdFor: (filePath: string) => string;
}

export interface DiagnosticSummary {
	files: number;
	diagnostics: number;
}
