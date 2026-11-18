import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type HerdrPane, parseHerdrPane } from "../src/herdr-protocol.js";
import { herdrSessionFingerprint, parseHerdrSpawnProvenance } from "../src/herdr-spawn-provenance.js";
import { createHerdrWidget, HerdrWidgetModel, herdrWidgetFingerprint } from "../src/herdr-widget.js";

function session(value = "/sessions/origin.jsonl") {
  return { source: "herdr:pi", agent: "pi", kind: "path", value };
}

function wire(id: string, overrides: Record<string, unknown> = {}) {
  return {
    pane_id: id,
    terminal_id: `terminal-${id}`,
    workspace_id: id.split(":")[0],
    tab_id: `${id}:tab`,
    revision: 1,
    focused: false,
    agent: "pi",
    agent_status: "idle",
    name: id,
    agent_session: session(`/sessions/${id}.jsonl`),
    ...overrides,
  };
}

function parsed(raw: Record<string, unknown>): HerdrPane {
  const pane = parseHerdrPane(raw);
  assert.ok(pane);
  return pane;
}

function tokens(origin: ReturnType<typeof wire>, target: ReturnType<typeof wire>, label = "captured-origin") {
  return {
    pi_spawn_v: "1",
    pi_spawn_origin: origin.terminal_id,
    pi_spawn_from: herdrSessionFingerprint(origin.terminal_id, origin.agent_session),
    pi_spawn_to: herdrSessionFingerprint(target.terminal_id, target.agent_session),
    pi_spawn_label: label,
  };
}

function spawned(origin: ReturnType<typeof wire>, target: ReturnType<typeof wire>, label?: string) {
  return { ...target, tokens: tokens(origin, target, label) };
}

function snapshot(current: ReturnType<typeof wire>, others: ReturnType<typeof wire>[]) {
  const model = new HerdrWidgetModel();
  model.reset(parsed(current), [parsed(current), ...others.map(parsed)]);
  return model.snapshot();
}

test("fingerprints only complete native Pi identity and retains no raw paths in parsed panes", () => {
  const reference = session();
  const digest = herdrSessionFingerprint("term", reference);
  assert.equal(
    digest,
    createHash("sha256")
      .update(JSON.stringify(["term", "herdr:pi", "pi", "path", reference.value]))
      .digest("hex"),
  );
  assert.notEqual(digest, herdrSessionFingerprint("other", reference));
  assert.notEqual(digest, herdrSessionFingerprint("term", { ...reference, kind: "id" }));
  assert.notEqual(digest, herdrSessionFingerprint("term", session("/sessions/replaced.jsonl")));
  const origin = wire("w1:p1");
  const target = wire("w1:p2");
  const pane = parsed(spawned(origin, target));
  assert.ok(pane.spawn);
  assert.equal(JSON.stringify(pane).includes("/sessions/"), false);
});

test.each([
  ["missing terminal", undefined, session()],
  ["empty terminal", "", session()],
  ["oversized terminal", "t".repeat(257), session()],
  ["controlled terminal", "term\u001b", session()],
  ["missing session", "term", undefined],
  ["array session", "term", []],
  ["wrong source", "term", { ...session(), source: "custom" }],
  ["wrong agent", "term", { ...session(), agent: "codex" }],
  ["unknown kind", "term", { ...session(), kind: "future" }],
  ["empty reference", "term", session("")],
  ["oversized reference", "term", session("測".repeat(1366))],
])("ignores %s", (_label, terminal, reference) => {
  assert.equal(herdrSessionFingerprint(terminal, reference), undefined);
});

test.each([
  ["missing record", undefined],
  ["array record", []],
  ["future version", { pi_spawn_v: "2" }],
  ["missing origin", { pi_spawn_origin: undefined }],
  ["invalid origin digest", { pi_spawn_from: "not-a-digest" }],
  ["wrong target", { pi_spawn_to: "a".repeat(64) }],
  ["empty label", { pi_spawn_label: "" }],
  ["oversized label", { pi_spawn_label: "測".repeat(81) }],
  ["self origin", { pi_spawn_origin: "terminal-w1:p2" }],
])("invalid %s does not hide an otherwise valid agent", (_label, replacement) => {
  const origin = wire("w1:p1");
  const target = wire("w1:p2");
  const value =
    replacement === undefined || Array.isArray(replacement)
      ? replacement
      : { ...tokens(origin, target), ...replacement };
  const pane = parsed({ ...target, tokens: value });
  assert.equal(pane.agent, "pi");
  assert.equal(pane.spawn, undefined);
});

