import assert from "node:assert/strict";
import { test } from "vitest";
import { navigateRexPane, paneChoice } from "../src/rex-navigation.js";
import { blockId, pane, sessionId, windowId } from "./fixtures.js";
import { clientId, navigationFixture, otherClient } from "./navigation-fixture.js";

test("focuses and selects the exact session/window in one explicit app without prompting", async () => {
  const f = navigationFixture();
  await f.navigate();
  assert.deepEqual(f.mutations, [
    ["focus", "-s", sessionId, blockId],
    ["-C", clientId, "do", "session.select", `session_id=${sessionId}`, `window_id=${windowId}`],
  ]);
  assert.equal(f.select.mock.calls.length, 0);
  assert.equal(f.queries.filter((args) => args[0] === "client").length, 3);
  assert.equal(f.queries.filter((args) => args.at(-1) === "program_status").length, 2);
});

test("multiple apps require an explicit sanitized choice and preserve its full ID", async () => {
  const f = navigationFixture();
  f.model.clients.push(f.connected(otherClient, "\x1b[31mOther\x1b[0m\nApp"));
  f.select.mockImplementation(async (_title, labels) => labels[1]);
  await f.navigate();
  const labels = f.select.mock.calls[0]?.[1];
  assert.ok(labels?.[1]?.includes("Other App"));
  assert.ok(!labels?.[1]?.includes("\x1b"));
  assert.equal(f.mutations[1]?.[1], otherClient);
  assert.equal(f.select.mock.calls[0]?.[2]?.signal, f.controller.signal);
});

test.each([undefined, "not-an-offered-choice"])(
  "cancelled or invalid app selection never changes focus",
  async (choice) => {
    const f = navigationFixture();
    f.model.clients.push(f.connected(otherClient));
    f.select.mockResolvedValue(choice);
    if (choice === undefined) await f.navigate();
    else await assert.rejects(f.navigate(), /Invalid Rex app/u);
    assert.deepEqual(f.mutations, []);
  },
);

test.each([
  { clients: [] },
  { clients: [{ client_id: clientId, connection_state: "disconnected", info: { kind: "app" } }] },
  { clients: [{ client_id: clientId, connection_state: "connected", info: { kind: "cli" } }] },
  { clients: [{ client_id: clientId, connection_state: "connected" }] },
])("does not substitute a CLI, unknown, or disconnected client", async ({ clients }) => {
  const f = navigationFixture();
  f.model.clients = clients;
  await assert.rejects(f.navigate(), /No connected Rex app/u);
  assert.deepEqual(f.mutations, []);
});

test("duplicate or incomplete app IDs fail closed", async () => {
  for (const clients of [
    [{ client_id: "app", connection_state: "connected", info: { kind: "app" } }],
    [{ client_id: clientId.replace("client:", "Client:"), connection_state: "connected", info: { kind: "app" } }],
    [navigationFixture().connected(clientId), navigationFixture().connected(clientId)],
  ]) {
    const f = navigationFixture();
    f.model.clients = clients;
    await assert.rejects(f.navigate());
    assert.deepEqual(f.mutations, []);
  }
});

test.each([
  { actions: [] },
  { actions: [{ name: "session.select", args: { type: "object", properties: { session_id: { type: "string" } } } }] },
  {
    actions: [
      {
        name: "session.select",
        args: {
          type: "object",
          properties: { session_id: { type: "string" }, window_id: { type: "string" } },
          required: ["secret"],
        },
      },
    ],
  },
  {
    actions: [
      {
        name: "session.select",
        args: { type: "object", properties: { session_id: { type: "number" }, window_id: { type: "string" } } },
      },
    ],
  },
])("checks session.select schema before any focus mutation", async (actions) => {
  const f = navigationFixture();
  f.model.actions = actions;
  await assert.rejects(f.navigate());
  assert.deepEqual(f.mutations, []);
});

