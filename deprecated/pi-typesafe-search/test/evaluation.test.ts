import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NoulQuestion, RequestOptions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { test } from "vitest";
import { openSearchDatabase } from "../src/database.js";
import { discoverSearchFiles } from "../src/files.js";
import { refreshIndex } from "../src/indexer.js";
import { JevEvaluator, type SystemOneClient } from "../src/jev-client.js";
import { retrieveLexicalCandidates, selectFileMaps } from "../src/retrieval.js";
import { searchIndexedWorkspace } from "../src/search.js";

interface EvalDocument {
  path: string;
  text: string;
}

interface EvalQuery {
  name: string;
  query: string;
  alternatives: string[];
  relevant: string[];
  originalFts: string[];
  multiQuery: string[];
}

interface EvalFixture {
  documents: EvalDocument[];
  queries: EvalQuery[];
}

class LabeledClient implements SystemOneClient {
  constructor(private readonly queries: readonly EvalQuery[]) {}

  async systemOne(
    request: SystemOneRequest<Record<string, NoulQuestion>>,
    _options?: RequestOptions,
  ): Promise<SystemOneResult<Record<string, NoulQuestion>>> {
    const state = request.state as { query: string; candidates: Array<{ path: string; text: string }> };
    const primaryQuery = state.query.split("\n", 1)[0];
    const fixture = this.queries.find((query) => primaryQuery === query.query);
    assert.ok(fixture, `missing labeled query: ${state.query}`);
    const relevant = new Set(fixture.relevant);
    const answers = Object.fromEntries(
      state.candidates.map((candidate, index) => {
        const filePath = candidate.path.split(":")[0] ?? candidate.path;
        return [`candidate_${index}`, { type: "noul" as const, noul: relevant.has(filePath) ? 0.9 : 0.1 }];
      }),
    );
    return { model: "labeled-fixture", answers, usage: { input_tokens: 1, output_tokens: 1 } };
  }
}

function paths(items: readonly { filePath: string }[]): string[] {
  return [...new Set(items.map((item) => item.filePath))].sort();
}

test("labeled fixture compares original FTS, alternative RRF, file screening, and final reranking", async () => {
  const fixturePath = new URL("./fixtures/retrieval-eval.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as EvalFixture;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-jev-eval-"));
  const workspace = path.join(temporary, "workspace");
  const agentDirectory = path.join(temporary, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);

  try {
    for (const document of fixture.documents) {
      await writeFile(path.join(workspace, document.path), document.text);
    }
    const discovery = await discoverSearchFiles(workspace, ".");
    const database = await openSearchDatabase(workspace, agentDirectory);
    try {
      await refreshIndex(database, discovery);
      const evaluator = new JevEvaluator("fixture-key", new LabeledClient(fixture.queries));

      for (const query of fixture.queries) {
        const original = retrieveLexicalCandidates(database, query.query, []);
        assert.deepEqual(paths(original), [...query.originalFts].sort(), `${query.name}: original FTS`);

        const expanded = retrieveLexicalCandidates(database, query.query, query.alternatives);
        assert.deepEqual(paths(expanded), [...query.multiQuery].sort(), `${query.name}: multi-query RRF`);

        const maps = selectFileMaps(database, expanded);
        const fileScores = await evaluator.evaluate(
          query.query,
          maps.map((file) => ({ id: file.path, path: file.path, text: file.outline })),
          "file",
        );
        for (const relevantPath of query.relevant) {
          assert.equal(fileScores.scores.get(relevantPath), 0.9, `${query.name}: file screening`);
        }

        const result = await searchIndexedWorkspace({
          database,
          discovery: await discoverSearchFiles(workspace, "."),
          evaluator,
          request: { query: query.query, alternatives: query.alternatives, limit: 20 },
        });
        assert.deepEqual(paths(result.matches), [...query.relevant].sort(), `${query.name}: final reranking`);
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
