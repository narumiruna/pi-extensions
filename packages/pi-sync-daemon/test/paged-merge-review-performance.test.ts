import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { requestDaemon } from "../src/client.js";
import { runtimePaths } from "../src/identity.js";
import { createPagedReviewOffer, presentPagedReview, reviewScope } from "../src/paged-review.js";
import {
  type Callback,
  type ClientFacts,
  operationPrefix,
  type PollReply,
  REVIEW_PAGE_CHARS,
  type Request,
} from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

const content = `${" ".repeat(REVIEW_PAGE_CHARS - 1)}😀\n\t${"   exact \t\n".repeat(9_000)}\ud800`;
const request = {
  title: "Exact review",
  confirmationLabel: "apply reviewed changes",
  summaryLines: ["Local: 3 files", "x".repeat(1_000), ...Array<string>(300).fill("long summary")],
  content,
};
const pages = Math.ceil(content.length / REVIEW_PAGE_CHARS);

function facts(root: string): ClientFacts {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    mode: "rpc",
    hasUI: true,
    idle: true,
  };
}

async function temporaryRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-paged-merge-review-")));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const paths = await runtimePaths(root);
  onTestFinished(() => fs.rm(paths.directory, { recursive: true, force: true }));
  return root;
}

function observeReviewPageRequests(root: string) {
  const requests: unknown[] = [];
  const diagnostics = channel("http.server.request.start");
  const onRequest = (entry: unknown) => {
    const { request: incoming } = entry as { request: IncomingMessage };
    const parts: Uint8Array[] = [];
    incoming.on("data", (chunk) => parts.push(chunk));
    incoming.once("end", () => {
      const message = JSON.parse(Buffer.concat(parts).toString("utf8")) as Request;
      if (message.root === root && message.method === "review-page") requests.push(message.params);
    });
  };
  diagnostics.subscribe(onRequest);
  onTestFinished(() => diagnostics.unsubscribe(onRequest));
  return requests;
}

