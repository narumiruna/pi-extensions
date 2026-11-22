import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { findDaemon } from "@narumitw/pi-sync-daemon";
import { beforeEach, test, vi } from "vitest";
import { createRpcFixture, type RpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";

let fixture: RpcFixture;
let first: SyncRpc;

beforeEach(async (context) => {
  fixture = await createRpcFixture(context);
  await fixture.startDaemon();
  await adoptFixtureRoot(fixture.agent);
  first = await fixture.connect();
  await first.start();
});

test("a second real Pi finishes configured startup while an unrelated push review stays open", async () => {
  let settled = false;
  const reviewed = first.call({ type: "prompt", message: "/sync push" }).finally(() => {
    settled = true;
  });
  void reviewed.catch(() => {});
  let callback: string | undefined;
  try {
    callback = await vi.waitFor(() => {
      const record = first.records.find((value) => value.type === "extension_ui_request" && value.method === "confirm");
      assert.equal(typeof record?.id, "string");
      return record?.id;
    });
    assert.equal(settled, false);
    const second = await fixture.connect();
    await second.start();
    assert.equal(settled, false);
    const daemon = await findDaemon(fixture.agent);
    assert.ok(daemon);
    const persisted = JSON.parse(await fs.readFile(path.join(daemon.paths.directory, "clients.json"), "utf8")) as {
      clients: { pid: number; ready?: boolean }[];
    };
    assert.equal(persisted.clients.find((peer) => peer.pid === second.child.pid)?.ready, true);
    assert.equal(fixture.requests.length, 0);
  } finally {
    if (callback && !settled) {
      first.child.stdin?.write(
        `${JSON.stringify({ type: "extension_ui_response", id: callback, confirmed: false })}\n`,
      );
      await reviewed;
    }
  }
});
