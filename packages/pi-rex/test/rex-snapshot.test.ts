import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createRexQuery, piStatus, readRexSnapshot, STATES } from "../src/rex-snapshot.js";
import { blockId, pane, rexFixture, secondBlock, sessionId, windowId } from "./fixtures.js";

const signal = () => new AbortController().signal;

test.each(STATES)("recognizes reported %s and priority independent of order", (state) => {
  assert.equal(piStatus({ records: [{ app: "pi", state }] }), state);
  const pair = [
    { app: "pi", state },
    { app: "pi", state: "idle" },
  ];
  assert.equal(piStatus({ records: pair }), state);
  assert.equal(piStatus({ records: pair.reverse() }), state);
});

test.each([{ records: [{ app: "pi", state: "future" }] }, { records: [{ app: "pi" }] }])(
  "unknown and missing state follow Rex's idle fallback",
  (value) => {
    assert.equal(piStatus(value), "idle");
  },
);

test.each([
  { records: [], expected: undefined },
  { records: [{ app: "claude-code", state: "blocked" }], expected: undefined },
  { records: [{ app: "Pi", state: "working" }], expected: undefined },
  { records: [{ app: "pi", state: "clear" }], expected: undefined },
  { records: [{ app: "pi", effective_app: "codex", state: "blocked" }], expected: undefined },
  { records: [{ app: "codex", effective_app: "pi", state: "blocked" }], expected: "blocked" },
  {
    records: [
      { app: "pi", state: "idle" },
      { id: "task/sub", state: "blocked" },
    ],
    expected: "blocked",
  },
  {
    records: [
      { id: "task", app: "pi", state: "idle" },
      { id: "task/sub", state: "error" },
    ],
    expected: "error",
  },
  {
    records: [
      { app: "pi", state: "idle" },
      { id: "task", app: "other", state: "idle" },
      { id: "task/sub", state: "blocked" },
    ],
    expected: "idle",
  },
  {
    records: [
      { app: "pi", state: "idle" },
      { app: "other", state: "idle" },
      { id: "task", state: "blocked" },
    ],
    expected: "idle",
  },
  {
    records: [
      { app: "pi", state: "idle" },
      { id: "a".repeat(129), state: "blocked" },
    ],
    expected: "idle",
  },
])("aggregates identity and inheritance: %j", ({ records, expected }) => {
  assert.equal(piStatus({ records }), expected);
});

test.each([null, {}, { records: {} }, { records: [null] }, { records: Array(257).fill({ app: "pi" }) }])(
  "rejects malformed or oversized status responses",
  (value) => assert.throws(() => piStatus(value)),
);

test("discovers only Pi panes with exact read-only locations and cwd", async () => {
  const fixture = rexFixture();
  assert.deepEqual(await readRexSnapshot(fixture.query, signal()), { entries: [pane], warnings: [] });
  assert.deepEqual(fixture.calls, [
    ["ls", "--json"],
    ["block", "ls", "-s", sessionId, "--json"],
    ["session", "inspect", sessionId, "--json"],
    ...[blockId, secondBlock].flatMap((id) =>
      ["program_status", "process"].map((method) => ["block", "call", "-s", sessionId, "-b", id, method]),
    ),
  ]);
});

test.each(["script", "argv0", "name"])(
  "recognizes foreground-only Pi from %s without inventing a report",
  async (key) => {
    const fixture = rexFixture();
    fixture.status[blockId] = { records: [] };
    fixture.process[blockId] = { foreground: { [key]: "/usr/bin/pi", cwd: pane.cwd }, home: pane.home };
    const snapshot = await readRexSnapshot(fixture.query, signal());
    assert.deepEqual(snapshot.entries, [{ ...pane, state: "idle", reported: false }]);
  },
);

test.each(["node", "python", "not-pi", "pi.js"])("does not infer Pi from %s", async (name) => {
  const fixture = rexFixture();
  fixture.status[blockId] = { records: [] };
  fixture.process[blockId] = { foreground: { name } };
  assert.deepEqual((await readRexSnapshot(fixture.query, signal())).entries, []);
});

test("keeps terminal discovery order and aggregates child reports into one pane", async () => {
  const fixture = rexFixture();
  fixture.status[blockId] = {
    records: [
      { app: "pi", state: "idle" },
      { id: "worker", state: "blocked" },
    ],
  };
  fixture.status[secondBlock] = { records: [{ app: "pi", state: "error" }] };
  fixture.blocks.reverse();
  const snapshot = await readRexSnapshot(fixture.query, signal());
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.blockId, entry.state]),
    [
      [secondBlock, "error"],
      [blockId, "blocked"],
    ],
  );
});

test("keeps retained reports after exit without using the shell's cwd", async () => {
  const fixture = rexFixture();
  fixture.status[blockId] = { records: [{ app: "pi", state: "done" }] };
  fixture.process[blockId] = { foreground: { name: "fish", cwd: "/wrong" }, last_exit: { exit_code: 0 } };
  const entry = (await readRexSnapshot(fixture.query, signal())).entries[0];
  assert.equal(entry?.state, "done");
  assert.equal(entry?.cwd, undefined);
  assert.equal(entry?.reported, true);
});

