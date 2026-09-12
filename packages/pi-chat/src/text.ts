const REPLACEMENT = "�";

export function sanitizeChatText(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  let result = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code === 0x1b) {
      index = escapeSequenceEnd(normalized, index);
      result += REPLACEMENT;
      continue;
    }
    const point = normalized.codePointAt(index) ?? code;
    if (isBidiControl(point) || isUnsafeControl(point)) {
      result += REPLACEMENT;
      continue;
    }
    if (code === 0x09) {
      result += "    ";
      continue;
    }
    result += String.fromCodePoint(point);
    if (point > 0xffff) index += 1;
  }
  return result;
}

export function sanitizeSingleLine(value: string): string {
  return sanitizeChatText(value).replace(/\n+/gu, " ");
}

function escapeSequenceEnd(value: string, start: number): number {
  const introducer = value.charCodeAt(start + 1);
  if (introducer === 0x5d) {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x07) return index;
      if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 1;
    }
    return value.length - 1;
  }
  if (introducer === 0x50) {
    for (let index = start + 2; index < value.length; index += 1) {
      if (value.charCodeAt(index) === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
        return index + 1;
      }
    }
    return value.length - 1;
  }
  if (introducer === 0x5b) {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return value.length - 1;
  }
  return Math.min(start + 1, value.length - 1);
}

function isUnsafeControl(point: number): boolean {
  if (point === 0x0a || point === 0x09) return false;
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
}

function isBidiControl(point: number): boolean {
  return (
    point === 0x061c ||
    point === 0x200e ||
    point === 0x200f ||
    (point >= 0x202a && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x2069)
  );
}
