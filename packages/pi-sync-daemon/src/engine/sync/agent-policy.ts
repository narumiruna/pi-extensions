import type { AnySyncConfig } from "../settings/settings-types.js";

/** One policy for startup scheduling and commit-time authorization. */
export function startupTransferEnabled(config: Pick<AnySyncConfig, "automaticTransfer" | "agentMode">) {
  return Boolean(config.automaticTransfer || config.agentMode);
}

export const AGENT_TIMEOUT_MS = 20_000;
export const AGENT_INPUT_BYTES = 24 * 1024;
export const AGENT_OUTPUT_BYTES = 16 * 1024;
export const AGENT_MAX_TOKENS = 8192;
export const AGENT_MAX_UNITS = 16;
export const AGENT_MAX_ATTEMPTS = 2;
