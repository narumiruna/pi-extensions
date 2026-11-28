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
const tools = (request: Record<string, unknown>) =>
  request.tools as { function: { name: string; description: string } }[];
const toolText = (request: Record<string, unknown> | undefined) =>
  request && messages(request).findLast(({ role }) => role === "tool")?.content;
const confirmations = (client: SyncRpc) =>
  client.records.filter((entry) => entry.type === "extension_ui_request" && entry.method === "confirm");

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

    async function prompt() {
      await client.prompt("Inspect sync health.");
      assert.deepEqual(confirmations(client), []);
      const text = toolText(fixture.requests.at(-1));
      try {
        return text ? JSON.parse(text) : undefined;
      } catch {
        return text;
      }
    }

    if (!debug) {
      test("the configured tools stay in order and the debug tool does not reach the model", async () => {
        assert.equal(await prompt(), undefined);
        assert.deepEqual(
          tools(fixture.requests[0]).map((tool) => tool.function.name),
          ["read", "edit"],
        );
        assert.equal(fixture.storage.requests.length, 0);
      });
    } else {
      test("recheck reads without prompting and latest returns the private log summary", async () => {
        const result = await prompt();
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
        assert.deepEqual(await prompt(), {
          kind: "historical",
          origin: "recheck",
          time: observed.time,
          operationId: observed.operationId,
          summary,
        });
        assert.equal(fixture.storage.requests.length, methods.length);
        const initial = fixture.requests[0];
        assert.equal(tools(initial).at(-1)?.function.name, name);
        let prefix = messages(initial);
        for (const request of fixture.requests) {
          assert.deepEqual(tools(request), tools(initial));
          assert.deepEqual(
            messages(request).filter(({ role }) => role === "system"),
            messages(initial).filter(({ role }) => role === "system"),
          );
          assert.deepEqual(messages(request).slice(0, prefix.length), prefix);
          prefix = messages(request);
        }
      });

      test("remote denial becomes a fixed failure category in both the tool result and the log", async () => {
        fixture.storage.options.deny = true;
        const result = await prompt();
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
        assert.deepEqual(await prompt(), { kind: "no-record" });
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

test.for([
  { mode: "on", debug: true, allowed: true },
  { mode: "only", debug: true, allowed: true },
  { mode: "only", debug: false, allowed: true },
  { mode: "only", debug: true, allowed: false },
] as const)("codemode $mode with debug=$debug and allowlisted=$allowed", async ({ mode, debug, allowed }, context) => {
  const fixture = await createRpcFixture(context, [path.resolve("packages/pi-sync"), "builtin:codemode"], undefined, {
    tools: ["read", "edit", "codemode", ...(allowed ? [name] : [])].join(","),
    callTool: (request) =>
      tools(request)?.some((tool) => tool.function.name === "codemode") && messages(request)?.at(-1)?.role === "user"
        ? {
            name: "codemode",
            arguments: {
              code: `return "${name}" in tools && ALL_TOOLS.some((tool) => tool.name === "${name}")
  ? await tools.${name}({ action: "recheck" })
  : "not callable";`,
            },
          }
        : undefined,
  });
  const client = await fixture.prepare(async () => {
    const pi = path.join(fixture.agent, "settings.json");
    const sync = path.join(fixture.agent, "pi-sync.json");
    await fs.writeFile(pi, JSON.stringify({ ...JSON.parse(await fs.readFile(pi, "utf8")), codemode: { mode } }));
    await fs.writeFile(sync, JSON.stringify({ ...JSON.parse(await fs.readFile(sync, "utf8")), debug }));
    const client = await fixture.connect();
    await client.start();
    return client;
  });

  await client.prompt("Recheck through codemode.");
  assert.deepEqual(confirmations(client), []);
  const [initial, followup] = fixture.requests;
  assert.ok(initial && followup);
  const expectedNames = mode === "on" ? ["read", "edit", "codemode", name] : ["codemode"];
  assert.deepEqual(
    tools(initial).map((tool) => tool.function.name),
    expectedNames,
  );
  assert.deepEqual(tools(followup), tools(initial));
  assert.deepEqual(messages(followup).slice(0, messages(initial).length), messages(initial));

  const definition = tools(initial).find((tool) => tool.function.name === (mode === "only" ? "codemode" : name));
  const result = toolText(followup) ?? "";
  assert.match(result, /Script completed/u);
  if (debug && allowed) {
    assert.ok(definition?.function.description.includes(mode === "on" ? `tools.${name}` : `### \`${name}\``));
    assert.match(result, /"kind":"fresh"/u);
    assert.doesNotMatch(result, /127\.0\.0\.1|AGENTS\.md|Test-owned parent instructions/u);
    const methods = fixture.storage.requests.map(({ method }) => method);
    assert.ok(methods.length > 0 && methods.every((method) => method === "GET" || method === "PROPFIND"));
  } else {
    assert.ok(!definition?.function.description.includes(name));
    assert.match(result, /not callable/u);
    assert.equal(fixture.storage.requests.length, 0);
  }
});

describe("existing startup checks with Debug mode", () => {
  let fixture: RpcFixture;
  let client: SyncRpc;
  beforeEach(async (context) => {
    fixture = await createRpcFixture(context, path.resolve("packages/pi-sync"));
    await fixture.prepare(async () => {
      const file = path.join(fixture.agent, "pi-sync.json");
      const settings = JSON.parse(await fs.readFile(file, "utf8"));
      settings.syncSetups.home.sync.automatic = true;
      await fs.writeFile(file, JSON.stringify({ ...settings, debug: true }));
      await fixture.startDaemon();
      await adoptFixtureRoot(fixture.agent);
      client = await fixture.connect();
      await client.start();
    });
  });

  test("records the existing remote check without an agent call or publication", async () => {
    const report = await vi.waitUntil(
      () =>
        client.records.find(
          ({ type, method, message }) =>
            type === "extension_ui_request" &&
            method === "notify" &&
            typeof message === "string" &&
            message.startsWith("pi-sync debug: background startup"),
        ),
      { timeout: 4_000, message: "Pi RPC did not report background startup completion" },
    );
    assert.match(String(report.message), /^pi-sync debug: background startup \(completed\)\n/u);
    const log = await fs.readFile(path.join(fixture.agent, "pi-sync.log"), "utf8");
    const checks = log
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].origin, "startup");
    assert.equal(checks[0].summary.outcome, "checked");
    assert.deepEqual(
      fixture.storage.requests.map(({ method }) => method),
      ["GET"],
    );
    assert.deepEqual(fixture.requests, []);
  });
});
