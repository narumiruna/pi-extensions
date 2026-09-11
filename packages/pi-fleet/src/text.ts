export function safeTerminalText(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isTerminalControl(codePoint)) continue;
    output += character === "\t" ? "    " : character;
  }
  return output;
}

export function safeTerminalLine(value: string): string {
  return safeTerminalText(value)
    .replace(/[\r\n]+/gu, " ")
    .trim();
}

export function safeError(error: unknown): string {
  return safeTerminalLine(error instanceof Error ? error.message : String(error));
}

export function normalizeOptionalText(value: string | undefined, label: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.includes("\0") || Buffer.byteLength(normalized) > maxBytes) {
    throw new Error(`Pi Fleet ${label} is invalid or too large`);
  }
  return normalized;
}

function isTerminalControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}
