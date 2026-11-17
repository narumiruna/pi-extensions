import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { daemonPaths, runtimePaths } from "../src/identity.js";

test("the package rename preserves the root owner namespace and endpoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-identity-"));
  try {
    const canonical = await fs.realpath(root);
    const hash = createHash("sha256").update(canonical).digest("hex");
    const user = process.getuid?.() ?? createHash("sha256").update(os.homedir()).digest("hex").slice(0, 12);
    const base = process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : "/tmp";
    const directory = path.join(base, `sync-daemon-${user}`, hash);
    const paths = await runtimePaths(root);
    assert.deepEqual(paths, {
      root: canonical,
      directory,
      identity: path.join(directory, "identity.json"),
      startup: path.join(directory, "startup.lock"),
      owner: path.join(directory, "owner.lock"),
    });
    const instance = randomUUID();
    const nonce = createHash("sha256").update(instance).digest("hex").slice(0, 16);
    const endpointDirectory = path.join(path.dirname(directory), `${hash.slice(0, 16)}-${nonce}`);
    assert.deepEqual(daemonPaths(paths, instance), {
      ...paths,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\sync-daemon-sync-daemon-${user}-${hash.slice(0, 16)}-${nonce}`
          : path.join(endpointDirectory, "api.sock"),
      ...(process.platform === "win32" ? {} : { endpointDirectory }),
    });
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
