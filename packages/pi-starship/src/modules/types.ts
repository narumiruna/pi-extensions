import type { UIPromptKind } from "@earendil-works/pi-coding-agent";
import type { FormatValue } from "../format/formatter.js";
import type { ColorPalette, StyledChunk } from "../format/style.js";

export interface GitBranchSnapshot {
  name: string;
  remoteName?: string;
  remoteBranch?: string;
  detached: boolean;
  bare?: boolean;
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
  upToDate?: boolean;
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

export interface JujutsuBookmark {
  readonly name: string;
  readonly remote: string;
  readonly diverged: boolean;
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
  styles: Readonly<Record<string, string>>;
}

export interface ModuleContextRule {
  readonly context_pattern: string;
  readonly user_pattern?: string;
  readonly symbol?: string;
  readonly style?: string;
  readonly context_alias?: string;
  readonly user_alias?: string;
}

export interface ModuleSubstitution {
  readonly from: string;
  readonly to: string;
  readonly regex?: boolean;
}

export type ModuleOptionValue =
  | string
  | boolean
  | number
  | readonly string[]
  | Readonly<Record<string, string>>
  | readonly ModuleContextRule[]
  | readonly ModuleSubstitution[]
  | readonly (string | readonly string[])[];

export interface ModuleValueContext {
  runtime: StarshipRuntimeSnapshot;
  palette: ColorPalette;
  symbol: string;
  styles?: Readonly<Record<string, string>>;
  requestedVariables?: ReadonlySet<string>;
  options: Readonly<Record<string, ModuleOptionValue>>;
  extensionStatus: ExtensionStatusPresentation;
}

export type ModuleOptionSchema =
  | { kind: "string"; default: string; allowEmpty?: boolean; templateVariables?: readonly string[] }
  | { kind: "string-enum"; default: string; values: readonly string[] }
  | { kind: "boolean"; default: boolean }
  | { kind: "integer" | "number"; default: number; minimum: number; maximum: number }
  | { kind: "string-array"; default: readonly string[]; allowNegative?: boolean }
  | { kind: "string-map"; default: Readonly<Record<string, string>> }
  | { kind: "command-alternatives"; default: readonly (string | readonly string[])[] }
  | { kind: "context-rules"; default: readonly ModuleContextRule[] }
  | { kind: "substitutions"; default: Readonly<Record<string, string>> | readonly ModuleSubstitution[] };

export interface ModuleDisplayConfig {
  threshold: number;
  style: string;
  hidden: boolean;
}

export interface ModuleStyleRule {
  style: string;
  selectors: Readonly<Record<string, string>>;
}

export interface ModuleDefaults {
  format: string;
  symbol: string;
  style: string;
  disabled: boolean;
}

export interface ModuleStyleContext {
  runtime: StarshipRuntimeSnapshot;
  style: string;
  styles: Readonly<Record<string, string>>;
  display: readonly ModuleDisplayConfig[];
  options: Readonly<Record<string, ModuleOptionValue>>;
}

export type ModuleStyleSelector = (context: ModuleStyleContext) => string | undefined;

export interface ModuleDefinition<Name extends string> {
  name: Name;
  variables: readonly string[];
  defaults: ModuleDefaults;
  styleDefaults?: Readonly<Record<string, string>>;
  fallbackStyle?: boolean;
  displayDefaults?: readonly ModuleDisplayConfig[];
  styleVariables?: readonly string[];
  styleRuleSelectors?: Readonly<Record<string, ModuleStyleSelector>>;
  resolveStyleVariables?(context: ModuleStyleContext): Readonly<Record<string, string>> | undefined;
  options?: Readonly<Record<string, ModuleOptionSchema>>;
  layout?: "fill";
  resolveFormat?(context: ModuleValueContext, values: Readonly<Record<string, FormatValue>>): string | undefined;
  values(context: ModuleValueContext): Record<string, FormatValue> | undefined;
}

export function defineModule<const Name extends string>(definition: ModuleDefinition<Name>): ModuleDefinition<Name> {
  return definition;
}

export interface RenderedStatusline<Name extends string = string> {
  ansi: string;
  chunks: StyledChunk[];
  modules: Record<Name, StyledChunk[]>;
}