test.each([
  "session",
  "block",
  "window",
  "detached",
  "nonterminal",
  "missing",
  "duplicate",
  "gone-pi",
  "unknown-status",
])("rejects stale target class: %s", async (kind) => {
  const f = navigationFixture();
  const block = f.fixture.blocks[0];
  assert.ok(block);
  if (kind === "session") f.model.inspected.session_id = "other";
  if (kind === "block") block.block_id = "block:00000000-0000-0000-0000-000000000099";
  if (kind === "window") block.window_id = "window:00000000-0000-0000-0000-000000000099";
  if (kind === "detached") block.placement = "detached";
  if (kind === "nonterminal") block.creator_name = "other";
  if (kind === "missing") f.fixture.view.windows = [];
  if (kind === "duplicate") {
    const window = f.fixture.view.windows[0];
    assert.ok(window);
    f.fixture.view.windows.push(window);
  }
  if (kind === "gone-pi") {
    f.fixture.status[blockId] = { records: [] };
    f.fixture.process[blockId] = { foreground: { argv0: "codex" } };
  }
  if (kind === "unknown-status") f.fixture.status[blockId] = new Error("status unavailable");
  await assert.rejects(f.navigate());
  assert.deepEqual(f.mutations, []);
});

test.each(["sessionId", "windowId", "blockId"] as const)("rejects a non-exact %s before querying Rex", async (key) => {
  for (const value of ["name-or-suffix", pane[key].replace(/^[a-z]/u, (letter) => letter.toUpperCase())]) {
    const f = navigationFixture();
    await assert.rejects(navigateRexPane(f.query, f.run, { ...pane, [key]: value }, f.select, f.controller.signal));
    assert.deepEqual(f.queries, []);
  }
});

test("foreground-only Pi and retained Done reports remain valid targets", async () => {
  for (const reported of [false, true]) {
    const f = navigationFixture();
    f.fixture.status[blockId] = { records: reported ? [{ app: "pi", state: "done" }] : [] };
    if (reported) f.fixture.process[blockId] = { foreground: { name: "fish" } };
    await f.navigate();
    assert.equal(f.mutations.length, 2);
  }
});

test("a disconnected selected app is never replaced, before or after focus", async () => {
  for (const afterFocus of [false, true]) {
    const f = navigationFixture();
    const original = f.query.getMockImplementation();
    let reads = 0;
    f.query.mockImplementation(async (args, signal) => {
      if (args[0] === "client" && ++reads === (afterFocus ? 3 : 2)) f.model.clients = [f.connected(otherClient)];
      return original?.(args, signal);
    });
    await assert.rejects(f.navigate(), /disconnected/u);
    assert.equal(f.mutations.length, afterFocus ? 1 : 0);
  }
});

test.each(["focus", "selection", "post-focus-target", "post-focus-location"])(
  "partial failure %s has no automatic mutation retry",
  async (kind) => {
    const f = navigationFixture();
    const original = f.run.getMockImplementation();
    f.run.mockImplementation(async (args, signal) => {
      await original?.(args, signal);
      if (kind === "post-focus-target") {
        f.fixture.status[blockId] = { records: [] };
        f.fixture.process[blockId] = {};
      }
      if (kind === "post-focus-location") f.model.focused = false;
      if ((kind === "focus" && args[0] === "focus") || (kind === "selection" && args[0] === "-C"))
        throw new Error("request timed out");
      return "";
    });
    await assert.rejects(f.navigate(), /focus may have changed.*No automatic retry/u);
    assert.equal(f.mutations.length, kind === "selection" ? 2 : 1);
  },
);

test("cancellation at every query boundary prevents the next mutation", async () => {
  const successful = navigationFixture();
  await successful.navigate();
  for (let cancelAt = 1; cancelAt <= successful.queries.length; cancelAt++) {
    const f = navigationFixture();
    const original = f.query.getMockImplementation();
    let reads = 0;
    f.query.mockImplementation(async (args, signal) => {
      const value = await original?.(args, signal);
      if (++reads === cancelAt) f.controller.abort();
      return value;
    });
    await assert.rejects(f.navigate(), { name: "AbortError" });
    assert.ok(f.mutations.length <= 1);
    assert.ok(!f.mutations.some((args) => args[0] === "-C"));
  }
});

test("cancelling during app selection leaves focus unchanged", async () => {
  const f = navigationFixture();
  f.model.clients.push(f.connected(otherClient));
  f.select.mockImplementation(async (_title, labels) => {
    f.controller.abort();
    return labels[0];
  });
  await assert.rejects(f.navigate(), { name: "AbortError" });
  assert.deepEqual(f.mutations, []);
});

test("picker labels sanitize untrusted paths and preserve raw exact IDs", () => {
  const raw = { ...pane, session: "\x1b[31mProject\x1b[0m", cwd: "/safe\u202e\npath" };
  const label = paneChoice(raw, 0);
  assert.ok(!label.includes("\x1b") && !label.includes("\u202e") && !label.includes("\n"));
  assert.equal(raw.sessionId, sessionId);
  assert.ok(raw.cwd.includes("\u202e"));
});
