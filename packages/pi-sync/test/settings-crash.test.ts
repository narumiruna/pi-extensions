import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
  activeLocalConfigPath,
  createLocalConfigDocument,
  legacyLocalConfigPath,
  localConfigPath,
  readActiveLocalConfigDocumentForRepair,
  readMigratingLocalConfigDocument,
} from "../src/settings/config-file.js";
import { readLocalConfigObject, updateLocalConfig } from "../src/settings/settings-store.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

function startCrashChild(agentDir: string, action: "before" | "after" | "read") {
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules/.cache/pi-extensions-test/packages/pi-sync/test/settings-crash-child.js"),
      action,
    ],
    { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const message = new Promise<Record<string, unknown>>((resolve, reject) => {
    let received = false;
    child.once("message", (value) => {
      received = true;
      resolve(value as Record<string, unknown>);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!received) reject(new Error(`Settings child exited before its handshake (${code ?? signal}): ${stderr}`));
    });
  });
  const closed = once(child, "close");
  return { child, message, closed };
}

for (const boundary of ["before", "after"] as const) {
  for (const retainedLegacy of [false, true]) {
    test(`SIGKILL ${boundary} settings publication keeps canonical settings (retained legacy: ${retainedLegacy})`, async (context) => {
      await withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const original = { ...v3S3Settings({ automatic: false }), showStatus: true, future: { keep: true } };
        const originalBytes = Buffer.from(`${JSON.stringify(original)}\n`);
        await fs.writeFile(localConfigPath(), originalBytes, { mode: 0o600 });
        const legacyBytes = Buffer.from(`${JSON.stringify(v3S3Settings({ automatic: true }))}\n`);
        if (retainedLegacy) await fs.writeFile(legacyLocalConfigPath(), legacyBytes, { mode: 0o600 });
        const writer = startCrashChild(agentDir, boundary);
        context.onTestFinished(() => {
          writer.child.kill("SIGKILL");
        });
        try {
          assert.deepEqual(await writer.message, { event: "ready" });
          writer.child.kill("SIGKILL");
          const [, signal] = await writer.closed;
          assert.equal(signal, "SIGKILL");
          const published = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
          assert.equal(published.syncSetups.home.sync.automatic, false);
          assert.equal(published.showStatus, boundary === "before");
          assert.deepEqual(published.future, { keep: true });
          if (boundary === "before") assert.deepEqual(await fs.readFile(localConfigPath()), originalBytes);
          if (process.platform !== "win32") {
            assert.equal((await fs.stat(localConfigPath())).mode & 0o777, 0o600);
          }
          if (retainedLegacy) assert.deepEqual(await fs.readFile(legacyLocalConfigPath()), legacyBytes);
          // Expire the abandoned lock without waiting for the production stale interval.
          await fs.utimes(`${localConfigPath()}.mutation-lock`, new Date(0), new Date(0));
          const reader = startCrashChild(agentDir, "read");
          context.onTestFinished(() => {
            reader.child.kill("SIGKILL");
          });
          try {
            assert.deepEqual(await reader.message, {
              event: "read",
              automatic: false,
              showStatus: boundary === "before",
              future: { keep: true },
              checkedAutomatic: false,
              checkedShowStatus: boundary === "before",
            });
            const [code] = await reader.closed;
            assert.equal(code, 0);
          } finally {
            reader.child.kill("SIGKILL");
            await reader.closed;
          }
        } finally {
          writer.child.kill("SIGKILL");
          await writer.closed;
        }
      });
    });
  }
}

for (const suffix of ["schema-migration-source", "migration-retired"]) {
  for (const retainedLegacy of [false, true]) {
    test(`an old ${suffix} canonical gap fails closed (retained legacy: ${retainedLegacy})`, async () => {
      await withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const recoveryPath = path.join(agentDir, `.pi-sync.json.interrupted.${suffix}`);
        const recoveryBytes = Buffer.from(`${JSON.stringify(v3S3Settings({ automatic: false }))}\n`);
        await fs.writeFile(recoveryPath, recoveryBytes, { mode: 0o600 });
        const legacyBytes = Buffer.from(`${JSON.stringify(v3S3Settings({ automatic: true }))}\n`);
        if (retainedLegacy) await fs.writeFile(legacyLocalConfigPath(), legacyBytes, { mode: 0o600 });
        for (const read of [
          readLocalConfigObject,
          activeLocalConfigPath,
          readActiveLocalConfigDocumentForRepair,
          () => readMigratingLocalConfigDocument(validateSettingsDocument),
        ]) {
          await assert.rejects(read(), /Interrupted pi-sync settings replacement/u);
        }
        await assert.rejects(
          updateLocalConfig(() => v3S3Settings() as PiSyncSettingsV3),
          /Interrupted pi-sync settings replacement/u,
        );
        await assert.rejects(createLocalConfigDocument(v3S3Settings()), /Interrupted pi-sync settings replacement/u);
        await assert.rejects(fs.access(localConfigPath()), { code: "ENOENT" });
        assert.deepEqual(await fs.readFile(recoveryPath), recoveryBytes);
        if (retainedLegacy) assert.deepEqual(await fs.readFile(legacyLocalConfigPath()), legacyBytes);
        assert.equal(
          (await fs.readdir(agentDir)).some((name) => name.endsWith(".mutation-lock")),
          false,
        );
        // Explicit recovery makes subsequent requests usable; failed reads did not poison the queue.
        await fs.rename(recoveryPath, localConfigPath());
        assert.equal((await readLocalConfigObject())?.syncSetups.home?.sync.automatic, false);
      });
    });
  }
}
