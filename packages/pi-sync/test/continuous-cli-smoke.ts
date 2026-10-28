import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createSyncBackend } from "../src/backends/backend-factory.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readContinuousRecord } from "../src/sync/continuous-record.js";
import { continuousBinding } from "../src/sync/continuous-storage.js";
import { push } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { v3WebDavSettings, withTempHome } from "./helpers.js";
import { mergeOptions } from "./merge-options.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

// Standalone package-directory RPC smoke. It is not a long-running Vitest test.
await withTempHome(async (agentDir) => {
  const server = await new MockWebDavServer().start();
  let child: ReturnType<typeof spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let exited: Promise<number | null> | undefined;
  try {
    await fs.mkdir(agentDir, { recursive: true });
    const settings = v3WebDavSettings({ include: ["AGENTS.md"] });
    settings.storageConnections.dav.url = server.url;
    Object.assign(settings.syncSetups.home.sync, { agentMode: true, continuous: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "base\n");
    await push(agentContext(selectRemote).ctx, mergeOptions);
    const packagePath = path.resolve("packages/pi-sync");
    child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--offline",
        "-e",
        packagePath,
      ],
      {
        cwd: agentDir,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const cli = child;
    exited = new Promise((resolve) => cli.once("close", (code) => resolve(code)));
    let stderr = "";
    cli.stderr?.on("data", (value) => {
      stderr += value;
    });
    let buffer = "";
    let ready = false;
    const synced = new Promise<void>((resolve, reject) => {
      cli.once("error", reject);
      cli.once("exit", (code) => {
        if (!ready || code !== 0) reject(new Error(`RPC smoke exit ${code}: ${stderr}`));
      });
      cli.stdout?.setEncoding("utf8");
      cli.stdout?.on("data", (value) => {
        buffer += value;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (record.type === "response" && record.id === "ready") {
              assert.equal(record.success, true);
              assert.ok(record.data.commands.some((item: { name: string }) => item.name === "sync"));
              ready = true;
              // Start the operation deadline only after CLI readiness is observed.
              deadline = setTimeout(() => reject(new Error(`Continuous RPC smoke deadline: ${stderr}`)), 20_000);
              void fs.writeFile(path.join(agentDir, "AGENTS.md"), "synthetic continuous edit\n").catch(reject);
            }
            if (record.type === "extension_error") reject(new Error(JSON.stringify(record)));
            if (
              record.type === "extension_ui_request" &&
              record.method === "notify" &&
              String(record.message).includes("No automatic reload.")
            )
              resolve();
          } catch (error) {
            reject(error);
          }
        }
      });
      cli.stdin?.write(`${JSON.stringify({ type: "get_commands", id: "ready" })}\n`);
    });
    await synced;
    cli.stdin?.end();
    assert.equal(await exited, 0, stderr);
    clearTimeout(deadline);
    const config = await loadConfig();
    const backend = await createSyncBackend(config);
    const head = await backend.readHead();
    assert.ok(head);
    const snapshot = await backend.readSnapshot(head.snapshotRef);
    assert.equal(
      Buffer.from(snapshot.files.find((file) => file.path === "AGENTS.md")?.contentBase64 ?? "", "base64").toString(),
      "synthetic continuous edit\n",
    );
    assert.equal((await readContinuousRecord(await continuousBinding(config))).calls.length, 0);
    await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/continuous/scheduler.lock")), /ENOENT/);
    console.log(
      JSON.stringify({
        result: "PASS",
        mode: "rpc",
        entry: "packages/pi-sync",
        continuous: true,
        providerRequests: 0,
        remotePublished: true,
        leaseReleased: true,
      }),
    );
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child?.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(kill);
      }
    }
    await server.close();
  }
});
