import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { SearchResponse } from "../src/search.js";
import { formatToolResult } from "../src/typesafe-search.js";

async function withEnvironment(fn: (workspace: string, agentDirectory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-jev-tool-"));
  const workspace = path.join(root, "workspace");
  const agentDirectory = path.join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  try {
    await fn(workspace, agentDirectory);
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    await rm(root, { recursive: true, force: true });
  }
}

function installFakeTypeSafeFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      state: { candidates: Array<{ path: string; text: string }> };
      questions: Record<string, unknown>;
    };
    const answers = Object.fromEntries(
      Object.keys(request.questions).map((id, index) => {
        const candidate = request.state.candidates[index];
        const relevant = /authentication|refresh token/iu.test(`${candidate?.path} ${candidate?.text}`);
        return [id, { type: "noul", noul: relevant ? 0.9 : 0.1 }];
      }),
    );
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 20, output_tokens: 2 } }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("extension registers one tool, loads private settings, searches, reports progress, and shuts down", async () => {
  await withEnvironment(async (workspace, agentDirectory) => {
    await writeFile(path.join(agentDirectory, "pi-typesafe-search.json"), JSON.stringify({ apiKey: "test-key" }), {
      mode: 0o600,
    });
    await chmod(path.join(agentDirectory, "pi-typesafe-search.json"), 0o600);
    await mkdir(path.join(workspace, "nested "));
    await writeFile(path.join(workspace, "nested ", "auth.md"), "# Authentication\nRefresh token restores sessions.\n");
    const restoreFetch = installFakeTypeSafeFetch();
    try {
      vi.resetModules();
      const { default: register } = await import("../src/typesafe-search.js");
      const mock = createMockPi();
      register(mock.pi);
      assert.deepEqual(
        mock.tools.map((tool) => tool.name),
        ["jev_search"],
      );
      const tool = mock.tools[0] as {
        execute: (...args: unknown[]) => Promise<{
          content: Array<{ type: string; text: string }>;
          details: { matches: Array<{ path: string }>; requests: number };
        }>;
      };
      const progress: string[] = [];
      const sessionManager = { getSessionId: () => "jev-session", getBranch: () => [], getEntries: () => [] };
      const { ctx } = createMockContext({ cwd: workspace, sessionManager });
      await mock.events.get("session_start")?.[0]?.({}, ctx);

      const result = await tool.execute(
        "call",
        { query: "stay signed in", path: "nested ", alternatives: ["refresh token"], limit: 3 },
        new AbortController().signal,
        (update: { content: Array<{ text: string }> }) => progress.push(update.content[0]?.text ?? ""),
        ctx,
      );
      const text = result.content[0]?.text ?? "";
      assert.match(text, /nested \/auth\.md:1-3/);
      assert.equal(result.details.matches[0]?.path, "nested /auth.md");
      assert.match(text, /Jev 0\.900/);
      assert.ok(result.details.matches.length > 0);
      assert.ok(result.details.requests >= 2);
      assert.ok(progress.some((message) => /Discovering|index|Screening|Reranking/i.test(message)));
      assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
      assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);

      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const replacement = await tool.execute(
        "replacement",
        { query: "refresh token", path: "nested ", limit: 1 },
        undefined,
        undefined,
        ctx,
      );
      assert.match(replacement.content[0]?.text ?? "", /auth\.md/);

      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
      await assert.rejects(
        tool.execute("late", { query: "query", path: "." }, undefined, undefined, ctx),
        /already shut down/,
      );
    } finally {
      restoreFetch();
    }
  });
});

