import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NoulQuestion, RequestOptions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { test } from "vitest";
import { chunkTextFile } from "../src/chunks.js";
import { CHUNK_MAX_BYTES } from "../src/constants.js";
import { openSearchDatabase } from "../src/database.js";
import { discoverSearchFiles } from "../src/files.js";
import { JevEvaluator, type SystemOneClient } from "../src/jev-client.js";
import { mergeOverlappingMatches, type SearchMatch, searchIndexedWorkspace } from "../src/search.js";

class RelevanceClient implements SystemOneClient {
  requests = 0;

  constructor(private readonly screenFiles = true) {}

  async systemOne(
    request: SystemOneRequest<Record<string, NoulQuestion>>,
    _options?: RequestOptions,
  ): Promise<SystemOneResult<Record<string, NoulQuestion>>> {
    this.requests += 1;
    const state = request.state as { query: string; candidates: Array<{ path: string; text: string }> };
    const answers = Object.fromEntries(
      state.candidates.map((candidate, index) => {
        const isChunk = candidate.path.includes(":");
        const relevant =
          !state.query.includes("unfindable") &&
          (isChunk || this.screenFiles) &&
          /authentication|refresh token|relevant-marker/iu.test(`${candidate.path} ${candidate.text}`);
        return [`candidate_${index}`, { type: "noul" as const, noul: relevant ? 0.9 : 0.1 }];
      }),
    );
    return { model: "jev-test", answers, usage: { input_tokens: 20, output_tokens: 2 } };
  }
}

async function withFixture(fn: (workspace: string, agentDirectory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-typesafe-search-"));
  const workspace = path.join(root, "workspace");
  const agentDirectory = path.join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  try {
    await fn(workspace, agentDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("search combines file-level semantic recall with final chunk judgments and reuses a warm index", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    await writeFile(
      path.join(workspace, "auth.md"),
      "# Authentication\nRefresh token rotation restores user sessions.\n",
    );
    await writeFile(path.join(workspace, "billing.md"), "# Billing\nInvoices and card payments.\n");
    const database = await openSearchDatabase(workspace, agentDirectory);
    const evaluator = new JevEvaluator("secret", new RelevanceClient());
    const discovery = await discoverSearchFiles(workspace, ".");

    const first = await searchIndexedWorkspace({
      database,
      discovery,
      evaluator,
      request: { query: "how users stay signed in", alternatives: [], limit: 3 },
    });
    assert.equal(first.index.indexed, 2);
    assert.equal(first.matches[0]?.filePath, "auth.md");
    assert.equal(first.matches[0]?.relevance, 0.9);

    const second = await searchIndexedWorkspace({
      database,
      discovery: await discoverSearchFiles(workspace, "."),
      evaluator,
      request: { query: "how users stay signed in", alternatives: ["refresh token"], limit: 3 },
    });
    assert.equal(second.index.indexed, 0);
    assert.equal(second.index.unchanged, 2);
    assert.equal(second.matches[0]?.filePath, "auth.md");
    database.close();
  });
});

test("search progressively widens candidates and returns no-match results honestly", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    for (let index = 0; index < 25; index += 1) {
      const prefix = String(index).padStart(2, "0");
      const marker = index === 24 ? "relevant-marker" : "ordinary";
      await writeFile(path.join(workspace, `${prefix}.txt`), `needle ${marker}\n`);
    }
    const database = await openSearchDatabase(workspace, agentDirectory);
    const evaluator = new JevEvaluator("secret", new RelevanceClient(false));
    const discovery = await discoverSearchFiles(workspace, ".");
    const response = await searchIndexedWorkspace({
      database,
      discovery,
      evaluator,
      request: { query: "needle", alternatives: [], limit: 1 },
    });
    assert.equal(response.matches[0]?.filePath, "24.txt");
    assert.ok(response.candidatesEvaluated > 20);

    const none = await searchIndexedWorkspace({
      database,
      discovery: await discoverSearchFiles(workspace, "."),
      evaluator,
      request: { query: "unfindable", alternatives: [], limit: 2 },
    });
    assert.deepEqual(none.matches, []);
    database.close();
  });
});

test("overlapping matches merge line ranges without duplicating hits", () => {
  const base = {
    id: 1,
    filePath: "a.md",
    sequence: 0,
    heading: "A",
    hash: "one",
    rrfScore: 1,
    sources: [],
    relevance: 0.9,
  };
  const matches: SearchMatch[] = [
    { ...base, startLine: 1, endLine: 3, body: "one\ntwo\nthree" },
    { ...base, id: 2, sequence: 1, hash: "two", startLine: 3, endLine: 5, body: "three\nfour\nfive", relevance: 0.8 },
  ];
  const merged = mergeOverlappingMatches(matches);
  assert.equal(merged.length, 1);
  assert.deepEqual(
    { start: merged[0]?.startLine, end: merged[0]?.endLine, body: merged[0]?.body },
    { start: 1, end: 5, body: "one\ntwo\nthree\nfour\nfive" },
  );
});

test("overlap merging closes transitive ranges regardless of relevance order", () => {
  const base = {
    id: 1,
    filePath: "a.md",
    heading: "A",
    hash: "one",
    rrfScore: 1,
    sources: [],
  };
  const matches: SearchMatch[] = [
    { ...base, sequence: 0, startLine: 1, endLine: 3, body: "one\ntwo\nthree", relevance: 0.9 },
    { ...base, id: 3, sequence: 2, startLine: 5, endLine: 7, body: "five\nsix\nseven", relevance: 0.8 },
    { ...base, id: 2, sequence: 1, startLine: 3, endLine: 5, body: "three\nfour\nfive", relevance: 0.7 },
  ];

  const merged = mergeOverlappingMatches(matches);
  assert.equal(merged.length, 1);
  assert.deepEqual(
    { start: merged[0]?.startLine, end: merged[0]?.endLine, body: merged[0]?.body },
    { start: 1, end: 7, body: "one\ntwo\nthree\nfour\nfive\nsix\nseven" },
  );
});

test("overlap merging preserves every segment from a split long line", () => {
  const source = "abcdef界".repeat(CHUNK_MAX_BYTES);
  const chunks = chunkTextFile("long.txt", [source]).chunks;
  const matches: SearchMatch[] = chunks.map((chunk, index) => ({
    ...chunk,
    id: index + 1,
    filePath: "long.txt",
    rrfScore: 1,
    sources: [],
    relevance: 0.9 - index / 100,
  }));

  const merged = mergeOverlappingMatches(matches);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.body, source);
});

test("overlap merging preserves long-line continuations that share a chunk with the next line", () => {
  const longLine = "a".repeat(CHUNK_MAX_BYTES * 2 + 100);
  const source = `${longLine}\ntail`;
  const chunks = chunkTextFile("mixed.txt", [longLine, "tail"]).chunks;
  assert.ok(chunks.some((chunk) => chunk.startLine === 1 && chunk.endLine === 2));
  const matches: SearchMatch[] = chunks.map((chunk, index) => ({
    ...chunk,
    id: index + 1,
    filePath: "mixed.txt",
    rrfScore: 1,
    sources: [],
    relevance: 0.9 - index / 100,
  }));

  const merged = mergeOverlappingMatches(matches);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.body, source);
});
