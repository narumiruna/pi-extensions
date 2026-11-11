import assert from "node:assert/strict";
import { test } from "vitest";
import { buildFileMap, chunkTextFile } from "../src/chunks.js";
import { CHUNK_MAX_BYTES, FILE_MAP_MAX_BYTES } from "../src/constants.js";

test("chunking keeps stable line coordinates and prefers natural boundaries", () => {
  const lines = [
    "# Search Design",
    "",
    ...Array.from({ length: 80 }, (_, index) => `Paragraph ${index}: ${"content ".repeat(10)}`),
    "",
    "## Database",
    ...Array.from({ length: 40 }, (_, index) => `SQLite detail ${index}: ${"transaction ".repeat(10)}`),
  ];
  const result = chunkTextFile("docs/search.md", lines);

  assert.equal(result.title, "Search Design");
  assert.ok(result.chunks.length > 1);
  assert.equal(result.chunks[0]?.startLine, 1);
  for (const chunk of result.chunks) {
    assert.ok(chunk.startLine >= 1);
    assert.ok(chunk.endLine >= chunk.startLine);
    assert.ok(Buffer.byteLength(chunk.body, "utf8") <= CHUNK_MAX_BYTES);
  }
  for (let index = 1; index < result.chunks.length; index += 1) {
    assert.ok((result.chunks[index]?.startLine ?? 0) <= (result.chunks[index - 1]?.endLine ?? 0) + 1);
  }
  assert.match(result.outline, /## Database/);
});

test("long Unicode lines split without broken code points or oversized chunks", () => {
  const source = "😀界".repeat(CHUNK_MAX_BYTES);
  const result = chunkTextFile("long.txt", [source]);
  assert.ok(result.chunks.length > 1);
  assert.equal(result.chunks.map((chunk) => chunk.body).join(""), source);
  assert.ok(result.chunks.every((chunk) => !chunk.body.includes("�")));
  assert.ok(result.chunks.every((chunk) => Buffer.byteLength(chunk.body, "utf8") <= CHUNK_MAX_BYTES));
  assert.ok(result.chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1));
});

test("file maps stay bounded and retain paths, declarations, and representative text", () => {
  const lines = [
    "# API",
    "export interface SearchRequest {}",
    ...Array.from({ length: 500 }, (_, index) => `line-${index} ${"x".repeat(40)}`),
    "final behavior",
  ];
  const map = buildFileMap("src/search.ts", "API", lines);
  assert.ok(Buffer.byteLength(map, "utf8") <= FILE_MAP_MAX_BYTES);
  assert.match(map, /Path: src\/search\.ts/);
  assert.match(map, /SearchRequest/);
  assert.match(map, /final behavior/);
});

test("empty files still receive one deterministic chunk", () => {
  const result = chunkTextFile("empty.txt", [""]);
  assert.equal(result.chunks.length, 1);
  assert.deepEqual(
    { start: result.chunks[0]?.startLine, end: result.chunks[0]?.endLine, body: result.chunks[0]?.body },
    { start: 1, end: 1, body: "" },
  );
});
