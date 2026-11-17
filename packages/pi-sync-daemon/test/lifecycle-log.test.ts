import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openLifecycleLog } from "../src/lifecycle-log.js";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-log-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
test("private lifecycle history remains bounded and closes idempotently", () =>
  fixture(async (directory) => {
    const log = openLifecycleLog(directory);
    try {
      for (let i = 0; i < 1000; i++) log.write("ready");
    } finally {
      log.close();
      log.close();
    }
    const target = path.join(directory, "lifecycle.log");
    const bytes = await fs.readFile(target, "utf8");
    assert.ok(Buffer.byteLength(bytes) <= 8192);
    for (const line of bytes.trim().split("\n"))
      assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["phase", "time"]);
    if (process.platform !== "win32") assert.equal((await fs.stat(target)).mode & 0o077, 0);
  }));
test.skipIf(process.platform === "win32")("a replaced log never receives writes or gets removed by cleanup", () =>
  fixture(async (directory) => {
    const log = openLifecycleLog(directory);
    const target = path.join(directory, "lifecycle.log");
    try {
      await fs.rename(target, `${target}.owned`);
      await fs.writeFile(target, "foreign evidence", { mode: 0o600 });
      assert.throws(() => log.write("ready"), /ownership changed/u);
      assert.equal(await fs.readFile(target, "utf8"), "foreign evidence");
    } finally {
      log.close();
    }
  }),
);
test.skipIf(process.platform === "win32")(
  "symlink and non-private log files are refused without rewriting evidence",
  () =>
    fixture(async (directory) => {
      const foreign = path.join(directory, "foreign");
      const target = path.join(directory, "lifecycle.log");
      await fs.writeFile(foreign, "retain");
      await fs.symlink(foreign, target);
      assert.throws(() => openLifecycleLog(directory));
      assert.equal(await fs.readFile(foreign, "utf8"), "retain");
      await fs.unlink(target);
      await fs.writeFile(target, "retain", { mode: 0o644 });
      assert.throws(() => openLifecycleLog(directory), /ownership changed/u);
      assert.equal(await fs.readFile(target, "utf8"), "retain");
    }),
);
