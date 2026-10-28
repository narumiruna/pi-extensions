import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

interface RecordValue {
  type?: string;
  id?: string;
  method?: string;
  options?: string[];
  message?: string;
  success?: boolean;
  data?: unknown;
}

test("real Pi RPC and Jiti keep all three document-copy callbacks out of protocol flows", async (t) => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "kit-copy-rpc-"));
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-mcp",
      "--no-tools",
      "--offline",
      "-e",
      path.resolve("packages/pi-tui-kit/test/fixtures/document-copy-protocol-smoke.ts"),
    ],
    {
      cwd: agentDir,
      env: {
        PATH: process.env.PATH,
        HOME: agentDir,
        PI_CODING_AGENT_DIR: agentDir,
        SYSTEMROOT: process.env.SYSTEMROOT,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const records: RecordValue[] = [];
  const waiters = new Set<{
    predicate(record: RecordValue): boolean;
    resolve(record: RecordValue): void;
    reject(error: Error): void;
  }>();
  let failure: Error | undefined;
  let buffer = "";
  let stderr = "";
  let dialogs = 0;
  let schemaOpened = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of waiters) waiter.reject(failure);
    waiters.clear();
  };
  const send = (record: unknown) => child.stdin.write(`${JSON.stringify(record)}\n`);
  const waitFor = (predicate: (record: RecordValue) => boolean): Promise<RecordValue> => {
    if (failure) return Promise.reject(failure);
    const found = records.find(predicate);
    return found
      ? Promise.resolve(found)
      : new Promise((resolve, reject) => waiters.add({ predicate, resolve, reject }));
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr = (stderr + data).slice(-4000);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    buffer += data;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/u, "");
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line) as RecordValue;
        records.push(record);
        if (record.type === "extension_ui_request" && record.method === "select") {
          if (++dialogs > 32) throw new Error("Unexpected RPC dialog loop");
          const options = record.options ?? [];
          const value = options.includes("Schema")
            ? schemaOpened
              ? "Done"
              : "Schema"
            : ["Next", "Apply", "Back", "Done"].find((candidate) => options.includes(candidate));
          if (value === "Schema") schemaOpened = true;
          if (!value) throw new Error(`Unexpected choices: ${JSON.stringify(options)}`);
          send({ type: "extension_ui_response", id: record.id, value });
        }
        for (const waiter of waiters) {
          if (waiter.predicate(record)) {
            waiters.delete(waiter);
            waiter.resolve(record);
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  child.once("exit", (code) => fail(new Error(`RPC exited (${code}): ${stderr}`)));
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      clearTimeout(deadline);
      fail(new Error("RPC smoke disposed"));
      child.stdout.removeAllListeners("data");
      child.stdin.end();
      child.kill("SIGTERM");
      await closed;
      await rm(agentDir, { recursive: true, force: true });
    })());
  t.onTestFinished(cleanup);
  try {
    send({ id: "ready", type: "get_state" });
    const ready = await waitFor((record) => record.id === "ready");
    assert.equal(ready.success, true);
    // The operation deadline starts only after the child readiness handshake.
    deadline = setTimeout(() => fail(new Error(`RPC smoke deadline: ${stderr}`)), 2500);
    send({ id: "commands", type: "get_commands" });
    const commands = await waitFor((record) => record.id === "commands");
    assert.equal(commands.success, true);
    assert.match(JSON.stringify(commands.data), /kit-copy-protocol-smoke/u);
    for (const route of ["review", "standalone", "browse"]) {
      send({ id: route, type: "prompt", message: `/kit-copy-protocol-smoke ${route}` });
      const record = await waitFor(
        (item) => item.method === "notify" && Boolean(item.message?.includes(`"route":"${route}"`)),
      );
      const summary = JSON.parse(record.message ?? "{}");
      assert.equal(summary.copies, 0);
      assert.equal(summary.api, 22);
      assert.deepEqual(
        summary.result,
        route === "standalone" ? { kind: "confirmed" } : { kind: "closed", reason: "close" },
      );
      assert.equal(summary.confirmed, route === "review" ? 1 : 0);
      assert.equal((await waitFor((item) => item.id === route)).success, true);
    }
    assert.ok(dialogs >= 9, "real RPC pagination must be exercised");
    assert.ok(!JSON.stringify(records).includes("Fake copy"));
    assert.ok(!JSON.stringify(records).includes("\\u001b]52;"));
    assert.ok(
      records.every((record) => record.type !== "agent_start"),
      "slash commands must not invoke a provider",
    );
    assert.equal(stderr, "");
  } finally {
    await cleanup();
  }
});
