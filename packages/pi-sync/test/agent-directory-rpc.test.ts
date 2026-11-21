import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, test } from "vitest";
import { decodeSnapshot } from "../src/snapshot/snapshot-codec.js";
import { createRpcFixture, type RpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";
import { v3WebDavSettings } from "./helpers.js";

let fixture: RpcFixture;
let client: SyncRpc;
beforeEach(async (context) => {
  fixture = await createRpcFixture(context, path.resolve("packages/pi-sync"));
  await fixture.prepare(async () => {
    const settings = v3WebDavSettings();
    settings.storageConnections.dav.url = fixture.storage.url;
    const home = settings.syncSetups.home;
    await fs.writeFile(
      path.join(fixture.agent, "pi-sync.json"),
      JSON.stringify({
        ...settings,
        version: 7,
        syncSetups: {
          home: {
            ...home,
            sync: {
              scope: "agent-directory",
              automatic: false,
              exclude: ["sessions", "bin", "npm", "models.json", "private"],
              reinclude: ["private/shared.md"],
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    await fs.mkdir(path.join(fixture.agent, "private"));
    await Promise.all([
      fs.writeFile(path.join(fixture.agent, "auth.json"), "{}\n", { mode: 0o600 }),
      fs.writeFile(path.join(fixture.agent, "trust.json"), "{}\n", { mode: 0o600 }),
      fs.writeFile(path.join(fixture.agent, "custom.toml"), "name = 'fixture'\n"),
      fs.writeFile(path.join(fixture.agent, "private", "shared.md"), "shared fixture\n"),
      fs.writeFile(path.join(fixture.agent, "private", "local.md"), "local fixture\n"),
    ]);
    await fixture.startDaemon();
    await adoptFixtureRoot(fixture.agent);
    client = await fixture.connect();
    await client.start();
  });
});

test("built Pi Sync in RPC previews and publishes only the effective directory scope", async () => {
  await client.command("/sync files", () => false);
  await client.command("/sync diff", () => false);
  const output = client.records
    .filter((item) => item.method === "notify")
    .map((item) => item.message)
    .join("\n");
  assert.match(output, /agent directory/iu);
  assert.match(output, /private\/shared\.md/u);
  assert.equal(fixture.storage.resources.size, 0);
  await client.command("/sync push --yes", () => false);
  const snapshots = [...fixture.storage.resources].filter(([key]) => key.includes("/snapshots/"));
  assert.equal(snapshots.length, 1, JSON.stringify(client.records.filter((item) => item.method === "notify")));
  const published = await decodeSnapshot(snapshots[0][1]);
  assert.equal(published.version, 5);
  assert.equal(published.selection?.scope, "agent-directory");
  assert.deepEqual(published.files.map((file) => file.path).sort(), [
    "AGENTS.md",
    "custom.toml",
    "private/shared.md",
    "settings.json",
  ]);
  assert.equal(fixture.requests.length, 0);
  await client.close();
});
