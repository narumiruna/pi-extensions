import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type AgentCandidate,
  applyAgentCandidate,
  buildAgentEvidence,
  parseAgentCandidate,
} from "../src/sync/agent-candidate.js";
import { runAgentResolver } from "../src/sync/agent-runner.js";
import { planFileMerge } from "../src/sync/file-merge-planner.js";
import { fileHashMap } from "../src/sync/sync-state.js";
import { type AgentQualityFixture, agentQualityCorpus } from "./agent-quality-corpus.js";
import { agentContext } from "./agent-test-helpers.js";
import { snapshot } from "./helpers.js";

function fixtureById(id: string) {
  const fixture = agentQualityCorpus.find((entry) => entry.id === id);
  assert.ok(fixture, `Missing quality fixture: ${id}`);
  return fixture;
}

function prepare(fixture: AgentQualityFixture) {
  const image = (content: string | null) =>
    snapshot(content === null ? [] : [{ path: fixture.path, content: Buffer.from(content) }]);
  const base = image(fixture.base);
  const local = image(fixture.local);
  const remote = image(fixture.remote);
  const plan = planFileMerge({
    baseline: fileHashMap(base),
    local: local.files,
    remote: remote.files,
    selectionCompatible: true,
  });
  return { plan, evidence: buildAgentEvidence(plan, local, remote, base.files) };
}

function expectedUnits(fixture: AgentQualityFixture) {
  return fixture.units.map((unit, index) => ({ id: String(index), path: fixture.path, ...unit }));
}

function fixtureResponse(fixture: AgentQualityFixture) {
  return JSON.stringify({ version: 1, results: fixture.results });
}

function assertEvidence(fixture: AgentQualityFixture, prepared: ReturnType<typeof prepare>) {
  const { plan, evidence } = prepared;
  assert.equal(plan.kind, "planned");
  assert.ok(plan.kind === "planned");
  assert.deepEqual(plan.conflicts, [{ kind: "conflict", path: fixture.path, reason: "both-changed" }]);
  assert.deepEqual(evidence.units, expectedUnits(fixture));
  assert.deepEqual(evidence.unsupported, fixture.expected.kind === "unsupported" ? [fixture.path] : []);
  assert.equal(evidence.files.length, fixture.expected.kind === "unsupported" ? 0 : 1);
  if (fixture.codeOwned) {
    const parts = evidence.files[0]?.parts;
    assert.ok(parts);
    // Join only adjacent code-owned strings, never a model-owned replacement.
    const spans = [""];
    for (const part of parts) {
      if (typeof part === "string") spans[spans.length - 1] += part;
      else spans.push("");
    }
    assert.deepEqual(
      spans.map((span) => Buffer.from(span)),
      fixture.codeOwned.map((span) => Buffer.from(span)),
    );
    assert.deepEqual(
      parts.filter((part) => typeof part !== "string"),
      expectedUnits(fixture),
    );
  }
}

function assertOutcome(fixture: AgentQualityFixture, prepared: ReturnType<typeof prepare>, raw: string) {
  const original = structuredClone(prepared.plan);
  const candidate = parseAgentCandidate(raw, prepared.evidence);
  assert.deepEqual(candidate, { version: 1, results: fixture.results });
  const applied = applyAgentCandidate(prepared.plan, prepared.evidence, candidate);
  assert.deepEqual(prepared.plan, original, "candidate application must not mutate the input plan");
  assert.ok(applied.kind === "planned");
  assert.equal(applied.decisions.length, 1);
  if (fixture.expected.kind !== "accepted") {
    if (fixture.expected.kind === "refused") {
      assert.deepEqual(
        candidate.results.filter((row) => "refuse" in row).map((row) => row.id),
        fixture.expected.ids,
      );
    }
    assert.deepEqual(applied, original, "refused/unsupported paths must retain the original conflict");
    return;
  }
  assert.deepEqual(applied.conflicts, []);
  const decision = applied.decisions[0];
  assert.ok(decision?.kind === "accepted");
  assert.equal(decision.source, "merged");
  assert.equal(decision.path, fixture.path);
  const expectedBytes = Buffer.from(fixture.expected.content);
  assert.ok(decision.file);
  assert.deepEqual(Buffer.from(decision.file.contentBase64, "base64"), expectedBytes);
  assert.deepEqual(decision.file, snapshot([{ path: fixture.path, content: expectedBytes }]).files[0]);
}

