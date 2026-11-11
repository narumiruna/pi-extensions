import { createHash } from "node:crypto";
import { basename } from "node:path";
import { CHUNK_MAX_BYTES, CHUNK_OVERLAP_UNITS, CHUNK_TARGET_BYTES, FILE_MAP_MAX_BYTES } from "./constants.js";

export interface SearchChunk {
  sequence: number;
  startLine: number;
  endLine: number;
  heading: string;
  body: string;
  hash: string;
}

export interface ChunkedFile {
  title: string;
  outline: string;
  chunks: SearchChunk[];
}

interface TextUnit {
  text: string;
  line: number;
  continuation: boolean;
}

export function chunkTextFile(path: string, lines: readonly string[]): ChunkedFile {
  const units = toUnits(lines);
  const title = documentTitle(path, lines);
  const outline = buildFileMap(path, title, lines);
  const chunks: SearchChunk[] = [];
  let start = 0;
  let currentHeading = "";

  while (start < units.length) {
    for (let index = chunks.length === 0 ? 0 : start; index >= 0 && index < units.length; index -= 1) {
      const heading = headingText(units[index]?.text ?? "");
      if (heading) {
        currentHeading = heading;
        break;
      }
      if (index === 0) break;
    }

    let bytes = 0;
    let end = start;
    const boundaries: Array<{ end: number; score: number; distance: number }> = [];
    while (end < units.length) {
      const unit = units[end];
      if (!unit) break;
      const separatorBytes = end > start && !unit.continuation ? 1 : 0;
      const nextBytes = Buffer.byteLength(unit.text, "utf8") + separatorBytes;
      if (end > start && bytes + nextBytes > CHUNK_MAX_BYTES) break;
      bytes += nextBytes;
      end += 1;
      if (bytes >= Math.floor(CHUNK_TARGET_BYTES * 0.55)) {
        const next = units[end];
        boundaries.push({
          end,
          score: boundaryScore(unit.text, next?.text),
          distance: Math.abs(bytes - CHUNK_TARGET_BYTES),
        });
      }
      if (bytes >= CHUNK_TARGET_BYTES) break;
    }
    if (end === start) end += 1;

    const chosen = chooseBoundary(boundaries, end);
    end = Math.max(start + 1, chosen);
    const selected = units.slice(start, end);
    const body = joinUnits(selected);
    const heading = [...selected].map((unit) => headingText(unit.text)).find(Boolean) || currentHeading;
    chunks.push({
      sequence: chunks.length,
      startLine: selected[0]?.line ?? 1,
      endLine: selected.at(-1)?.line ?? 1,
      heading,
      body,
      hash: createHash("sha256").update(body, "utf8").digest("hex"),
    });

    if (end >= units.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_UNITS);
  }

  return { title, outline, chunks };
}

export function buildFileMap(path: string, title: string, lines: readonly string[]): string {
  const structural: string[] = [];
  const representative: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (structural.length < 40 && (headingText(trimmed) || isDeclaration(trimmed))) structural.push(trimmed);
    if (representative.length < 2) representative.push(trimmed);
  }
  for (let index = lines.length - 1; index >= 0 && representative.length < 4; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed && !representative.includes(trimmed)) representative.push(trimmed);
  }
  const sections = [
    `Path: ${path}`,
    `Title: ${title}`,
    structural.length > 0 ? `Structure:\n${structural.join("\n")}` : "",
    representative.length > 0 ? `Representative text:\n${representative.join("\n")}` : "",
  ].filter(Boolean);
  return truncateUtf8(sections.join("\n"), FILE_MAP_MAX_BYTES);
}

function toUnits(lines: readonly string[]): TextUnit[] {
  const units: TextUnit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const segments = splitUtf8(lines[index] ?? "", CHUNK_MAX_BYTES);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      units.push({ text: segments[segmentIndex] ?? "", line: index + 1, continuation: segmentIndex > 0 });
    }
  }
  return units.length > 0 ? units : [{ text: "", line: 1, continuation: false }];
}

function chooseBoundary(
  boundaries: readonly { end: number; score: number; distance: number }[],
  fallback: number,
): number {
  if (boundaries.length === 0) return fallback;
  return (
    [...boundaries].sort((left, right) => right.score - left.score || left.distance - right.distance)[0]?.end ??
    fallback
  );
}

function boundaryScore(current: string, next: string | undefined): number {
  const currentTrimmed = current.trim();
  const nextTrimmed = next?.trim() ?? "";
  if (/^#{1,6}\s/u.test(nextTrimmed)) return 100;
  if (/^```/u.test(currentTrimmed) || /^```/u.test(nextTrimmed)) return 80;
  if (isDeclaration(nextTrimmed)) return 70;
  if (/^(?:---+|\*\*\*+)$/u.test(currentTrimmed)) return 60;
  if (!currentTrimmed || !nextTrimmed) return 20;
  if (/^(?:[-*+]\s|\d+[.)]\s)/u.test(nextTrimmed)) return 5;
  return 1;
}

function documentTitle(path: string, lines: readonly string[]): string {
  for (const line of lines) {
    const heading = line.match(/^#\s+(.+)$/u)?.[1]?.trim();
    if (heading) return heading;
  }
  return basename(path);
}

function headingText(value: string): string {
  return value.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim() ?? "";
}

function isDeclaration(value: string): boolean {
  return /^(?:export\s+)?(?:async\s+)?(?:class|interface|type|enum|function|def|func|struct|trait|impl)\s+[\p{L}_$][\p{L}\p{N}_$]*/u.test(
    value,
  );
}

function joinUnits(units: readonly TextUnit[]): string {
  let result = "";
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (!unit) continue;
    if (index > 0 && !unit.continuation) result += "\n";
    result += unit.text;
  }
  return result;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return [value];
  const segments: string[] = [];
  let segment = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes > 0 && bytes + characterBytes > maxBytes) {
      segments.push(segment);
      segment = "";
      bytes = 0;
    }
    segment += character;
    bytes += characterBytes;
  }
  if (segment || segments.length === 0) segments.push(segment);
  return segments;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n…";
  const limit = maxBytes - Buffer.byteLength(suffix, "utf8");
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > limit) break;
    output += character;
    bytes += next;
  }
  return `${output}${suffix}`;
}
