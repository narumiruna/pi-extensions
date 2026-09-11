import type { StarshipConfig } from "../config.js";
import type { ModuleName } from "../modules/catalog.js";
import type { WorkspaceSnapshot } from "../modules/types.js";

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type WorkspaceExec = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    environment: Readonly<Record<string, string | undefined>>;
  },
) => Promise<WorkspaceExecResult>;

export interface WorkspaceEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface WorkspaceFileSystem {
  readFile(path: string, maxBytes: number): Promise<string | undefined>;
  readDirectory(path: string): Promise<readonly WorkspaceEntry[]>;
  fileExists(path: string): Promise<boolean>;
}

export interface WorkspaceRefreshInput {
  cwd: string;
  config: StarshipConfig;
  environment: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  platform: NodeJS.Platform;
  hostname: string;
  username: string;
  exec: WorkspaceExec;
  fileSystem?: Partial<WorkspaceFileSystem>;
  fileExists?(path: string): Promise<boolean>;
  reason?: "initial" | "event" | "periodic";
  previous?: WorkspaceSnapshot;
  signal?: AbortSignal;
}

export interface CollectorContext {
  input: WorkspaceRefreshInput;
  fs: WorkspaceFileSystem;
  requirements: ReadonlyMap<ModuleName, ReadonlySet<string>>;
  entries(): Promise<readonly WorkspaceEntry[]>;
  options(name: ModuleName): Readonly<Record<string, unknown>>;
  needs(name: ModuleName, variable?: string): boolean;
}

export const PRIVATE_STYLE_SELECTOR = "__pi_style_selector";

export type MutableModuleSnapshot = Record<string, Record<string, string>>;
