import { createHash } from "node:crypto";

export interface HerdrSpawnProvenance {
  originTerminalId: string;
  originSession: string;
  targetSession: string;
  originLabel: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function terminalIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

/** Correlates public native Pi identity; neither the source name nor this digest authenticates a caller. */
export function herdrSessionFingerprint(terminalId: unknown, session: unknown): string | undefined {
  if (
    !terminalIdentity(terminalId) ||
    !record(session) ||
    session.source !== "herdr:pi" ||
    session.agent !== "pi" ||
    (session.kind !== "id" && session.kind !== "path") ||
    typeof session.value !== "string" ||
    session.value.length === 0 ||
    Buffer.byteLength(session.value, "utf8") > 4096
  ) {
    return undefined;
  }
  // Wire format shared with the standalone skill producer; round-trip tests prevent drift.
  return createHash("sha256")
    .update(JSON.stringify([terminalId, session.source, session.agent, session.kind, session.value]))
    .digest("hex");
}

export function parseHerdrSpawnProvenance(
  tokens: unknown,
  targetTerminalId: string,
  targetSession: string | undefined,
): HerdrSpawnProvenance | undefined {
  if (!record(tokens) || tokens.pi_spawn_v !== "1" || !targetSession) return undefined;
  const originTerminalId = tokens.pi_spawn_origin;
  const originSession = tokens.pi_spawn_from;
  const originLabel = tokens.pi_spawn_label;
  if (
    !terminalIdentity(originTerminalId) ||
    [...originTerminalId].length > 80 ||
    originTerminalId === targetTerminalId ||
    typeof originSession !== "string" ||
    !/^[a-f0-9]{64}$/u.test(originSession) ||
    tokens.pi_spawn_to !== targetSession ||
    typeof originLabel !== "string" ||
    originLabel.length === 0 ||
    [...originLabel].length > 80
  ) {
    return undefined;
  }
  return { originTerminalId, originSession, targetSession, originLabel };
}