test("labels accept 80 Unicode characters while missing or mismatched identity hides provenance", () => {
  const origin = wire("w1:p1");
  const target = wire("w1:p2");
  const record = tokens(origin, target, "測".repeat(80));
  assert.ok(parseHerdrSpawnProvenance(record, target.terminal_id, record.pi_spawn_to));
  assert.equal(parseHerdrSpawnProvenance(record, target.terminal_id, undefined), undefined);
  assert.equal(parsed({ ...spawned(origin, target), agent: "codex" }).spawn, undefined);
  assert.equal(parsed({ ...spawned(origin, target), agent_session: null }).spawn, undefined);
});

test("shows both directions involving the current agent and peer-to-peer nested origins", () => {
  const a = wire("w1:p1", { name: "initiator" });
  const b = spawned(a, wire("w1:p2", { name: "reviewer" }));
  const c = spawned(b, wire("w1:p3", { name: "researcher" }));
  const unrelated = wire("w1:p4");
  const rows = snapshot(b, [a, c, unrelated])?.rows;
  assert.equal(rows?.find((row) => row.paneId === a.pane_id)?.relation, "spawned you");
  assert.equal(rows?.find((row) => row.paneId === c.pane_id)?.relation, "spawned by you");
  assert.equal(rows?.find((row) => row.paneId === unrelated.pane_id)?.relation, undefined);
  assert.equal(
    snapshot(unrelated, [a, b, c])?.rows.find((row) => row.paneId === c.pane_id)?.relation,
    "spawned by reviewer/p2",
  );
  const currentChild = snapshot(c, [a, b]);
  assert.equal(
    currentChild?.rows.find((row) => row.paneId === b.pane_id)?.relation,
    "spawned by initiator/p1; spawned you",
  );
});

test.each(["replacement", "missing identity", "non-native identity"] as const)(
  "explicit current pane replaces conflicting list identity: %s",
  (kind) => {
    const parent = wire("w1:p0");
    const oldCurrent = spawned(parent, wire("w1:p1"));
    const child = spawned(oldCurrent, wire("w1:p2"));
    const peer = wire("w1:p3");
    const peerChild = spawned(peer, wire("w1:p4"));
    const current = {
      ...oldCurrent,
      agent_session:
        kind === "replacement"
          ? session("/sessions/replacement.jsonl")
          : kind === "missing identity"
            ? undefined
            : { ...session(), source: "custom" },
    };
    const model = new HerdrWidgetModel();
    const listed = [oldCurrent, parent, child, peer, peerChild].map(parsed);
    model.reset(parsed(oldCurrent), listed);
    assert.equal(model.snapshot()?.rows.find((row) => row.paneId === parent.pane_id)?.relation, "spawned you");
    assert.equal(model.snapshot()?.rows.find((row) => row.paneId === child.pane_id)?.relation, "spawned by you");
    model.reset(parsed(current), listed);
    const rows = model.snapshot()?.rows;
    assert.equal(rows?.find((row) => row.paneId === parent.pane_id)?.relation, undefined);
    assert.equal(
      rows?.find((row) => row.paneId === child.pane_id)?.relation,
      "spawned by captured-origin (unavailable)",
    );
    assert.equal(rows?.find((row) => row.paneId === peerChild.pane_id)?.relation, "spawned by w1:p3/p3");
  },
);

test("explicit current provenance replaces or clears a conflicting list edge without merging", () => {
  const firstParent = wire("w1:p0");
  const secondParent = wire("w1:p2");
  const current = wire("w1:p1");
  const listedCurrent = spawned(firstParent, current);
  const child = spawned(current, wire("w1:p3"));
  const model = new HerdrWidgetModel();
  const listed = [listedCurrent, firstParent, secondParent, child].map(parsed);
  model.reset(parsed(spawned(secondParent, current)), listed);
  assert.equal(model.snapshot()?.rows.find((row) => row.paneId === firstParent.pane_id)?.relation, undefined);
  assert.equal(model.snapshot()?.rows.find((row) => row.paneId === secondParent.pane_id)?.relation, "spawned you");
  assert.equal(model.snapshot()?.rows.find((row) => row.paneId === child.pane_id)?.relation, "spawned by you");
  model.reset(parsed(current), listed);
  assert.equal(model.snapshot()?.rows.find((row) => row.paneId === secondParent.pane_id)?.relation, undefined);
  assert.equal(model.snapshot()?.rows.find((row) => row.paneId === firstParent.pane_id)?.relation, undefined);
  assert.equal(model.snapshot()?.rows.find((row) => row.paneId === child.pane_id)?.relation, "spawned by you");
});

