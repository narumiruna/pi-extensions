const MAX_NICKNAME_GRAPHEMES = 24;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function normalizeNickname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || /\p{Cc}/u.test(normalized) || BIDI_CONTROLS.test(normalized)) return undefined;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  if (Array.from(segmenter.segment(normalized)).length > MAX_NICKNAME_GRAPHEMES) return undefined;
  return normalized;
}
