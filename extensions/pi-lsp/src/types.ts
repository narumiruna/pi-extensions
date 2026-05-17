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

export interface LspServerAdapter {
	label: string;
	statusPrefix: string;
	defaultCommand: ServerCommand;
	commandEnvVar: string;
	timeoutEnvVar: string;
	missingCommandHint: string;
	skipDirectories: Set<string>;
	isSupportedFile: (filePath: string) => boolean;
	languageIdFor: (filePath: string) => string;
	formattingOptions: { tabSize: number; insertSpaces: boolean };
	initialize: {
		codeAction: boolean;
		diagnosticDynamicRegistration: boolean;
		formattingDynamicRegistration?: boolean;
		codeActionDynamicRegistration?: boolean;
		didChangeConfigurationDynamicRegistration?: boolean;
		didSaveDynamicRegistration?: boolean;
	};
	fallbackToPublishDiagnostics: boolean;
	resolveUnsupportedCodeActions: boolean;
	serverRequestWorkspaceFolders: boolean;
	emptyDiagnosticsMessage: string;
	formatDiagnosticsHeader: (summary: DiagnosticSummary) => string;
	editSummaryLabel: string;
	defaultFixKind?: string;
}

export interface DiagnosticSummary {
	files: number;
	diagnostics: number;
}
