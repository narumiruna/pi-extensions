import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { findDaemon } from "@narumitw/pi-sync-daemon";
import { beforeEach, test } from "vitest";
import { createRpcFixture, type RpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";

let fixture: RpcFixture;
let first: SyncRpc;
let review: Awaited<ReturnType<typeof openPushReview>>;

beforeEach(async (context) => {
  fixture = await createRpcFixture(context);
  await fixture.startDaemon();
  await adoptFixtureRoot(fixture.agent);
  first = await fixture.connect();
  await first.start();
  review = await openPushReview(first);
});

async function openPushReview(client: SyncRpc) {
  const opened = Promise.withResolvers<string>();
  const unsubscribe = client.onRecord((record) => {
    if (record.type === "extension_error") {
      opened.reject(new Error(`Extension error before push review: ${record.error}`));
    } else if (record.type === "extension_ui_request") {
      if (record.method === "notify" && record.notifyType === "error") {
        // Pi can report disposition "handled" even when a sync job failed.
        opened.reject(new Error(`Push failed before review: ${record.message}`));
      } else if (record.method === "confirm") {
        if (record.title === "Push pi settings?" && typeof record.id === "string") opened.resolve(record.id);
        else opened.reject(new Error(`Unexpected confirmation: ${JSON.stringify(record)}`));
      }
    }
  });
  let settled = false;
  // The test holds the command open across another Pi startup; fixture teardown owns cancellation.
  const completed = client.call({ type: "prompt", message: "/sync push" }, { deadline: false }).finally(() => {
    settled = true;
  });
  try {
    const id = await Promise.race([
      opened.promise,
      completed.then(({ disposition }) => {
        throw new Error(`Push finished before opening a review (disposition: ${disposition}).`);
      }),
    ]);
    return { id, settled: () => settled, completed };
  } finally {
    unsubscribe();
  }
}

test("a second real Pi finishes configured startup while an unrelated push review stays open", async () => {
  assert.equal(review.settled(), false, "The push must still be waiting for review");
  const second = await fixture.connect();
  await second.start();
  const daemon = await findDaemon(fixture.agent);
  assert.ok(daemon);
  const persisted = JSON.parse(await fs.readFile(path.join(daemon.paths.directory, "clients.json"), "utf8")) as {
    clients: { pid: number; ready?: boolean }[];
  };
  assert.equal(persisted.clients.find((peer) => peer.pid === second.child.pid)?.ready, true);
  assert.equal(review.settled(), false, "The second Pi must become ready before the push review is answered");
  first.child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: review.id, confirmed: false })}\n`);
  assert.equal((await review.completed).disposition, "handled");
  assert.ok(first.records.some(({ method, message }) => method === "notify" && message === "Push cancelled."));
  assert.equal(fixture.requests.length, 0);
});