test.each(["relative/path", "/bad\0path", "x".repeat(5000)])("ignores invalid foreground cwd", async (cwd) => {
  const fixture = rexFixture();
  fixture.process[blockId] = { foreground: { argv0: "pi", cwd } };
  assert.equal((await readRexSnapshot(fixture.query, signal())).entries[0]?.cwd, undefined);
});

test.each(["detached", "moved", "duplicate", "ambiguous", "nonterminal"])("excludes %s panes", async (kind) => {
  const fixture = rexFixture();
  const block = fixture.blocks[0];
  assert.ok(block);
  if (kind === "detached") block.placement = "detached";
  if (kind === "moved") block.window_id = "window:00000000-0000-0000-0000-000000000099";
  if (kind === "duplicate") fixture.blocks.push({ ...block });
  if (kind === "ambiguous") fixture.view.windows[0]?.layers[0]?.blocks.push({ block_id: blockId });
  if (kind === "nonterminal") block.creator_name = "other";
  const snapshot = await readRexSnapshot(fixture.query, signal());
  assert.deepEqual(snapshot.entries, []);
  assert.ok(!fixture.calls.some((args) => args.includes(blockId)));
});

test("failed status is partial, not a false Idle fallback; failed process preserves reported status", async () => {
  const fixture = rexFixture();
  fixture.status[blockId] = new Error("status unavailable");
  let snapshot = await readRexSnapshot(fixture.query, signal());
  assert.deepEqual(snapshot.entries, []);
  assert.match(snapshot.warnings.join(), /status unavailable/u);
  fixture.status[blockId] = { records: [{ app: "pi", state: "working" }] };
  fixture.process[blockId] = new Error("process unavailable");
  snapshot = await readRexSnapshot(fixture.query, signal());
  assert.equal(snapshot.entries[0]?.state, "working");
  assert.equal(snapshot.entries[0]?.cwd, undefined);
  assert.match(snapshot.warnings.join(), /process unavailable/u);
});

test("validates session identity and names generated tabs without interpreting labels", async () => {
  const fixture = rexFixture();
  const window = fixture.view.windows[0];
  assert.ok(window);
  window.label = `Window ${windowId.slice(-8)}`;
  assert.equal((await readRexSnapshot(fixture.query, signal())).entries[0]?.tab, "Tab 1");
  fixture.view.session_id = "session:00000000-0000-0000-0000-000000000099";
  const snapshot = await readRexSnapshot(fixture.query, signal());
  assert.deepEqual(snapshot.entries, []);
  assert.match(snapshot.warnings.join(), /different session/u);
});

test("rejects invalid or duplicate root IDs and propagates cancellation", async () => {
  for (const sessions of [[{ session_id: "project" }], [{ session_id: sessionId }, { session_id: sessionId }]]) {
    const fixture = rexFixture();
    await assert.rejects(
      readRexSnapshot(async (args, s) => (args[0] === "ls" ? { sessions } : fixture.query(args, s)), signal()),
    );
  }
  const controller = new AbortController();
  const fixture = rexFixture();
  await assert.rejects(
    readRexSnapshot(async (args, s) => {
      const value = await fixture.query(args, s);
      if (args.at(-1) === "program_status") controller.abort();
      return value;
    }, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(fixture.calls.at(-1)?.at(-1), "program_status");
});

test("CLI queries disable autostart and use Pi's bounded abort-aware execution", async () => {
  const exec = vi
    .fn<ExtensionAPI["exec"]>()
    .mockResolvedValue({ stdout: '{"sessions":[]}', stderr: "", code: 0, killed: false, truncated: false });
  const query = createRexQuery(exec);
  const abort = signal();
  assert.deepEqual(await query(["ls", "--json"], abort), { sessions: [] });
  assert.deepEqual(exec.mock.calls, [
    [
      "rex",
      ["--autostart=false", "--timeout", "3s", "--color", "never", "ls", "--json"],
      { signal: abort, timeout: 4000, maxBuffer: 1024 * 1024 },
    ],
  ]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(query([], controller.signal), { name: "AbortError" });
  assert.equal(exec.mock.calls.length, 1);
});

test.each([
  { stdout: "{}", truncated: true, killed: true, code: 1, stderr: "", message: /exceeded/u },
  { stdout: "{}", truncated: false, killed: true, code: 0, stderr: "", message: /timed out/u },
  { stdout: "{}", truncated: false, killed: false, code: 1, stderr: "rex missing", message: /rex missing/u },
  { stdout: "invalid", truncated: false, killed: false, code: 0, stderr: "", message: /Invalid JSON/u },
])("CLI query rejects failed or incomplete output", async ({ message, ...result }) => {
  const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(result);
  await assert.rejects(createRexQuery(exec)([], signal()), message);
});