for (const fixture of agentQualityCorpus) {
  test(`synthetic quality oracle: ${fixture.id}`, () => {
    const prepared = prepare(fixture);
    assertEvidence(fixture, prepared);
    assertOutcome(fixture, prepared, fixtureResponse(fixture));
  });

  if (fixture.expected.kind === "unsupported") continue;
  test(`deterministic resolver fixture, not model accuracy: ${fixture.id}`, async () => {
    const prepared = prepare(fixture);
    let observedUnits: unknown;
    const mock = agentContext((units) => {
      observedUnits = structuredClone(units);
      return fixtureResponse(fixture);
    });
    const raw = await runAgentResolver(mock.ctx, prepared.evidence, async () => {});
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(observedUnits, expectedUnits(fixture));
    const request = mock.requests[0];
    assert.ok(request);
    assert.deepEqual(request.tools ?? [], []);
    assert.equal(request.messages.filter((message) => message.role === "user").length, 1);
    const message = request.messages.at(-1);
    assert.ok(message?.role === "user");
    const payload =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    assert.deepEqual(JSON.parse(payload), { units: expectedUnits(fixture) });
    assertOutcome(fixture, prepared, raw);
  });
}

for (const id of ["insertion-at-deletion-start", "insertion-at-deletion-end", "delete-versus-modify-hunk"]) {
  test(`deletion-boundary ownership is symmetric: ${id}`, () => {
    const fixture = fixtureById(id);
    const mirrored: AgentQualityFixture = {
      ...fixture,
      local: fixture.remote,
      remote: fixture.local,
      units: fixture.units.map((unit) => ({ ...unit, local: unit.remote, remote: unit.local })),
    };
    const prepared = prepare(mirrored);
    assertEvidence(mirrored, prepared);
    assertOutcome(mirrored, prepared, fixtureResponse(mirrored));
  });
}

for (const id of ["separate-overlapping-hunks", "coupled-settings-remote-model-local-analytics"]) {
  const fixture = fixtureById(id);
  for (const refusedUnit of fixture.results) {
    test(`one refusal withholds the whole path: ${id}/${refusedUnit.id}`, () => {
      const { plan, evidence } = prepare(fixture);
      const results = fixture.results.map((row) => (row.id === refusedUnit.id ? { id: row.id, refuse: true } : row));
      const candidate = parseAgentCandidate(JSON.stringify({ version: 1, results }), evidence);
      assert.deepEqual(applyAgentCandidate(plan, evidence, candidate), plan);
    });
  }
}

const invalidResults: { id: string; fixture: string; results: unknown[] }[] = [
  {
    id: "empty-replacement-for-nonempty-inputs",
    fixture: "same-point-insertions",
    results: [{ id: "0", content: "" }],
  },
  {
    id: "empty-replacement-for-deleted-hunk",
    fixture: "delete-versus-modify-hunk",
    results: [{ id: "0", content: "" }],
  },
  {
    id: "empty-replacement-for-existing-empty-file",
    fixture: "existing-empty-file-versus-modification",
    results: [{ id: "0", content: "" }],
  },
  {
    id: "text-source-selection-is-not-supported",
    fixture: "same-point-insertions",
    results: [{ id: "0", source: "local" }],
  },
  {
    id: "refusal-cannot-contain-a-replacement",
    fixture: "same-point-insertions",
    results: [{ id: "0", refuse: true, content: "replacement\n" }],
  },
  {
    id: "refusal-must-be-true",
    fixture: "same-point-insertions",
    results: [{ id: "0", refuse: false }],
  },
  {
    id: "cannot-address-outside-owned-region",
    fixture: "same-point-insertions",
    results: [{ id: "0", content: "replacement\n", path: "settings.json" }],
  },
  {
    id: "all-units-need-a-result",
    fixture: "separate-overlapping-hunks",
    results: [{ id: "0", content: "replacement\n" }],
  },
  {
    id: "duplicate-unit-cannot-replace-missing-unit",
    fixture: "separate-overlapping-hunks",
    results: [
      { id: "0", content: "alpha\n" },
      { id: "0", refuse: true },
    ],
  },
  {
    id: "unknown-unit-cannot-replace-missing-unit",
    fixture: "separate-overlapping-hunks",
    results: [
      { id: "0", content: "alpha\n" },
      { id: "99", content: "beta\n" },
    ],
  },
  {
    id: "settings-cannot-synthesize-a-provider-model-pair",
    fixture: "coupled-settings-remote-model-local-analytics",
    results: [
      { id: "0", content: '{"defaultProvider":"local-provider","defaultModel":"remote-model"}' },
      { id: "1", source: "remote" },
    ],
  },
  {
    id: "settings-cannot-select-fields-separately",
    fixture: "coupled-settings-remote-model-local-analytics",
    results: [
      { id: "0", source: "local", defaultModel: "remote-model" },
      { id: "1", source: "remote" },
    ],
  },
];

