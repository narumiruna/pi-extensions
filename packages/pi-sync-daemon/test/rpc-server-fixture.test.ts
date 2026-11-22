import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { runtimePaths } from "../src/identity.js";
import type { ClientFacts } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

test("a client disposal failure still releases the other client and the daemon owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-rpc-cleanup-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const paths = await runtimePaths(root);
  onTestFinished(() => fs.rm(paths.directory, { recursive: true, force: true }));
  const facts = (): ClientFacts => ({
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: paths.root,
    mode: "rpc",
    hasUI: false,
    idle: true,
  });
  const execute = async () => "ready";
  const options = { callback: async () => false };
  const failure = new Error("client dispose failed");
  const disposed: string[] = [];
  await assert.rejects(
    withRpcServer(paths.root, execute, async ({ createConnection, server }) => {
      for (const label of ["first", "second"]) {
        const connection = await createConnection(facts(), options).attach();
        const dispose = connection.dispose.bind(connection);
        vi.spyOn(connection, "dispose").mockImplementationOnce(async () => {
          assert.equal(server.closed, false);
          await dispose();
          disposed.push(label);
          if (label === "second") throw failure;
        });
      }
    }),
    (error) => error === failure,
  );
  assert.deepEqual(disposed, ["second", "first"]);
  await fs.access(paths.owner).then(
    () => assert.fail("the first daemon still owns the root"),
    (error) => assert.equal(error.code, "ENOENT"),
  );
  await withRpcServer(paths.root, execute, async ({ createConnection }) => {
    const replacement = await createConnection(facts(), options).attach();
    assert.equal(await replacement.run("probe", {}), "ready");
  });
});
