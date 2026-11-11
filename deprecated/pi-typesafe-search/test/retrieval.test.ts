import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { SearchChunk } from "../src/chunks.js";
import { openSearchDatabase, type SearchDatabase } from "../src/database.js";
import {
  chunksForSemanticFiles,
  mergeCandidates,
  type RetrievedChunk,
  retrieveLexicalCandidates,
  selectFileMaps,
} from "../src/retrieval.js";
import { ftsExpression, searchTerms } from "../src/text-normalization.js";

async function withDatabase(fn: (database: SearchDatabase) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-jev-retrieval-"));
  const database = await openSearchDatabase("/workspace", directory);
  try {
    await fn(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function chunk(body: string, sequence = 0): SearchChunk {
  return {
    sequence,
    startLine: sequence * 10 + 1,
    endLine: sequence * 10 + 5,
    heading: sequence === 0 ? "Authentication" : "Details",
    body,
    hash: `${sequence}-${body}`,
  };
}

function addFile(database: SearchDatabase, filePath: string, title: string, chunks: SearchChunk[]) {
  database.replaceFile(
    {
      path: filePath,
      dev: "1",
      ino: filePath,
      size: chunks.reduce((size, item) => size + item.body.length, 0),
      mtimeNs: "1",
      hash: filePath,
      title,
      outline: `Path: ${filePath}\nTitle: ${title}`,
    },
    chunks,
  );
}

test("normalization splits identifiers, protects FTS syntax, and creates CJK bigrams", () => {
  assert.deepEqual(searchTerms("refreshToken snake_case kebab-case"), ["refresh", "token", "snake", "case", "kebab"]);
  assert.deepEqual(searchTerms("使用者登入"), ["使用", "用者", "者登", "登入"]);
  assert.equal(searchTerms("使".repeat(1_000)).length, 1);
  assert.deepEqual(searchTerms(`${"使".repeat(1_000)} authentication`), ["使使", "authentication"]);
  assert.equal(
    searchTerms(Array.from({ length: 1_000 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("")).length,
    32,
  );
  const expression = ftsExpression('auth" OR *');
  assert.ok(expression);
  assert.doesNotMatch(expression, / OR \*/);
});

test("multi-query FTS weights the original query and uses alternatives for alias recall", async () => {
  await withDatabase(async (database) => {
    addFile(database, "auth.md", "Authentication", [chunk("refresh token rotation keeps sessions alive")]);
    addFile(database, "cookie.md", "Cookies", [chunk("browser cookie policy")]);

    const original = retrieveLexicalCandidates(database, "refresh token", []);
    assert.equal(original[0]?.filePath, "auth.md");
    assert.equal(original[0]?.sources[0]?.weight, 2);

    const alias = retrieveLexicalCandidates(database, "stay signed in", ["refresh token"]);
    assert.equal(alias[0]?.filePath, "auth.md");
    assert.ok((alias[0]?.rrfScore ?? 0) > 0);
  });
});

test("candidate limits reserve room for the semantic file lane", () => {
  const candidate = (id: number, lexicalRank?: number, fileScore?: number): RetrievedChunk => ({
    id,
    filePath: `${id}.md`,
    sequence: 0,
    startLine: 1,
    endLine: 1,
    heading: "",
    body: String(id),
    hash: String(id),
    rrfScore: lexicalRank ? 1 / lexicalRank : 0,
    lexicalRank,
    fileScore,
    sources: [],
  });
  const lexical = Array.from({ length: 50 }, (_, index) => candidate(index + 1, index + 1));
  const semantic = Array.from({ length: 8 }, (_, index) => candidate(100 + index, undefined, 0.9));
  const merged = mergeCandidates(lexical, semantic);
  assert.equal(merged.length, 40);
  assert.ok(semantic.every((item) => merged.some((candidate) => candidate.id === item.id)));
});

test("file maps and semantic files add representative chunks without duplicating lexical candidates", async () => {
  await withDatabase(async (database) => {
    addFile(database, "auth.md", "Authentication", [chunk("login entry"), chunk("token rotation", 1)]);
    addFile(database, "billing.md", "Billing", [chunk("invoice payment")]);
    const lexical = retrieveLexicalCandidates(database, "invoice", []);
    const maps = selectFileMaps(database, lexical);
    assert.equal(maps[0]?.path, "billing.md");

    const semantic = chunksForSemanticFiles(database, "session", [], [{ path: "auth.md", score: 0.9 }]);
    assert.ok(semantic.length >= 1);
    assert.ok(semantic.every((candidate) => candidate.fileScore === 0.9));

    const merged = mergeCandidates(lexical, semantic);
    assert.equal(new Set(merged.map((candidate) => candidate.id)).size, merged.length);
    assert.ok(merged.some((candidate) => candidate.filePath === "auth.md"));
  });
});
