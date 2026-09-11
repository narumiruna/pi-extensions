const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const ST = 0x9c;
const OSC = 0x9d;
const DCS = 0x90;
const SOS = 0x98;
const PM = 0x9e;
const APC = 0x9f;

/**
 * Remove terminal control sequences and display-direction controls from untrusted single-line text.
 *
 * This function is only for presentation. Keep raw identities and payloads separate.
 */
export function sanitizeTerminalText(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    const length = codePoint > 0xffff ? 2 : 1;

    if (codePoint === ESC) {
      index = skipEscSequence(value, index);
      continue;
    }
    if (codePoint === CSI) {
      index = skipCsi(value, index + length);
      continue;
    }
    if (codePoint === OSC || codePoint === DCS || codePoint === SOS || codePoint === PM || codePoint === APC) {
      index = skipStringSequence(value, index + length, codePoint === OSC);
      continue;
    }
    if (isLineSeparator(codePoint)) {
      output += " ";
      index += length;
      continue;
    }
    if (isControl(codePoint) || isBidiControl(codePoint)) {
      index += length;
      continue;
    }

    output += String.fromCodePoint(codePoint);
    index += length;
  }
  return output;
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

function isLineSeparator(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    codePoint === 0x85 ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
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
