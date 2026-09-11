import { sanitizeTerminalText } from "./message-broker.js";

export const MAX_MODEL_TEXT_BYTES = 50 * 1024;
export const MAX_MODEL_TEXT_LINES = 2_000;

const TRUNCATION_MARKER = "… [truncated]";

export function requireBoundedModelText(text: string, label: string): string {
  const result = sanitizeTerminalText(text);
  if (Buffer.byteLength(result, "utf8") > MAX_MODEL_TEXT_BYTES) {
    throw new Error(`${label} exceeds Pi's ${MAX_MODEL_TEXT_BYTES}-byte model-text limit.`);
  }
  if (result.split("\n").length > MAX_MODEL_TEXT_LINES) {
    throw new Error(`${label} exceeds Pi's ${MAX_MODEL_TEXT_LINES}-line model-text limit.`);
  }
  return result;
}

export function truncateModelText(text: string): string {
  let result = sanitizeTerminalText(text);
  const bytes = Buffer.from(result, "utf8");
  if (bytes.length > MAX_MODEL_TEXT_BYTES) {
    const suffix = `\n${TRUNCATION_MARKER}`;
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    result = `${bytes
      .subarray(0, Math.max(0, MAX_MODEL_TEXT_BYTES - suffixBytes))
      .toString("utf8")
      .replace(/�+$/gu, "")}${suffix}`;
  }
  const lines = result.split("\n");
  if (lines.length > MAX_MODEL_TEXT_LINES) {
    result = `${lines.slice(0, MAX_MODEL_TEXT_LINES - 1).join("\n")}\n${TRUNCATION_MARKER}`;
  }
  return result;
}

export function modelVisibleJson(value: unknown, options: { prefix?: string; indent?: number } = {}): string {
  return truncateModelText(`${options.prefix ?? ""}${JSON.stringify(value, null, options.indent)}`);
}
