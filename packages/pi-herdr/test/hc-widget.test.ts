import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createHcWidgetSnapshot, type HcTerminal, parseHcTerminal, parseHcTerminals } from "../src/hc-widget.js";
import { HERDR_AGENT_STATUSES, parseHerdrPane } from "../src/herdr-protocol.js";
import {
  createHerdrWidget,
  type HerdrWidgetSnapshot,
  herdrWidgetFingerprint,
  MAX_HERDR_WIDGET_AGENTS,
} from "../src/herdr-widget.js";

function wireTerminal(address = "t2", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address,
    created_ms: 1234,
    argv: ["/trusted/node", "/trusted/pi"],
    cwd: "/work/project",
    state: "live",
    name: null,
    parent: null,
    labels: {},
    status: { app: "pi", state: "idle" },
    reported: true,
    screen: "exact",
    rows: 24,
    cols: 80,
    ...overrides,
  };
}

function terminal(address: string, overrides: Partial<HcTerminal> = {}): HcTerminal {
  const parsed = parseHcTerminal(wireTerminal(address, overrides));
  assert.ok(parsed);
  return parsed;
}

function requiredSnapshot(terminals: readonly HcTerminal[], currentAddress = "t1"): HerdrWidgetSnapshot {
  const snapshot = createHcWidgetSnapshot(terminals, currentAddress);
  assert.ok(snapshot);
  return snapshot;
}

function relations(snapshot: HerdrWidgetSnapshot): Record<string, string | undefined> {
  return Object.fromEntries(snapshot.rows.map((row) => [row.paneId, row.relation]));
}

test("parses public terminal facts without retaining private text or mutating raw payloads", () => {
  const raw = wireTerminal("remote/t2", {
    name: "reviewer",
    parent: "t1",
    labels: { task: "public" },
    status: { app: "pi", state: "blocked", msg: "private prompt", title: "private title", kind: "auth" },
    records: { child: { app: "secret", state: "error", msg: "private record" } },
    foreground: { pid: 42, name: "node", argv: ["/trusted/node"], cwd: "/current/folder" },
    future: { opaque: true },
  });
  const original = structuredClone(raw);
  const parsed = parseHcTerminal(raw);
  assert.ok(parsed);
  assert.equal(parsed.address, "remote/t2");
  assert.equal(parsed.parent, "t1");
  assert.equal(parsed.created_ms, 1234);
  assert.deepEqual(parsed.status, { app: "pi", state: "blocked" });
  assert.equal(Object.hasOwn(parsed, "foreground"), false, "foreground is not widget evidence");
  assert.notEqual(parsed.argv, raw.argv);
  assert.notEqual(parsed.labels, raw.labels);
  assert.doesNotMatch(JSON.stringify(parsed), /private|opaque|kind/u);
  assert.deepEqual(raw, original);
});

test.each([
  ["address type", { address: 7 }],
  ["blank address", { address: " \n\u001b[31m" }],
  ["negative creation", { created_ms: -1 }],
  ["fractional creation", { created_ms: 1.5 }],
  ["unsafe creation", { created_ms: Number.MAX_SAFE_INTEGER + 1 }],
  ["missing creation", { created_ms: undefined }],
  ["nonfinite creation", { created_ms: Number.POSITIVE_INFINITY }],
  ["argv type", { argv: "pi" }],
  ["argv element", { argv: ["pi", 1] }],
  ["cwd type", { cwd: null }],
  ["lifecycle word", { state: "running" }],
  ["labels container", { labels: [] }],
  ["labels value", { labels: { task: 1 } }],
  ["name type", { name: false }],
  ["parent type", { parent: [] }],
  ["reported type", { reported: "true" }],
  ["null reported", { reported: null }],
  ["status container", { status: [] }],
  ["missing status state", { status: { app: "pi" } }],
  ["status state type", { status: { app: "pi", state: 1 } }],
  ["status app type", { status: { app: null, state: "idle" } }],
] as const)("rejects malformed %s without publishing a partial graph", (_name, overrides) => {
  const raw = wireTerminal("t2", overrides);
  assert.equal(parseHcTerminal(raw), undefined);
  assert.throws(() => parseHcTerminals([wireTerminal("t1"), raw]), /invalid terminal record/u);
});