for (const decision of ["cancel", "approve", "unverified approval", "legacy"] as const) {
  test(`real IPC paged review: ${decision}`, async () => {
    const root = await temporaryRoot();
    const requested = observeReviewPageRequests(root);
    const peer = facts(root);
    let summary: unknown;
    let exact: string | undefined;
    let reference: Callback["review"];
    let received = 0;
    await withRpcServer(
      root,
      async (_operation, _payload, execution) => execution.request("merge-review", request),
      async ({ createConnection }) => {
        const connection = await createConnection(peer, {
          callback: async (callback) => {
            received++;
            exact = (callback.payload as { content: string }).content;
            return decision === "legacy";
          },
          mergeReview:
            decision === "legacy"
              ? undefined
              : async (callback, loadDetails) => {
                  received++;
                  summary = callback.payload;
                  reference = callback.review;
                  if (decision === "approve") exact = await loadDetails();
                  return decision !== "cancel";
                },
        }).attach();
        if (decision === "unverified approval") {
          await assert.rejects(connection.run("review", {}), /callback cancelled or failed/u);
        } else {
          assert.equal(await connection.run("review", {}), decision !== "cancel");
        }
      },
    );
    assert.equal(received, 1);
    if (decision === "legacy") {
      assert.equal(summary, undefined);
      assert.equal(exact, content);
      assert.equal(requested.length, pages);
    } else {
      const presentation = summary as { content?: unknown; summaryLines: string[] };
      assert.equal(presentation.content, undefined);
      assert.equal(presentation.summaryLines[0], "Local: 3 files");
      assert.ok(presentation.summaryLines.length < request.summaryLines.length);
      assert.ok(presentation.summaryLines.every((line) => line.length <= 240));
      assert.match(reference?.offer ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(exact, decision === "approve" ? content : undefined);
      assert.deepEqual(
        requested.map((params) => (params as { index: number }).index),
        decision === "approve" ? Array.from({ length: pages }, (_, index) => index) : [],
      );
    }
  });
}

test("daemon rejects plain, wrong-generation, foreign, incomplete, mismatched and replayed approvals", async () => {
  const root = await temporaryRoot();
  const peer = facts(root);
  const foreign = facts(root);
  const published = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<unknown>();
  await withRpcServer(
    root,
    async (_operation, _payload, execution) => {
      const requestResult = execution.request("merge-review", request);
      published.resolve();
      const decision = await requestResult;
      completed.resolve(decision);
      return decision;
    },
    async ({ server }) => {
      const call = (method: string, params: unknown) => requestDaemon(server.paths, server.identity, method, params);
      await requestDaemon(server.paths, server.identity, "attach", peer, undefined, { reviewDetails: 1 });
      await call("attach", foreign);
      await call("submit", {
        client: peer.id,
        id: `${operationPrefix(server.identity)}${randomUUID()}`,
        operation: "review",
        payload: {},
      });
      await published.promise;
      const snapshot = (await call("poll", { client: peer.id, cursor: 0 })) as PollReply;
      const callback = snapshot.callbacks[0];
      assert.ok(callback?.review?.offer);
      const { offer } = callback.review;
      const scope = { client: peer.id, generation: peer.generation, id: callback.id };
      const page = { ...scope, offer };
      const value = { approvedReview: offer };
      const answer = (value: unknown) => call("answer", { ...scope, value });
      await assert.rejects(
        call("answer", { ...scope, generation: randomUUID(), value }),
        /stale or foreign callback/iu,
      );
      await assert.rejects(call("answer", { ...scope, client: foreign.id, value }), /stale or foreign callback/iu);
      await assert.rejects(answer(true), /complete current offer/u);
      await assert.rejects(answer(value), /complete current offer/u);
      await assert.rejects(
        call("review-page", { ...page, client: foreign.id, index: 0 }),
        /stale, foreign, or invalid/iu,
      );
      await assert.rejects(
        call("review-page", { ...page, generation: randomUUID(), index: 0 }),
        /stale, foreign, or invalid/iu,
      );
      await assert.rejects(
        call("review-page", { ...page, offer: "0".repeat(64), index: 0 }),
        /stale, foreign, or invalid/iu,
      );
      await assert.rejects(call("review-page", { ...page, index: 1 }), /stale, foreign, or invalid/iu);
      await call("review-page", { ...page, index: 0 });
      await call("review-page", { ...page, index: 0 });
      await assert.rejects(answer(value), /complete current offer/u);
      for (let index = 1; index < pages; index++) await call("review-page", { ...page, index });
      await assert.rejects(answer({ approvedReview: "0".repeat(64) }), /complete current offer/u);
      assert.deepEqual(await answer(value), {});
      assert.equal(await completed.promise, true);
      await assert.rejects(answer(value), /stale or foreign callback/iu);
      await assert.rejects(call("review-page", { ...page, index: 0 }), /stale, foreign, or invalid/iu);
    },
  );
});

function exampleOffer() {
  const callback: Callback = { id: randomUUID(), job: randomUUID(), kind: "merge-review", payload: undefined };
  const scope = reviewScope({ instance: randomUUID() }, facts("/"), callback);
  const offered = createPagedReviewOffer(scope, request, content, Buffer.byteLength(content));
  assert.ok(offered);
  return { scope, offered, callback: { ...callback, payload: offered.summary, review: offered.reference } };
}

test("summary, label, body metadata and every review scope field are committed", async () => {
  const { scope, callback, offered } = exampleOffer();
  for (const key of ["instance", "client", "generation", "id", "job"] as const) {
    await assert.rejects(
      presentPagedReview(
        { ...scope, [key]: randomUUID() },
        callback,
        new AbortController().signal,
        async () => true,
        async () => undefined,
      ),
      /offer changed/u,
    );
  }
  for (const payload of [
    { ...offered.summary, title: "Wrong title" },
    { ...offered.summary, confirmationLabel: "Wrong action" },
    { ...offered.summary, summaryLines: ["Wrong summary"] },
  ]) {
    await assert.rejects(
      presentPagedReview(
        scope,
        { ...callback, payload },
        new AbortController().signal,
        async () => true,
        async () => undefined,
      ),
      /offer changed/u,
    );
  }
  const tampered = { ...callback, review: { ...offered.reference, bytes: offered.reference.bytes + 1 } };
  await assert.rejects(
    presentPagedReview(
      scope,
      tampered,
      new AbortController().signal,
      async () => true,
      async () => undefined,
    ),
    /offer changed/u,
  );
});

for (const corruption of [
  "foreign callback",
  "wrong index",
  "wrong offer",
  "truncated",
  "same-length final code unit",
] as const) {
  test(`client refuses a corrupt page: ${corruption}`, async () => {
    const { scope, callback, offered } = exampleOffer();
    await assert.rejects(
      presentPagedReview(
        scope,
        callback,
        new AbortController().signal,
        async (_callback, load) => {
          await load();
          return true;
        },
        async (params) => {
          const page = offered.page(params);
          switch (corruption) {
            case "foreign callback":
              return { ...page, id: randomUUID() };
            case "wrong index":
              return { ...page, index: page.index + 1 };
            case "wrong offer":
              return { ...page, offer: "0".repeat(64) };
            case "truncated":
              return { ...page, content: page.content.slice(1) };
            case "same-length final code unit":
              return page.index === pages - 1 ? { ...page, content: `${page.content.slice(0, -1)}\ufffd` } : page;
          }
        },
      ),
      /invalid exact-review page|contents changed/iu,
    );
  });
}

test("presenter dismissal cancels and drains a detached page task", async () => {
  const { scope, callback } = exampleOffer();
  let aborted = false;
  let reads = 0;
  const started = Promise.withResolvers<void>();
  const result = await presentPagedReview(
    scope,
    callback,
    new AbortController().signal,
    async (_callback, load) => {
      void load();
      await started.promise;
      return false;
    },
    (_params, signal) => {
      reads++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
        started.resolve();
      });
    },
  );
  assert.equal(result, false);
  assert.equal(aborted, true);
  assert.equal(reads, 1);
});
