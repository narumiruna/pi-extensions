import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import { createRpcFixture, type RpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";
import { adoptFixtureRoot } from "./daemon-test-helpers.js";

const name = "pi_sync_debug";
type Message = { role: string; content?: string };
const messages = (request: Record<string, unknown>) => request.messages as Message[];
const tools = (request: Record<string, unknown>) => request.tools as { function: { name: string } }[];

for (const debug of [false, true]) {
  describe(`debug tool in real Pi RPC (debug ${debug ? "on" : "off"})`, () => {
    let fixture: RpcFixture;
    let client: SyncRpc;
    let action: "latest" | "recheck";
    beforeEach(async (context) => {
      action = "recheck";
      fixture = await createRpcFixture(context, path.resolve("packages/pi-sync"), undefined, {
        tools: debug ? "" : `read,edit,${name}`,
        callTool: (request) =>
          tools(request)?.some((tool) => tool.function.name === name) && messages(request)?.at(-1)?.role === "user"
            ? { name, arguments: { action } }
            : undefined,
      });
      await fixture.prepare(async () => {
        const file = path.join(fixture.agent, "pi-sync.json");
        const settings = JSON.parse(await fs.readFile(file, "utf8"));
        await fs.writeFile(file, JSON.stringify({ ...settings, debug }));
        client = await fixture.connect();
        await client.start();
      });
    });

    async function prompt(accept: boolean) {
      const confirmations: { title: unknown; connectionRequests: number }[] = [];
      const unsubscribe = client.onRecord((entry) => {
        if (entry.type !== "extension_ui_request" || entry.method !== "confirm") return;
        confirmations.push({ title: entry.title, connectionRequests: fixture.storage.requests.length });
        client.child.stdin?.write(
          `${JSON.stringify({ type: "extension_ui_response", id: entry.id, confirmed: accept })}\n`,
        );
      });
      try {
        await client.prompt("Inspect sync health.");
      } finally {
        unsubscribe();
      }
      const sent = fixture.requests.at(-1);
      const text = sent && messages(sent).findLast(({ role }) => role === "tool")?.content;
      try {
        return { confirmations, result: text ? JSON.parse(text) : undefined };
      } catch {
        return { confirmations, result: text };
      }
    }

    if (!debug) {
      test("the configured tools stay in order and the debug tool does not reach the model", async () => {
        assert.deepEqual(await prompt(true), { confirmations: [], result: undefined });
        assert.deepEqual(
          tools(fixture.requests[0]).map((tool) => tool.function.name),
          ["read", "edit"],
        );
        assert.equal(fixture.storage.requests.length, 0);
      });
    } else {
      test("decline performs no remote read or diagnostic check", async () => {
        const { confirmations, result } = await prompt(false);
        assert.deepEqual(
          confirmations,
          [{ title: "Recheck Pi Sync?", connectionRequests: 0 }],
          JSON.stringify({
            tools: fixture.requests.map(tools),
            ui: client.records.filter(
              (entry) => entry.type === "extension_ui_request" || entry.type === "tool_execution_end",
            ),
            result,
          }),
        );
        assert.deepEqual(result, { kind: "declined" });
        assert.equal(fixture.storage.requests.length, 0);
      });

      test("user confirmation authorizes only reads and latest returns the private log summary", async () => {
        const { confirmations, result } = await prompt(true);
        assert.deepEqual(confirmations, [{ title: "Recheck Pi Sync?", connectionRequests: 0 }]);
        const summary = {
          outcome: "checked",
          baseline: false,
          localChanged: true,
          remoteChanged: false,
          remoteSnapshot: false,
          localFiles: 1,
          selection: "unavailable",
        };
        assert.equal(result?.kind, "fresh");
        assert.deepEqual(result?.summary, summary);
        const methods = fixture.storage.requests.map(({ method }) => method);
        assert.ok(methods.length > 0 && methods.every((method) => method === "GET" || method === "PROPFIND"));
        const log = path.join(fixture.agent, "pi-sync.log");
        const observed = await vi.waitFor(async () => {
          const contents = await fs.readFile(log, "utf8");
          const entries = contents
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const entry = entries.find((entry) => entry.event === "check" && entry.origin === "recheck");
          assert.ok(entry?.operationId);
          assert.ok(
            entries.some(
              (job) => job.event === "job" && job.operation === "inspect" && job.operationId === entry.operationId,
            ),
          );
          assert.doesNotMatch(contents, /AGENTS\.md|127\.0\.0\.1|Test-owned parent instructions/u);
          return entry;
        });
        action = "latest";
        const history = await prompt(true);
        assert.deepEqual(history.confirmations, []);
        assert.deepEqual(history.result, {
          kind: "historical",
          origin: "recheck",
          time: observed.time,
          operationId: observed.operationId,
          summary,
        });
        assert.equal(fixture.storage.requests.length, methods.length);
        const initial = fixture.requests[0];
        assert.equal(tools(initial).at(-1)?.function.name, name);
        for (const request of fixture.requests) {
          assert.deepEqual(tools(request), tools(initial));
          assert.deepEqual(
            messages(request).filter(({ role }) => role === "system"),
            messages(initial).filter(({ role }) => role === "system"),
          );
        }
      });

      test("remote denial becomes a fixed failure category in both the tool result and the log", async () => {
        fixture.storage.options.deny = true;
        const { confirmations, result } = await prompt(true);
        assert.equal(confirmations.length, 1);
        assert.match(String(result), /recheck failed: permission/u);
        assert.doesNotMatch(String(result), /127\.0\.0\.1|pi-sync\/home|HTTP 403/u);
        await vi.waitFor(async () => {
          const log = await fs.readFile(path.join(fixture.agent, "pi-sync.log"), "utf8");
          const records = log
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
          const check = records.find((event) => event.event === "check" && event.origin === "recheck");
          assert.deepEqual(check?.summary, { outcome: "failed", reason: "permission" });
          assert.doesNotMatch(log, /127\.0\.0\.1|pi-sync\/home|HTTP 403/u);
        });
      });

      test("reloading with Debug mode off removes the tool without reordering other tools", async () => {
        action = "latest";
        assert.deepEqual((await prompt(true)).result, { kind: "no-record" });
        const names = tools(fixture.requests[0]).map((tool) => tool.function.name);
        assert.ok(names.includes(name));
        const from = fixture.requests.length;
        const file = path.join(fixture.agent, "pi-sync.json");
        const settings = JSON.parse(await fs.readFile(file, "utf8"));
        await fs.writeFile(file, JSON.stringify({ ...settings, debug: false }));
        await client.command("/test-sync-reload", () => false);
        await client.prompt("Check that the tools were reloaded.");
        assert.deepEqual(
          tools(fixture.requests[from]).map((tool) => tool.function.name),
          names.filter((tool) => tool !== name),
        );
        assert.equal(fixture.storage.requests.length, 0);
      });
    }
  });
}

describe("existing startup checks with Debug mode", () => {
  let fixture: RpcFixture;
  beforeEach(async (context) => {
    fixture = await createRpcFixture(context, path.resolve("packages/pi-sync"));
    await fixture.prepare(async () => {
      const file = path.join(fixture.agent, "pi-sync.json");
      const settings = JSON.parse(await fs.readFile(file, "utf8"));
      settings.syncSetups.home.sync.automatic = true;
      await fs.writeFile(file, JSON.stringify({ ...settings, debug: true }));
      await fixture.startDaemon();
      await adoptFixtureRoot(fixture.agent);
      const client = await fixture.connect();
      await client.start();
    });
  });

  test("records the existing remote check without an agent call or publication", async () => {
    await vi.waitFor(async () => {
      const log = await fs.readFile(path.join(fixture.agent, "pi-sync.log"), "utf8");
      const checks = log
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === "check");
      assert.equal(checks.length, 1);
      assert.equal(checks[0].origin, "startup");
      assert.equal(checks[0].summary.outcome, "checked");
    });
    assert.deepEqual(
      fixture.storage.requests.map(({ method }) => method),
      ["GET"],
    );
    assert.deepEqual(fixture.requests, []);
  });
});