test("validates raw list containers and defaults optional public fields without inferring reports", () => {
  for (const value of [undefined, null, "[]", {}, { terminals: [] }]) {
    assert.throws(() => parseHcTerminals(value), /invalid terminal list/u);
  }
  for (const value of [undefined, null, [], 1]) assert.equal(parseHcTerminal(value), undefined);
  assert.deepEqual(parseHcTerminals([]), []);
  const parsed = parseHcTerminal(
    wireTerminal("t2", { reported: undefined, status: null, parent: undefined, name: undefined, foreground: null }),
  );
  assert.ok(parsed);
  assert.equal(parsed.reported, false);
  assert.equal(parsed.status, null);
  assert.equal(Object.hasOwn(parsed, "foreground"), false);
  assert.equal(createHcWidgetSnapshot([parsed], "t1"), undefined);
  const duplicates = parseHcTerminals([wireTerminal("t2"), wireTerminal("t2")]);
  assert.equal(duplicates.length, 2, "ambiguity must reach the full-graph validator");
  assert.equal(createHcWidgetSnapshot(duplicates, "t1"), undefined);
});

test.each([
  ["empty", []],
  ["only self", [terminal("t1")]],
  ["finished report", [terminal("t2", { state: "finished", status: { app: "pi", state: "error" } })]],
  ["never reported", [terminal("t2", { reported: false })]],
  ["cleared root", [terminal("t2", { status: null })]],
  ["no root", [terminal("t2", { status: undefined })]],
  ["missing app", [terminal("t2", { name: "pi", status: { state: "idle" } })]],
  ["empty app", [terminal("t2", { name: "pi", status: { app: "", state: "idle" } })]],
  ["control-only app", [terminal("t2", { status: { app: "\u001b[31m\u001b[0m\n", state: "idle" } })]],
] as const)("omits %s rather than guessing an app from terminal output or argv", (_name, records) => {
  assert.equal(createHcWidgetSnapshot(records, "t1"), undefined);
});

test("does not infer app/status from foreground, argv, screen text, title, labels, or secondary reports", () => {
  const records = parseHcTerminals([
    wireTerminal("t2", {
      name: "Pi",
      status: null,
      argv: ["pi"],
      foreground: { pid: 42, name: "pi", argv: ["pi"], cwd: "/work/pi" },
      screen_text: "Pi is working",
      title: "Pi working",
      labels: { app: "pi", state: "working" },
      records: { root: { app: "pi", state: "working" } },
    }),
  ]);
  assert.equal(createHcWidgetSnapshot(records, "t1"), undefined);
});

test.each([
  ["future-state", "unknown"],
  ["", "unknown"],
  ["private diagnostic text", "unknown"],
  ["\u001b[31merror\u001b[0m", "unknown"],
  ["idle", "idle"],
] as const)("maps native word %j to a plain %s state without exposing raw diagnostic text", (word, expected) => {
  const snapshot = requiredSnapshot([terminal("t1"), terminal("t2", { status: { app: "native-app", state: word } })]);
  assert.equal(snapshot.rows[0]?.agent, "native-app");
  assert.equal(snapshot.rows[0]?.state, expected);
  assert.equal(snapshot.rows[0]?.stateLabel, expected);
});

test("keeps the legacy relative status order while prioritizing native error and limiting peers", () => {
  const states = ["unknown", "idle", "working", "done", "blocked", "error"];
  const peers = states.map((state, index) => terminal(`t${index + 2}`, { status: { app: "pi", state } }));
  const snapshot = requiredSnapshot([terminal("t1"), ...peers]);
  assert.equal(snapshot.totalAgents, 6);
  assert.equal(snapshot.rows.length, MAX_HERDR_WIDGET_AGENTS);
  assert.equal(snapshot.hiddenAgents, 1);
  assert.deepEqual(
    snapshot.rows.map((row) => row.state),
    ["error", "blocked", "done", "working", "idle"],
  );
  const withoutError = requiredSnapshot(peers.slice(0, -1));
  assert.deepEqual(
    withoutError.rows.map((row) => row.state),
    ["blocked", "done", "working", "idle", "unknown"],
  );
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.rows));
  assert.ok(snapshot.rows.every(Object.isFrozen));
});