test("session shutdown aborts and settles active Jev work before closing resources", async () => {
  await withEnvironment(async (workspace, agentDirectory) => {
    await writeFile(path.join(agentDirectory, "pi-typesafe-search.json"), JSON.stringify({ apiKey: "test-key" }), {
      mode: 0o600,
    });
    await writeFile(path.join(workspace, "source.md"), "# Session\nRefresh token evidence.\n");
    const originalFetch = globalThis.fetch;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      markStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const requestSignal = init?.signal;
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (requestSignal?.aborted) abort();
        else requestSignal?.addEventListener("abort", abort, { once: true });
      });
    };

    try {
      vi.resetModules();
      const { default: register } = await import("../src/typesafe-search.js");
      const mock = createMockPi();
      register(mock.pi);
      const sessionManager = { getSessionId: () => "active", getBranch: () => [], getEntries: () => [] };
      const { ctx } = createMockContext({ cwd: workspace, sessionManager });
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const tool = mock.tools[0] as { execute: (...args: unknown[]) => Promise<unknown> };
      const search = tool.execute("call", { query: "refresh token", path: "." }, undefined, undefined, ctx);
      await started;
      await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
      await assert.rejects(search, (error: unknown) => error instanceof Error);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("tool results strip terminal controls and bound model text and structured excerpts", () => {
  const response: SearchResponse = {
    matches: Array.from({ length: 20 }, (_, index) => ({
      id: index,
      filePath: `\u001b]8;;https://example.invalid\u0007file-${index}.md\u001b]8;;\u0007\u202ereordered\nforged\tpath`,
      sequence: index,
      startLine: index * 100 + 1,
      endLine: index * 100 + 100,
      heading: "Heading",
      body: `\u001b[31m\u2066${"relevant source line\n".repeat(400)}\u001b[0m`,
      hash: String(index),
      rrfScore: 1,
      lexicalRank: index + 1,
      sources: [{ query: "query\u200f\nforged\tfield", rank: 1, weight: 1, bm25: -1 }],
      relevance: 0.9,
    })),
    index: { indexed: 20, unchanged: 0, removed: 0, skipped: 0 },
    scannedFiles: 20,
    requests: 4,
    inputTokens: 100,
    outputTokens: 20,
    model: "jev-test\u202eforged\nforged\tmodel",
    fileMapsEvaluated: 20,
    candidatesEvaluated: 20,
  };

  const result = formatToolResult(response);
  const text = result.content[0]?.text ?? "";
  assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("\u0007"), false);
  assert.doesNotMatch(text, /\p{Cf}/u);
  assert.equal(result.details.truncated, true);
  assert.doesNotMatch(text, /\nforged/);
  assert.ok(result.details.matches.every((match) => !/[\t\r\n]/u.test(match.path)));
  assert.ok(
    result.details.matches.every((match) => match.retrievalSources.every((source) => !/[\t\r\n]/u.test(source.query))),
  );
  assert.doesNotMatch(result.details.model ?? "", /[\t\r\n\p{Cf}]/u);
  assert.ok(
    result.details.matches.every(
      (match) =>
        !/\p{Cf}/u.test(match.path) &&
        !/\p{Cf}/u.test(match.excerpt) &&
        match.retrievalSources.every((source) => !/\p{Cf}/u.test(source.query)),
    ),
  );
  assert.ok(result.details.matches.every((match) => Buffer.byteLength(match.excerpt, "utf8") <= 2_048));
});

test("missing and invalid settings fail without exposing secrets", async () => {
  await withEnvironment(async (workspace, agentDirectory) => {
    vi.resetModules();
    const { default: register } = await import("../src/typesafe-search.js");
    const missingMock = createMockPi();
    register(missingMock.pi);
    const sessionManager = { getSessionId: () => "missing", getBranch: () => [], getEntries: () => [] };
    const { ctx } = createMockContext({ cwd: workspace, sessionManager });
    await missingMock.events.get("session_start")?.[0]?.({}, ctx);
    const tool = missingMock.tools[0] as { execute: (...args: unknown[]) => Promise<unknown> };
    await assert.rejects(
      tool.execute("call", { query: "query", path: "." }, undefined, undefined, ctx),
      /TypeSafe API key is missing/,
    );

    await writeFile(path.join(agentDirectory, "pi-typesafe-search.json"), "{secret-key", { mode: 0o600 });
    const invalidManager = { getSessionId: () => "invalid", getBranch: () => [], getEntries: () => [] };
    const { ctx: invalidContext, notifications } = createMockContext({
      cwd: workspace,
      sessionManager: invalidManager,
      mode: "tui",
      hasUI: true,
    });
    await missingMock.events.get("session_start")?.[0]?.({}, invalidContext);
    assert.match(notifications[0]?.message ?? "", /settings ignored/);
    assert.doesNotMatch(notifications[0]?.message ?? "", /secret-key/);
  });
});
