export interface Guard {
  signal: AbortSignal;
  check(): void;
  isProjectTrusted(): boolean;
}

export interface Location {
  id: string;
  label: string;
  path: string;
  scope: "project" | "user" | "custom";
  readOnlyReason?: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  warnings: string[];
  disabledReason?: string;
}

export interface RemoteSkill extends SkillMetadata {
  id: string;
  directory: string;
  directoryName: string;
  content: string;
}

export interface GitEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export interface RepositorySnapshot {
  repository: string;
  commit: string;
  skills: RemoteSkill[];
  entries: GitEntry[];
}

export interface BundleFile {
  path: string;
  content: Uint8Array;
  executable: boolean;
}

export interface SkillBundle {
  id: string;
  directoryName: string;
  name: string;
  files: BundleFile[];
  warnings: string[];
}

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  directoryPath: string;
  location: Location;
  content: string;
  warnings: string[];
  readOnlyReason?: string;
  fingerprint: string;
}

export interface Inventory {
  skills: LocalSkill[];
  warnings: string[];
}

export interface Environment {
  cwd: string;
  agentDir: string;
  homeDir: string;
  isProjectTrusted(): boolean;
}

export type RegistrationScope = "project" | "user" | "none";

export interface RegistrationPlan {
  scope: "project" | "user";
  root: string;
  settingsPath: string;
  storedPath: string;
  before: string | undefined;
}

export type OperationRequest =
  | { kind: "add"; target: Location; bundles: SkillBundle[] }
  | { kind: "remove"; skills: LocalSkill[] }
  | { kind: "move"; target: Location; skills: LocalSkill[] };

export interface OperationResult {
  status: "installed" | "removed" | "moved" | "skipped" | "failed" | "source-retained";
  source?: string;
  destination?: string;
  message: string;
  changed: boolean;
}

export interface PreparedBatch {
  kind: OperationRequest["kind"];
  summary: string[];
  apply(guard: Guard, register?: () => Promise<void>): Promise<OperationResult[]>;
}