test("resolves complete terminal ancestry before excluding self and non-app terminals", () => {
  const records = [
    terminal("t1", { parent: "t3", name: "current" }),
    terminal("t2", { name: "founder", reported: false, status: null, state: "finished" }),
    terminal("t3", { name: "reviewer", parent: "t2" }),
    terminal("t4", { name: "worker", parent: "t1" }),
    terminal("t5", { name: "tester", parent: "t4" }),
    terminal("t6", { name: "unrelated" }),
  ];
  const snapshot = requiredSnapshot(records);
  assert.equal(snapshot.totalAgents, 4);
  assert.deepEqual(relations(snapshot), {
    t3: "terminal spawned by founder/t2; spawned your terminal",
    t5: "terminal spawned by worker/t4",
    t6: undefined,
    t4: "terminal spawned by you",
  });
  assert.equal(snapshot.rows.find((row) => row.paneId === "t4")?.pane, "t4");
});

test("resolves a hidden parent before the five-row limit and preserves overflow counts", () => {
  const peers = Array.from({ length: 7 }, (_, index) =>
    terminal(`t${index + 2}`, {
      name: `a${index}`,
      parent: "t9",
      status: { app: "pi", state: "blocked" },
    }),
  );
  const snapshot = requiredSnapshot([
    terminal("t1"),
    ...peers,
    terminal("t9", { name: "hidden-reviewer", status: { app: "pi", state: "idle" } }),
  ]);
  assert.equal(snapshot.totalAgents, 8);
  assert.equal(snapshot.hiddenAgents, 3);
  assert.equal(snapshot.rows.length, MAX_HERDR_WIDGET_AGENTS);
  assert.ok(snapshot.rows.every((row) => row.paneId !== "t9"));
  assert.ok(snapshot.rows.every((row) => row.relation === "terminal spawned by hidden-reviewer/t9"));
});

test("terminal ancestry survives kept-program replacement but a new address inherits no edge", () => {
  const before = requiredSnapshot([terminal("t1"), terminal("t2", { name: "reviewer", parent: "t1" })]);
  const rawReplacement = wireTerminal("t2", {
    parent: "t1",
    name: "different program",
    status: { app: "other-app", state: "error" },
    foreground: { pid: 99, name: "other", argv: ["/other"], cwd: "/other/cwd" },
    keep: true,
    agent_session: { session_file: "/private/session" },
    tokens: { "pi-herdr.spawn": "not an hc protocol" },
  });
  const after = requiredSnapshot(parseHcTerminals([wireTerminal("t1"), rawReplacement]));
  assert.equal(before.rows[0]?.relation, "terminal spawned by you");
  assert.equal(after.rows[0]?.relation, "terminal spawned by you");
  assert.equal(after.rows[0]?.agent, "different program");
  assert.equal(after.rows[0]?.state, "error");
  assert.doesNotMatch(JSON.stringify(after), /session|fingerprint|token|previous agent/u);
  const newAddress = requiredSnapshot([terminal("t1"), terminal("t3", { name: "reviewer" })]);
  assert.equal(newAddress.rows[0]?.relation, undefined);
  assert.equal(newAddress.rows[0]?.pane, "t3");
});

test.each([
  {
    name: "missing parent",
    records: [terminal("t2", { parent: "t9" })],
    relation: "terminal spawned by t9 (unavailable)",
  },
  { name: "self-parent", records: [terminal("t2", { parent: "t2" })], relation: undefined },
  {
    name: "cycle",
    records: [terminal("t2", { parent: "t3" }), terminal("t3", { parent: "t2" })],
    relation: undefined,
  },
  {
    name: "cycle through non-app ancestor",
    records: [terminal("t2", { parent: "t3" }), terminal("t3", { parent: "t2", reported: false })],
    relation: undefined,
  },
  {
    name: "duplicate origin",
    records: [
      terminal("t2", { parent: "t3" }),
      terminal("t3", { name: "a" }),
      terminal("t3", { name: "b", created_ms: 999 }),
    ],
    relation: undefined,
  },
  {
    name: "origin display identity collision",
    records: [terminal("t2", { parent: "t3" }), terminal("t3"), terminal("\u001b[31mt3")],
    relation: undefined,
  },
])("handles $name without attaching an arbitrary origin", ({ records, relation }) => {
  const snapshot = requiredSnapshot([terminal("t1"), ...records]);
  assert.equal(snapshot.rows.find((row) => row.paneId === "t2")?.relation, relation);
  assert.doesNotMatch(JSON.stringify(snapshot), /previous agent/u);
});

