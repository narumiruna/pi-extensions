import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { HerdrRequest } from "./herdr-client.js";

export const HERDR_METADATA_TOKEN_KEYS = ["model", "provider", "thinking", "session", "context_usage"] as const;

export type HerdrMetadataTokenKey = (typeof HERDR_METADATA_TOKEN_KEYS)[number];
export type HerdrMetadataSnapshot = Readonly<Record<HerdrMetadataTokenKey, string | null>>;

export const HERDR_METADATA_MAX_CHARACTERS = 80;
export const HERDR_METADATA_TTL_MS = 60 * 60 * 1000;
export const HERDR_METADATA_REFRESH_MS = 30 * 60 * 1000;

export interface HerdrMetadataInputs {
  model?: unknown;
  provider?: unknown;
  thinking?: unknown;
  session?: unknown;
  contextUsagePercent?: unknown;
}

export interface HerdrMetadataRequestOptions {
  id: string;
  paneId: string;
  source: string;
  seq: number;
  snapshot: HerdrMetadataSnapshot;
  ttlMs?: number;
}

export function normalizeHerdrMetadataValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = sanitizeTerminalText(value).trim();
  if (normalized.length === 0) return null;
  return [...normalized].slice(0, HERDR_METADATA_MAX_CHARACTERS).join("");
}

export function formatContextUsagePercent(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return `${Math.round(value)}%`;
}

export function createHerdrMetadataSnapshot(inputs: HerdrMetadataInputs): HerdrMetadataSnapshot {
  return Object.freeze({
    model: normalizeHerdrMetadataValue(inputs.model),
    provider: normalizeHerdrMetadataValue(inputs.provider),
    thinking: normalizeHerdrMetadataValue(inputs.thinking),
    session: normalizeHerdrMetadataValue(inputs.session),
    context_usage: formatContextUsagePercent(inputs.contextUsagePercent),
  });
}

export function createHerdrMetadataClearSnapshot(): HerdrMetadataSnapshot {
  return Object.freeze({
    model: null,
    provider: null,
    thinking: null,
    session: null,
    context_usage: null,
  });
}

export function herdrMetadataSnapshotsEqual(
  left: HerdrMetadataSnapshot | undefined,
  right: HerdrMetadataSnapshot,
): boolean {
  return left !== undefined && HERDR_METADATA_TOKEN_KEYS.every((key) => left[key] === right[key]);
}

export function createHerdrMetadataRequest(options: HerdrMetadataRequestOptions): HerdrRequest {
  return {
    id: options.id,
    method: "pane.report_metadata",
    params: {
      pane_id: options.paneId,
      source: options.source,
      seq: options.seq,
      tokens: { ...options.snapshot },
      ttl_ms: options.ttlMs ?? HERDR_METADATA_TTL_MS,
    },
  };
}
