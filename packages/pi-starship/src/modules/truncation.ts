import { sep } from "node:path";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map(({ segment }) => segment);
}

export function firstGrapheme(value: string): string {
  return graphemes(value)[0] ?? "";
}

export function truncateLeadingGraphemes(value: string, length: number, symbol: string): string {
  if (length <= 0) return value;
  const parts = graphemes(value);
  if (parts.length <= length) return value;
  return `${parts.slice(0, length).join("")}${firstGrapheme(symbol)}`;
}

export function toSlashPath(value: string): string {
  return sep === "\\" ? value.replaceAll("\\", "/") : value;
}

export function truncatePathComponents(value: string, length: number): { value: string; truncated: boolean } {
  if (length <= 0) return { value, truncated: false };
  const normalized = toSlashPath(value);
  const components = normalized.split("/").filter((component) => component.length > 0);
  if (components.length <= length) return { value: normalized, truncated: false };
  return { value: components.slice(-length).join("/"), truncated: true };
}

export function useNativePathSeparator(value: string): string {
  return sep === "/" ? value : value.replaceAll("/", sep);
}