test("rejects ambiguous targets/current identities and every descendant of a cycle", () => {
  const duplicates = requiredSnapshot([
    terminal("t1"),
    terminal("t1", { name: "impostor" }),
    terminal("t2", { parent: "t1" }),
    terminal("t3", { parent: "t1" }),
    terminal("t3", { parent: "t2" }),
  ]);
  assert.equal(duplicates.totalAgents, 1);
  assert.deepEqual(relations(duplicates), { t2: undefined });
  const cycle = requiredSnapshot([
    terminal("t1"),
    terminal("t2", { parent: "t3" }),
    terminal("t3", { parent: "t2" }),
    terminal("t4", { parent: "t2" }),
    terminal("t5", { parent: "t4" }),
    terminal("t6", { parent: "t1" }),
  ]);
  assert.deepEqual(relations(cycle), {
    t2: undefined,
    t3: undefined,
    t4: undefined,
    t5: undefined,
    t6: "terminal spawned by you",
  });
  const currentCycle = requiredSnapshot([terminal("t1", { parent: "t2" }), terminal("t2", { parent: "t1" })]);
  assert.equal(currentCycle.rows[0]?.relation, undefined);
});

test.each([
  ["remote origin", "remote/t3", "terminal spawned by remote reviewer/remote/t3"],
  ["local origin", "t3", "terminal spawned by local reviewer/t3"],
  ["cross-core current origin", "t1", "terminal spawned by you"],
  ["unknown remote prefix", "other/t3", "terminal spawned by other/t3 (unavailable)"],
  ["unknown core id", "core-id/t3", "terminal spawned by core-id/t3 (unavailable)"],
] as const)("uses exact public localized parent references for %s", (_name, parent, expected) => {
  const snapshot = requiredSnapshot([
    terminal("t1"),
    terminal("t3", { name: "local reviewer" }),
    terminal("remote/t3", { name: "remote reviewer" }),
    terminal("remote/t4", { name: "worker", parent }),
    terminal("remote/t1", { name: "remote current-address collision" }),
  ]);
  assert.equal(snapshot.rows.find((row) => row.paneId === "remote/t4")?.relation, expected);
  assert.ok(snapshot.rows.some((row) => row.paneId === "remote/t1"));
  assert.ok(snapshot.rows.every((row) => row.paneId !== "t1"));
});

test("does not claim an unavailable or merely sanitized current origin as you", () => {
  assert.equal(
    requiredSnapshot([terminal("t2", { parent: "t1" })]).rows[0]?.relation,
    "terminal spawned by t1 (unavailable)",
  );
  const snapshot = requiredSnapshot([terminal("\u001b[31mt1", { reported: false }), terminal("t2", { parent: "t1" })]);
  assert.equal(snapshot.rows[0]?.relation, "terminal spawned by t1 (unavailable)");
});

test.each([
  ["/work/project/", "t2", "project"],
  ["C:\\work\\project\\", "t2", "project"],
  ["/", "t2", "local"],
  ["C:\\", "t2", "local"],
  ["", "remote/t2", "remote"],
  ["/", "remote/t2", "remote"],
  ["/work/project\u001b]8;;https://host/false-path\u0007", "remote/t2", "project"],
] as const)("uses native cwd %j and address %s for scope %s", (cwd, address, space) => {
  assert.equal(requiredSnapshot([terminal(address, { cwd })]).rows[0]?.space, space);
});

