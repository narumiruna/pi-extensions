import { visibleWidth } from "@earendil-works/pi-tui";

const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const ST = 0x9c;
const OSC = 0x9d;
const DCS = 0x90;
const SOS = 0x98;
const PM = 0x9e;
const APC = 0x9f;
const TAB_SIZE = 4;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Sanitize untrusted multiline terminal text while retaining line feeds and tabs.
 *
 * Keep raw identities and payloads separate from this presentation-only value.
 */
export function sanitizeTerminalDocument(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  let output = "";
  for (let index = 0; index < normalized.length; ) {
    const codePoint = normalized.codePointAt(index) ?? 0;
    const length = codePoint > 0xffff ? 2 : 1;
    if (codePoint === ESC) {
      index = skipEscSequence(normalized, index);
      continue;
    }
    if (codePoint === CSI) {
      index = skipCsi(normalized, index + length);
      continue;
    }
    if (codePoint === OSC || codePoint === DCS || codePoint === SOS || codePoint === PM || codePoint === APC) {
      index = skipStringSequence(normalized, index + length, codePoint === OSC);
      continue;
    }
    if (isBidiControl(codePoint)) {
      index += length;
      continue;
    }
    if (codePoint === 0x0a || codePoint === 0x09) {
      output += String.fromCodePoint(codePoint);
    } else if (isControl(codePoint)) {
      output += " ";
    } else {
      output += String.fromCodePoint(codePoint);
    }
    index += length;
  }
  return output;
}

/** Sanitize, expand tabs, and hard-wrap a terminal document by display-cell width. */
export function hardWrapTerminalDocument(value: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [""];
  const safeWidth = Math.max(1, Math.floor(width));
  return sanitizeTerminalDocument(value)
    .split("\n")
    .flatMap((line) => hardWrapLine(expandTabs(line), safeWidth));
}

function expandTabs(line: string): string {
  let column = 0;
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(line)) {
    if (segment === "\t") {
      const count = TAB_SIZE - (column % TAB_SIZE);
      result += " ".repeat(count);
      column += count;
      continue;
    }
    result += segment;
    column += visibleWidth(segment);
  }
  return result;
}

function hardWrapLine(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const flush = () => {
    lines.push(current);
    current = "";
    currentWidth = 0;
  };
  for (const { segment } of graphemeSegmenter.segment(line)) {
    const segmentWidth = visibleWidth(segment);
    if (segmentWidth > width) {
      if (current.length > 0) flush();
      lines.push("?".repeat(width));
      continue;
    }
    if (currentWidth + segmentWidth > width && current.length > 0) flush();
    current += segment;
    currentWidth += segmentWidth;
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

type SequenceKind = "escape" | "csi" | "string";

function skipEscSequence(value: string, start: number): number {
  return skipSequence(value, "escape", start, false);
}

function skipGenericEscSequence(value: string, start: number): number {
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x2f) break;
    index += 1;
  }
  const final = value.charCodeAt(index);
  return final >= 0x30 && final <= 0x7e ? index + 1 : start + 1;
}

function skipCsi(value: string, start: number): number {
  return skipSequence(value, "csi", start, false);
}

function skipStringSequence(value: string, start: number, bellTerminates: boolean): number {
  return skipSequence(value, "string", start, bellTerminates);
}

function skipSequence(value: string, initialKind: SequenceKind, start: number, initialBellTerminates: boolean): number {
  let kind = initialKind;
  let index = start;
  let bellTerminates = initialBellTerminates;
  while (index < value.length) {
    if (kind === "escape") {
      const introducer = value.charCodeAt(index + 1);
      if (introducer === 0x5b) {
        kind = "csi";
        index += 2;
        continue;
      }
      if (introducer === 0x5d) {
        kind = "string";
        bellTerminates = true;
        index += 2;
        continue;
      }
      if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
        kind = "string";
        bellTerminates = false;
        index += 2;
        continue;
      }
      return skipGenericEscSequence(value, index);
    }

    const code = value.charCodeAt(index);
    if (kind === "string") {
      if (bellTerminates && code === BEL) return index + 1;
      if (code === ST) return index + 1;
      if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    }
    const interrupted = introducedSequenceState(value, index);
    if (interrupted) {
      kind = interrupted.kind;
      index = interrupted.index;
      bellTerminates = interrupted.bellTerminates;
      continue;
    }
    if (kind === "csi" && code >= 0x40 && code <= 0x7e) return index + 1;
    index += 1;
  }
  return value.length;
}

function introducedSequenceState(value: string, start: number) {
  const introducer = value.charCodeAt(start);
  if (introducer === ESC) {
    return { kind: "escape" as const, index: start, bellTerminates: false };
  }
  if (introducer === CSI) {
    return { kind: "csi" as const, index: start + 1, bellTerminates: false };
  }
  if (introducer === OSC || introducer === DCS || introducer === SOS || introducer === PM || introducer === APC) {
    return { kind: "string" as const, index: start + 1, bellTerminates: introducer === OSC };
  }
  return undefined;
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}
