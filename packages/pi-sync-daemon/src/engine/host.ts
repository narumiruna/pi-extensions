import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AnySyncConfig } from "./settings/settings-types.js";

export interface EngineModelStream extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
}
export interface EngineModelRegistry {
  streamSimple(...args: Parameters<ModelRegistry["streamSimple"]>): EngineModelStream;
}
export interface EngineSession {
  getSessionFile?(): string | undefined;
  getSessionId?(): string;
  getCwd?(): string;
  getSessionDir?(): string;
  usesDefaultSessionDir?(): boolean;
}
export interface EngineContext {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  model?: Model<Api>;
  modelUnavailableReason?: string;
  modelRegistry: EngineModelRegistry;
  sessionManager: EngineSession;
  isIdle(): boolean;
  validateModel?(): Promise<void>;
  backgroundAuthorized?(config?: AnySyncConfig): boolean;
  reload?(): Promise<void>;
  /** Additional sessions are protected by the service, including disconnected live clients. */
  protectedSessionFiles?: readonly string[];
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
    confirm(title: string, message: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
    select(
      title: string,
      items: string[],
      options?: { signal?: AbortSignal; timeout?: number; helpText?: string },
    ): Promise<string | undefined>;
  };
}
export interface ReviewRequest {
  title: string;
  content: string;
  confirmationLabel: string;
  summaryLines?: readonly string[];
}
export interface ConfigAuthority {
  read(repair?: boolean): Promise<import("./settings/config-file.js").LocalConfigDocument | undefined>;
  update<T extends Record<string, unknown>>(
    fallback: T,
    update: (value: T) => T,
    validate: (value: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<T>;
  create(value: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  replace(
    document: import("./settings/config-file.js").LocalConfigDocument,
    value: Record<string, unknown>,
  ): Promise<void>;
}
export interface EngineHost {
  root(): string;
  config?: ConfigAuthority;
  allowConfigMigration?(): boolean;
  mutate<T>(target: string, action: () => Promise<T>): Promise<T>;
  reserveTargets?<T>(targets: readonly string[], action: () => Promise<T>): Promise<T>;
  review(
    ctx: EngineContext,
    request: ReviewRequest,
    signal: AbortSignal | undefined,
    isCurrent: () => boolean,
  ): Promise<boolean>;
  status?(ctx: EngineContext, value: string | undefined, presentation?: unknown): void;
}
let host: EngineHost | undefined;
/** One explicit host per process. A daemon process serves exactly one canonical root. */
export function configureEngineHost(value: EngineHost) {
  host = value;
}
export function engineHost(): EngineHost {
  if (!host) throw new Error("Synchronization engine host is not configured.");
  return host;
}
export function getEngineRoot() {
  return engineHost().root();
}
export function withEngineMutationQueue<T>(target: string, action: () => Promise<T>) {
  return engineHost().mutate(target, action);
}
