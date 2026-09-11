import assert from "node:assert/strict";
import { test } from "vitest";
import { searchProjectContents } from "../src/content-search.js";

const files = new Map([
  ["a.txt", ["Hi narumi, this is your book."]],
  ["b.txt", ["This is a tree."]],
  ["c.txt", ["Nothing to see here."]],
]);

const loadFile = async (path: string) => ({ path, lines: files.get(path) ?? [] });

test("content search defaults to literal case-insensitive matching with exact ranges", async () => {
  const result = await searchProjectContents([...files.keys()], loadFile, "this is");

  assert.deepEqual(
    result.matches.map(({ path, lineNumber, ranges }) => ({ path, lineNumber, ranges })),
    [
      { path: "a.txt", lineNumber: 1, ranges: [{ start: 11, end: 18 }] },
      { path: "b.txt", lineNumber: 1, ranges: [{ start: 0, end: 7 }] },
    ],
  );
  assert.equal(result.truncated, false);
  assert.equal(result.skippedFiles, 0);
  assert.equal((await searchProjectContents([...files.keys()], loadFile, "thisis")).matches.length, 0);
});

test("content search combines same-line literal ranges into one bounded result", async () => {
  const result = await searchProjectContents(
    ["repeated.txt"],
    async (path) => ({ path, lines: ["needle then needle", "later needle"] }),
    "needle",
    { maxResults: 2 },
  );

  assert.deepEqual(
    result.matches.map(({ lineNumber, ranges }) => ({ lineNumber, ranges })),
    [
      {
        lineNumber: 1,
        ranges: [
          { start: 0, end: 6 },
          { start: 12, end: 18 },
        ],
      },
      { lineNumber: 2, ranges: [{ start: 6, end: 12 }] },
    ],
  );
  assert.equal(result.truncated, false);
});

test("content search independently toggles case-sensitive and fuzzy matching", async () => {
  const caseSensitive = await searchProjectContents([...files.keys()], loadFile, "this is", {
    caseSensitive: true,
  });
  assert.deepEqual(
    caseSensitive.matches.map((match) => match.path),
    ["a.txt"],
  );

  const fuzzy = await searchProjectContents([...files.keys()], loadFile, "thisis", { fuzzy: true });
  assert.deepEqual(
    fuzzy.matches.map((match) => match.path),
    ["a.txt", "b.txt"],
  );
  for (const match of fuzzy.matches) {
    const matchedCharacters = match.ranges
      .map((range) => match.line.slice(range.start, range.end))
      .join("")
      .toLowerCase();
    assert.equal(matchedCharacters, "thisis");
  }
});

test("case-insensitive content ranges stay aligned with Unicode source text", async () => {
  const result = await searchProjectContents(["unicode.txt"], async (path) => ({ path, lines: ["İx marker"] }), "x");
  assert.deepEqual(result.matches[0]?.ranges, [{ start: 1, end: 2 }]);
  assert.equal(result.matches[0]?.line.slice(1, 2), "x");
});

test("content search bounds results, reports skipped files, and honors cancellation", async () => {
  const projectFiles = ["first.txt", "binary.bin", "second.txt", "third.txt"];
  const bounded = await searchProjectContents(
    projectFiles,
    async (path) => {
      if (path === "binary.bin") throw new Error("binary");
      return { path, lines: [`${path}: needle`] };
    },
    "needle",
    { maxResults: 2 },
  );
  assert.deepEqual(
    bounded.matches.map((match) => match.path),
    ["first.txt", "second.txt"],
  );
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.skippedFiles, 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchProjectContents([...files.keys()], loadFile, "this", { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
