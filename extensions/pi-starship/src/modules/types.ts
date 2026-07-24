import type { StyledChunk } from "../format/style.js";

export interface GitBranchSnapshot {
	name: string;
	remoteName?: string;
	remoteBranch?: string;
	detached: boolean;
}

export interface GitCommitSnapshot {
	hash: string;
	tag?: string;
	detached: boolean;
}

export interface GitStateSnapshot {
	state: string;
	progressCurrent?: number;
	progressTotal?: number;
}

export interface GitMetricsSnapshot {
	added: number;
	deleted: number;
}

export interface GitStatusSnapshot {
	ahead: number;
	behind: number;
	stashed: number;
	conflicted: number;
	deleted: number;
	renamed: number;
	modified: number;
	staged: number;
	typechanged: number;
	untracked: number;
	worktreeAdded: number;
	worktreeDeleted: number;
	worktreeModified: number;
	worktreeTypechanged: number;
	indexAdded: number;
	indexDeleted: number;
	indexModified: number;
	indexTypechanged: number;
}

export interface GitWorktreeSnapshot {
	name: string;
	path: string;
}

export interface GitSnapshot {
	branch?: GitBranchSnapshot;
	commit?: GitCommitSnapshot;
	state?: GitStateSnapshot;
	metrics?: GitMetricsSnapshot;
	status: GitStatusSnapshot;
	worktree?: GitWorktreeSnapshot;
}

export type ExtensionStatusIconAliasMap = ReadonlyMap<string, readonly string[]>;

export interface StarshipRuntimeSnapshot {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel: string;
	turnCount: number;
	activeTools: ReadonlyMap<string, number>;
	isStreaming: boolean;
	lastCompletedTool?: string;
	contextUsage?: {
		percent?: number | null;
		tokens?: number | null;
		contextWindow?: number | null;
	};
	tokenTotals: { input: number; output: number; cost: number };
	gitBranch: string | null;
	gitBranchDetails?: GitBranchSnapshot;
	gitCommit?: GitCommitSnapshot;
	gitState?: GitStateSnapshot;
	gitMetrics?: GitMetricsSnapshot;
	gitStatus?: GitStatusSnapshot;
	gitWorktree?: GitWorktreeSnapshot;
	extensionStatuses: ReadonlyMap<string, string>;
	extensionStatusIconAliases: ExtensionStatusIconAliasMap;
	now: Date;
}

export interface ExtensionStatusPresentation {
	separator: string;
	maxStatuses: number;
	icons: Readonly<Record<string, string>>;
}

export interface ModuleValueContext {
	runtime: StarshipRuntimeSnapshot;
	symbol: string;
	extensionStatus: ExtensionStatusPresentation;
	hiddenExtensionStatusKeys: ReadonlySet<string>;
}

export interface ModuleDefaults {
	format: string;
	symbol: string;
	style: string;
	disabled: boolean;
}

export interface ModuleDefinition<Name extends string> {
	name: Name;
	variables: readonly string[];
	defaults: ModuleDefaults;
	values(context: ModuleValueContext): Record<string, string> | undefined;
}

export function defineModule<const Name extends string>(
	definition: ModuleDefinition<Name>,
): ModuleDefinition<Name> {
	return definition;
}

export interface RenderedStatusline<Name extends string = string> {
	ansi: string;
	chunks: StyledChunk[];
	modules: Record<Name, StyledChunk[]>;
	consumedExtensionStatusKeys: ReadonlySet<string>;
}
