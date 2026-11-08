import assert from "node:assert/strict";
import { test } from "vitest";
import { ProjectFileSearch } from "../src/file-search.js";

test("ranks fuzzy file matches and tolerates typos", () => {
  const files = ["file-context.ts-notes/README.md", "src/file-context.ts", "src/settings.ts", "docs/guide.md"];

  const search = new ProjectFileSearch(files);
  assert.deepEqual(search.search("  FILE-context.ts  "), ["src/file-context.ts", "file-context.ts-notes/README.md"]);
  assert.deepEqual(search.search("src/settings"), ["src/settings.ts"]);
  assert.deepEqual(search.search("fc"), ["src/file-context.ts", "file-context.ts-notes/README.md"]);
  assert.deepEqual(search.search("stg"), ["src/settings.ts"]);
  assert.deepEqual(search.search("setxings"), ["src/settings.ts"]);
  assert.deepEqual(search.search("settigns"), ["src/settings.ts"]);
  assert.deepEqual(search.search("file-contexx.ts"), ["src/file-context.ts", "file-context.ts-notes/README.md"]);
  assert.deepEqual(search.search("zzzzzz"), []);
  assert.deepEqual(search.search("  "), files);
});

test("searches terminal-safe copies without changing returned raw paths", () => {
  const unsafePath = "src/unsafe\u001b[31m.ts";
  const search = new ProjectFileSearch([unsafePath]);

  assert.deepEqual(search.search("unsafe\\x1b"), [unsafePath]);
  assert.deepEqual(search.search("unsafe\u001b"), [unsafePath]);
});

test("bounds fuzzy search before scoring overlong pasted queries", () => {
  const maximumQuery = "a".repeat(256);
  const overlongQuery = `${maximumQuery}a`;

  assert.deepEqual(new ProjectFileSearch([maximumQuery]).search(maximumQuery), [maximumQuery]);
  assert.deepEqual(new ProjectFileSearch([overlongQuery]).search(overlongQuery), []);
});