for (const invalid of invalidResults) {
  test(`quality corpus rejects invalid candidate: ${invalid.id}`, () => {
    const { plan, evidence } = prepare(fixtureById(invalid.fixture));
    const original = structuredClone(plan);
    const candidate = { version: 1, results: invalid.results };
    assert.throws(() => parseAgentCandidate(JSON.stringify(candidate), evidence));
    // A persisted candidate must cross the same validation boundary.
    assert.throws(() => applyAgentCandidate(plan, evidence, candidate as AgentCandidate));
    assert.deepEqual(plan, original);
  });
}

test("opposite hidden policies produce identical disclosed units and require fixture refusals", () => {
  const smaller = fixtureById("hidden-context-smaller");
  const larger = fixtureById("hidden-context-larger");
  assert.notEqual(smaller.base, larger.base);
  assert.deepEqual(prepare(smaller).evidence.units, prepare(larger).evidence.units);
  for (const fixture of [smaller, larger]) {
    assert.equal(fixture.expected.kind, "refused");
    assert.deepEqual(fixture.results, [{ id: "0", refuse: true }]);
    assert.doesNotMatch(JSON.stringify(prepare(fixture).evidence.units), /Policy|smaller|larger/);
  }
});

test("required semantic refusal is a corpus oracle, not a candidate-validator guarantee", () => {
  const fixture = fixtureById("hidden-context-larger");
  const { plan, evidence } = prepare(fixture);
  const candidate = parseAgentCandidate(
    JSON.stringify({ version: 1, results: [{ id: "0", content: "Timeout: 20\n" }] }),
    evidence,
  );
  const applied = applyAgentCandidate(plan, evidence, candidate);
  assert.ok(applied.kind === "planned");
  assert.deepEqual(applied.conflicts, []);
  const decision = applied.decisions[0];
  assert.ok(decision?.kind === "accepted" && decision.file);
  assert.deepEqual(
    Buffer.from(decision.file.contentBase64, "base64"),
    Buffer.from("Policy: choose the larger proposed timeout.\nTimeout: 20\nfooter\n"),
  );
  // This schema-valid acceptance violates the fixture oracle. No mock score can rule it out in a real model.
  assert.equal(fixture.expected.kind, "refused");
});

for (const [side, local, remote, source] of [
  ["local", null, "base\n", "local"],
  ["remote", "base\n", null, "remote"],
  ["both", null, null, "equal"],
] as const) {
  test(`unchanged-versus-deleted file is a deterministic deletion, not a model replacement: ${side}`, () => {
    const { plan, evidence } = prepare({
      ...fixtureById("local-file-deletion-versus-modification"),
      local,
      remote,
    });
    assert.ok(plan.kind === "planned");
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.decisions, [{ kind: "accepted", path: "AGENTS.md", source, file: undefined }]);
    assert.deepEqual(evidence, { units: [], files: [], unsupported: [] });
  });
}
