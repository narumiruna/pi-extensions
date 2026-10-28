import * as fs from "node:fs";
import * as path from "node:path";
import { isWithin } from "./attachment-utils.js";
import { MAX_READINESS_FRAME_BYTES } from "./broker-credentials.js";
import { sanitizeTerminalText } from "./message-broker.js";

export interface ChildModelPair {
  provider: string;
  id: string;
}

export type ChildReadinessFrame = { ok: true; sources: string[]; model: ChildModelPair } | { ok: false; error: string };

export function isChildModelPair(value: unknown): value is ChildModelPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return [model.provider, model.id].every(
    (part) =>
      typeof part === "string" &&
      part.trim().length > 0 &&
      ![...part].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      }),
  );
}

export function assertChildModelPair(value: unknown, expected: { provider: string; model: string }): void {
  if (!isChildModelPair(value)) throw new Error("Subagent child model attestation returned an invalid model.");
  if (value.provider !== expected.provider || value.id !== expected.model) {
    throw new Error("Subagent child model does not match the requested provider and model.");
  }
}

export function assertChildModelState(value: unknown, expected: { provider: string; model: string }): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Subagent child model attestation returned invalid state.");
  }
  assertChildModelPair((value as { model?: unknown }).model, expected);
}

export function parseReadinessFrame(buffer: Buffer, expectedToolCount: number): ChildReadinessFrame {
  if (buffer.byteLength > MAX_READINESS_FRAME_BYTES) {
    throw new Error("Subagent readiness frame exceeded its size limit.");
  }
  if (buffer.byteLength === 0) throw new Error("Subagent readiness pipe closed without a result.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error("Subagent readiness pipe returned invalid UTF-8.");
  }
  const newline = text.indexOf("\n");
  if (newline < 0 || newline !== text.length - 1) {
    throw new Error("Subagent readiness pipe returned an invalid frame.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, newline));
  } catch {
    throw new Error("Subagent readiness pipe returned malformed JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Subagent readiness pipe returned an invalid result.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.ok === true &&
    Object.keys(record).length === 3 &&
    Array.isArray(record.sources) &&
    record.sources.length === expectedToolCount &&
    record.sources.every((source) => typeof source === "string" && /^[a-f0-9]{64}$/u.test(source)) &&
    isChildModelPair(record.model) &&
    Object.keys(record.model).length === 2
  ) {
    return { ok: true, sources: record.sources, model: record.model };
  }
  if (
    record.ok === false &&
    Object.keys(record).length === 2 &&
    typeof record.error === "string" &&
    record.error.length > 0 &&
    Buffer.byteLength(record.error, "utf8") <= 8 * 1024
  ) {
    return { ok: false, error: sanitizeTerminalText(record.error) };
  }
  throw new Error("Subagent readiness pipe returned an invalid result.");
}

export function assertTrustedChildResources(value: unknown, cwd: string): void {
  const invalid = () => new Error("Subagent child resource attestation returned invalid commands.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const commands = (value as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) throw invalid();
  let canonicalCwd: string;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    throw invalid();
  }
  for (const command of commands) {
    if (!command || typeof command !== "object" || Array.isArray(command)) throw invalid();
    const entry = command as { source?: unknown; sourceInfo?: { path?: unknown } };
    if (entry.source !== "skill" && entry.source !== "prompt") continue;
    const resourcePath = entry.sourceInfo?.path;
    if (typeof resourcePath !== "string" || !resourcePath) throw invalid();
    const lexicalPath = path.resolve(cwd, resourcePath);
    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(lexicalPath);
    } catch {
      throw invalid();
    }
    if (isWithin(cwd, lexicalPath) || isWithin(canonicalCwd, canonicalPath)) {
      throw new Error("Subagent child cannot load project resources because the project is not trusted.");
    }
  }
}
