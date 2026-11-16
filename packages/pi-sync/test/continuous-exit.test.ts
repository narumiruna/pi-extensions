import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { test } from "vitest";
import { continuousRoot } from "../src/sync/continuous-storage.js";
import { withTempHome } from "./helpers.js";

for (const replacement of ["inode", "token"] as const)
  test(`native process-exit cleanup preserves a successor ${replacement}`, async () =>
    withTempHome(async (agentDir) => {
      const directory = path.resolve("node_modules/.cache/pi-sync-continuous-exit");
      await fs.mkdir(directory, { recursive: true });
      const output = path.join(directory, `${randomUUID()}.mjs`);
      const binding = "e".repeat(64);
      await build({
        stdin: {
          contents: `import "./packages/pi-sync/test/engine-process-host.js";
            import { acquireContinuousLease } from "./packages/pi-sync/src/sync/continuous-lease.js";
            const lease = await acquireContinuousLease(process.argv[2]);
            if (!lease) throw Error("no lease");
            process.on("message", () => process.exit(0));
            process.send({ ready: true });`,
          resolveDir: process.cwd(),
        },
        outfile: output,
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        logLevel: "silent",
      });
      const child = fork(output, [binding], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr?.on("data", (value) => {
        stderr += value;
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("message", () => resolve());
          child.once("error", reject);
          child.once("exit", (code) => reject(new Error(`child exit ${code}: ${stderr}`)));
        });
        const guard = path.join(continuousRoot(), "scheduler.lock");
        if (replacement === "inode") {
          await fs.rename(guard, `${guard}.old`);
          await fs.mkdir(guard);
        }
        const successor = randomUUID();
        await fs.writeFile(
          path.join(continuousRoot(), "owner.json"),
          JSON.stringify({ version: 1, binding, pid: process.pid, id: successor }),
          { mode: 0o600 },
        );
        child.send("exit");
        assert.equal(await exited, 0, stderr);
        assert.equal((await fs.stat(guard)).isDirectory(), true);
        assert.equal(JSON.parse(await fs.readFile(path.join(continuousRoot(), "owner.json"), "utf8")).id, successor);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await fs.rm(output, { force: true });
      }
    }));
