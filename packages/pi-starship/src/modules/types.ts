import type { UIPromptKind } from "@earendil-works/pi-coding-agent";
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

export type GithubPrState = "open" | "draft" | "merged" | "closed";

export interface GithubPrSnapshot {
  readonly number: string;
  readonly link: string;
  readonly state: GithubPrState;
  readonly checks: string;
  readonly review: string;
  readonly status: string;
  readonly expiresAt?: number;
}

export interface GitSnapshot {
  root?: string;
  branch?: GitBranchSnapshot;
  commit?: GitCommitSnapshot;
  state?: GitStateSnapshot;
  metrics?: GitMetricsSnapshot;
  status: GitStatusSnapshot;
  worktree?: GitWorktreeSnapshot;
}

export interface WorkspaceSnapshot {
  modules: Readonly<Record<string, Readonly<Record<string, string>>>>;
  styleSelectors?: Readonly<Record<string, string>>;
}

export interface StarshipRuntimeSnapshot {
  cwd: string;
  homeDir?: string;
  gitRoot?: string;
  model?: { provider: string; id: string };
  thinkingLevel: string;
  turnCount: number;
  activeTools: ReadonlyMap<string, number>;
  isStreaming: boolean;
  uiPrompt?: { kind: UIPromptKind; title?: string };
  lastCompletedTool?: string;
  contextUsage?: {
    percent?: number | null;
    tokens?: number | null;
    contextWindow?: number | null;
  };
  tokenTotals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    latestCacheHitRate?: number;
  };
  usingSubscription: boolean;
  gitBranch: string | null;
  gitBranchDetails?: GitBranchSnapshot;
  gitCommit?: GitCommitSnapshot;
  gitState?: GitStateSnapshot;
  gitMetrics?: GitMetricsSnapshot;
  gitStatus?: GitStatusSnapshot;
  gitWorktree?: GitWorktreeSnapshot;
  githubPr?: GithubPrSnapshot;
  extensionStatuses: ReadonlyMap<string, string>;
  now: Date;
  workspace?: WorkspaceSnapshot;
}

export interface ExtensionStatusPresentation {
  separator: string;
  maxStatuses: number;
  icons: Readonly<Record<string, string>>;
}

export type ModuleOptionValue = string | boolean | number | readonly string[] | Readonly<Record<string, string>>;

export interface ModuleValueContext {
  runtime: StarshipRuntimeSnapshot;
  symbol: string;
  options: Readonly<Record<string, ModuleOptionValue>>;
  extensionStatus: ExtensionStatusPresentation;
}

export type ModuleOptionSchema =
  | { kind: "string"; default: string; allowEmpty?: boolean }
  | { kind: "string-enum"; default: string; values: readonly string[] }
  | { kind: "boolean"; default: boolean }
  | { kind: "integer"; default: number; minimum: number; maximum: number }
  | { kind: "string-array"; default: readonly string[]; allowNegative?: boolean }
  | { kind: "string-map"; default: Readonly<Record<string, string>> };

export interface ModuleDisplayConfig {
  threshold: number;
  style: string;
  hidden: boolean;
}

export interface ModuleDefaults {
  format: string;
  symbol: string;
  style: string;
  disabled: boolean;
}

export interface ModuleStyleContext {
  runtime: StarshipRuntimeSnapshot;
  values: Readonly<Record<string, string>>;
  style: string;
  styles: Readonly<Record<string, string>>;
  display: readonly ModuleDisplayConfig[];
}

export interface ModuleDefinition<Name extends string> {
  name: Name;
  variables: readonly string[];
  defaults: ModuleDefaults;
  styleDefaults?: Readonly<Record<string, string>>;
  fallbackStyle?: boolean;
  displayDefaults?: readonly ModuleDisplayConfig[];
  styleVariables?: readonly string[];
  resolveStyleVariables?(context: ModuleStyleContext): Readonly<Record<string, string>> | undefined;
  options?: Readonly<Record<string, ModuleOptionSchema>>;
  layout?: "fill";
  values(context: ModuleValueContext): Record<string, string> | undefined;
}

export function defineModule<const Name extends string>(definition: ModuleDefinition<Name>): ModuleDefinition<Name> {
  return definition;
}

export interface RenderedStatusline<Name extends string = string> {
  ansi: string;
  chunks: StyledChunk[];
  modules: Record<Name, StyledChunk[]>;
}