test("moves and renames resolve by terminal/session, not old pane IDs or captured names", () => {
  const origin = wire("w1:p1", { name: "old" });
  const target = spawned(origin, wire("w1:p2"));
  const movedOrigin = { ...origin, pane_id: "w2:p9", workspace_id: "w2", name: "renamed" };
  const movedTarget = { ...target, pane_id: "w3:p5", workspace_id: "w3" };
  const current = wire("w1:p7");
  const row = snapshot(current, [movedOrigin, movedTarget])?.rows.find((row) => row.paneId === "w3:p5");
  assert.equal(row?.relation, "spawned by renamed/p9");
  assert.equal(snapshot(movedOrigin, [movedTarget])?.rows[0]?.relation, "spawned by you");
});

test("replacement cannot inherit an old edge or impersonate an origin; reload retains unchanged identity", () => {
  const origin = wire("w1:p1");
  const target = spawned(origin, wire("w1:p2"));
  assert.equal(snapshot(origin, [target])?.rows[0]?.relation, "spawned by you");
  assert.equal(snapshot(origin, [structuredClone(target)])?.rows[0]?.relation, "spawned by you");
  const replacedTarget = { ...target, agent_session: session("/sessions/new-target.jsonl") };
  assert.equal(snapshot(origin, [replacedTarget])?.rows[0]?.relation, undefined);
  const replacedOrigin = { ...origin, agent_session: session("/sessions/new-origin.jsonl") };
  assert.equal(snapshot(replacedOrigin, [target])?.rows[0]?.relation, "spawned by captured-origin (unavailable)");
  assert.equal(snapshot(wire("w1:p7"), [target])?.rows[0]?.relation, "spawned by captured-origin (unavailable)");
});

test("origin resolution precedes row limiting and does not choose ambiguous or cyclic identities", () => {
  const current = wire("w1:p0");
  const origin = wire("w1:p9", { agent_status: "unknown" });
  const target = spawned(origin, wire("w1:p1", { agent_status: "blocked" }));
  const others = Array.from({ length: 6 }, (_, i) => wire(`w1:p${i + 2}`));
  const value = snapshot(current, [origin, target, ...others]);
  assert.equal(value?.rows[0]?.relation, "spawned by w1:p9/p9");
  assert.equal(
    value?.rows.some((row) => row.paneId === origin.pane_id),
    false,
  );
  const duplicate = { ...origin, pane_id: "w2:p1", name: "duplicate" };
  assert.equal(
    snapshot(current, [origin, duplicate, target])?.rows.find((row) => row.paneId === target.pane_id)?.relation,
    "spawned by captured-origin (unavailable)",
  );
  const cyclicOrigin = spawned(target, origin);
  assert.equal(
    snapshot(current, [cyclicOrigin, target])?.rows.every((row) => row.relation === undefined),
    true,
  );
});

test("relations are immutable, sanitized, muted, width-bounded, and theme-invalidated", () => {
  const origin = wire("w1:p1", { name: "reviewer\u001b]8;;https://spoof\u0007\n\u202e" });
  const target = spawned(origin, wire("w1:p2"));
  const model = new HerdrWidgetModel();
  model.reset(parsed(wire("w1:p0")), [parsed(origin), parsed(target)]);
  const value = model.snapshot();
  assert.ok(value);
  const before = herdrWidgetFingerprint(value);
  const row = value.rows.find((row) => row.paneId === target.pane_id);
  assert.equal(row?.relation, "spawned by reviewer/p1");
  assert.equal(Object.isFrozen(row), true);
  const roles = new Map<string, string>();
  let color = "31";
  const theme = {
    bold: (text: string) => text,
    fg: (role: string, text: string) => {
      roles.set(text, role);
      return `\u001b[${color}m${text}\u001b[0m`;
    },
  } as Theme;
  const widget = createHerdrWidget(value, theme, false);
  for (const width of [0, 1, 2, 12, 40, 120, 200]) {
    const lines = widget.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.join("\n").includes("\u001b]8"), false);
    assert.equal(lines.join("\n").includes("\u202e"), false);
  }
  assert.equal(roles.get(row?.relation ?? ""), "muted");
  const first = widget.render(200).join("\n");
  color = "32";
  widget.invalidate();
  assert.notEqual(widget.render(200).join("\n"), first);
  assert.equal(herdrWidgetFingerprint(model.snapshot()), before);
  model.clear();
  assert.equal(model.snapshot(), undefined);
});
