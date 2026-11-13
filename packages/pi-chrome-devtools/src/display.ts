const MAX_SANITIZER_INPUT_CODE_UNITS = 50_000;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeChromeDevtoolsDisplay(value: string, maxCharacters = 50_000) {
  const inputWasTruncated = value.length > MAX_SANITIZER_INPUT_CODE_UNITS;
  const boundedInput = inputWasTruncated ? truncateAtGraphemeBoundary(value, MAX_SANITIZER_INPUT_CODE_UNITS) : value;
  const normalizedLineEndings = boundedInput.replace(/\r\n/g, "\n");
  // Neutralize controls without parsing untrusted terminal sequences; keep printable payload visible.
  const sanitized = Array.from(normalizedLineEndings, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafeControl =
      (codePoint >= 0 && codePoint <= 8) ||
      (codePoint >= 11 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159);
    const unsafeBidi = (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
    const loneSurrogate = character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff;
    return unsafeControl || unsafeBidi || loneSurrogate ? "�" : character;
  }).join("");
  const outputLimit = Math.min(maxCharacters, MAX_SANITIZER_INPUT_CODE_UNITS);
  if (!inputWasTruncated && sanitized.length <= outputLimit) return sanitized;

  return `${truncateAtGraphemeBoundary(sanitized, Math.max(0, outputLimit - 1))}…`;
}

function truncateAtGraphemeBoundary(value: string, maxCodeUnits: number) {
  if (value.length <= maxCodeUnits) return value;
  const boundedLookahead = value.slice(0, Math.max(0, maxCodeUnits) + 2);
  let safeEnd = 0;
  for (const { index, segment } of graphemeSegmenter.segment(boundedLookahead)) {
    const segmentEnd = index + segment.length;
    if (segmentEnd > maxCodeUnits) break;
    safeEnd = segmentEnd;
  }
  return value.slice(0, safeEnd);
}