test("sanitizes before sorting/filtering/path splitting while leaving identities and payloads raw", () => {
  const raw = [
    wireTerminal("t1"),
    wireTerminal("t2", { name: "\u001b[31mAlpha\u001b[0m", parent: "t1" }),
    wireTerminal("t3", { name: "Beta\nname\u202e" }),
    wireTerminal("remote\u001b]8;;https://host/false-prefix\u0007/t4", {
      name: "測試\rworker\u202e",
      cwd: "/project/資料\u001b]8;;https://host/false-path\u0007",
      parent: "lost\u001b]8;;https://host/false-parent\u0007/t9",
      status: { app: "pi", state: "error", msg: "private prompt", title: "private title" },
    }),
    wireTerminal("t5", { name: "should not render", status: { app: "\u001b[31m\n", state: "idle" } }),
  ];
  const original = structuredClone(raw);
  const records = parseHcTerminals(raw);
  const snapshot = requiredSnapshot(records);
  assert.deepEqual(
    snapshot.rows.map((row) => row.agent),
    ["測試 worker", "Alpha", "Beta name"],
  );
  assert.equal(snapshot.rows[0]?.pane, "remote/t4");
  assert.equal(snapshot.rows[0]?.space, "資料");
  assert.equal(snapshot.rows[0]?.relation, "terminal spawned by lost/t9 (unavailable)");
  const displayed = snapshot.rows.flatMap((row) => Object.values(row)).join(" ");
  for (const forbidden of ["\u001b", "\u202e", "private", "false-", "should not render"]) {
    assert.equal(displayed.includes(forbidden), false);
  }
  assert.equal(records[3]?.address, original[3]?.address, "raw identities must not be rewritten");
  assert.deepEqual(raw, original);
  assert.equal(herdrWidgetFingerprint(snapshot), herdrWidgetFingerprint(createHcWidgetSnapshot(records, "t1")));
  const mutable = records[1];
  assert.ok(mutable);
  mutable.name = "changed later";
  assert.equal(snapshot.rows[1]?.agent, "Alpha", "published rows must not retain mutable record references");
});

test("reuses bounded themed rendering for native errors, Unicode, controls, overflow, and invalidation", () => {
  const records = [
    terminal("t1"),
    ...Array.from({ length: 7 }, (_, index) =>
      terminal(`t${index + 2}`, {
        name: `測試\u001b[31m${index}\nworker\u202e`,
        parent: "t1",
        status: { app: "pi", state: index === 0 ? "error" : "idle" },
      }),
    ),
  ];
  const snapshot = requiredSnapshot(records);
  const original = structuredClone(snapshot);
  const roles = new Map<string, string>();
  let color = 31;
  const theme = {
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    fg: (role: string, text: string) => {
      roles.set(text, role);
      return `\u001b[${color}m${text}\u001b[0m`;
    },
  } as Theme;
  for (const includeHeader of [true, false]) {
    const widget = createHerdrWidget(snapshot, theme, includeHeader);
    for (const width of [0, 1, 2, 3, 7, 12, 31, 80, 240]) {
      const lines = widget.render(width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width}`,
      );
      assert.equal(stripVTControlCharacters(lines[0] ?? ""), "─".repeat(width));
      for (const forbidden of ["\u001b]", "\u202e", "\r"]) {
        assert.equal(lines.join("\n").includes(forbidden), false);
      }
    }
    const first = widget.render(240).join("\n");
    const plain = stripVTControlCharacters(first);
    assert.match(plain, /! error {2}測試0 worker/u);
    assert.match(plain, /terminal spawned by you/u);
    assert.match(plain, /\+2 more/u);
    assert.equal(roles.get("! error"), "error");
    assert.equal(roles.get("terminal spawned by you"), "muted");
    assert.equal(roles.get("─".repeat(240)), "borderMuted");
    color = color === 31 ? 32 : 31;
    widget.invalidate();
    assert.notEqual(widget.render(240).join("\n"), first);
  }
  assert.deepEqual(snapshot, original);
});

test("supports native error only in presentation, not the legacy Herdr wire allowlist", () => {
  assert.equal((HERDR_AGENT_STATUSES as readonly string[]).includes("error"), false);
  assert.equal(
    parseHerdrPane({
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      terminal_id: "term1",
      focused: false,
      revision: 1,
      agent: "pi",
      agent_status: "error",
    }),
    undefined,
  );
});
