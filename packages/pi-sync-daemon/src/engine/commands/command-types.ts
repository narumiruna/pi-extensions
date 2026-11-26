import type { AnySyncConfig } from "../settings/settings-types.js";
import type { AgentAcceptance } from "../sync/agent-request.js";
import type { StartupTimings } from "../sync/startup-timings.js";

export interface CommandOptions {
  yes: boolean;
  force: boolean;
  stale: boolean;
  silent: boolean;
  reload: boolean;
  auto: boolean;
  setup?: string;
  automaticFingerprint?: string;
  signal?: AbortSignal;
  onCommit?: () => void;
  noteDebugOutcome?: (outcome: "blocked" | "cancelled" | "skipped") => void;
  /** In-memory startup diagnostics only; never persisted or sent to a backend. */
  startupTimings?: StartupTimings;
  /** Internal validated resolver result; never parsed from command arguments. */
  agentAcceptance?: AgentAcceptance;
  /** Internal cycle authorization, ownership and durable request reservation; never command arguments. */
  background?: { validate(config?: AnySyncConfig): void; reserve?(key: string, signal?: AbortSignal): Promise<void> };
  /** Manager-only, separately confirmed retry; never parsed from command arguments. */
  agentRetryRefusal?: boolean;
  validateAgentRetryPolicy?: (config: AnySyncConfig) => void;
  directionalAction?: {
    validate(config: AnySyncConfig): void;
    checkpoint?(fingerprint: string): Promise<void>;
    notifySuccess?(message: string): void;
  };
  args: string[];
}

export interface CommandArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}
