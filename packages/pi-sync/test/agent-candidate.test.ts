import assert from "node:assert/strict";
import { test } from "vitest";
import { applyAgentCandidate, buildAgentEvidence, parseAgentCandidate } from "../src/sync/agent-candidate.js";
import { planFileMerge } from "../src/sync/file-merge-planner.js";
import { fileHashMap } from "../src/sync/sync-state.js";
import { selectRemote } from "./agent-test-helpers.js";
import { snapshot } from "./helpers.js";

function evidence(base: string, local: string, remote: string, filePath = "AGENTS.md") {
  const image = (content: string) => snapshot([{ path: filePath, content: Buffer.from(content) }]);
  const ancestor = image(base);
  const left = image(local);
  const right = image(remote);
  const plan = planFileMerge({
    baseline: fileHashMap(ancestor),
    local: left.files,
    remote: right.files,
    selectionCompatible: true,
  });
  return { plan, evidence: buildAgentEvidence(plan, left, right, ancestor.files) };
}

test("agent writes only overlapping hunks; independent edits and whitespace stay exact", () => {
  const f = evidence(
    "heading  \nshared\nend\n",
    "heading  \nlocal\nend\n",
    "heading  \nremote\nend\nremote addition\n",
  );
  assert.equal(f.evidence.units.length, 1);
  const unit = f.evidence.units[0];
  assert.equal(unit?.local, "local\n");
  const candidate = parseAgentCandidate(
    JSON.stringify({ version: 1, results: [{ id: unit?.id, content: "combined\n" }] }),
    f.evidence,
  );
  const plan = applyAgentCandidate(f.plan, f.evidence, candidate);
  assert.equal(plan.kind, "planned");
  if (plan.kind !== "planned") return;
  assert.equal(plan.conflicts.length, 0);
  const decision = plan.decisions[0];
  assert.equal(decision?.kind, "accepted");
  if (decision?.kind === "accepted")
    assert.equal(
      Buffer.from(decision.file?.contentBase64 ?? "", "base64").toString(),
      "heading  \ncombined\nend\nremote addition\n",
    );
});

test("settings selects whole coupled units and preserves unrelated/unknown fields", () => {
  const f = evidence(
    '{"defaultProvider":"a","defaultModel":"m","unknown":{"x":1}}',
    '{"defaultProvider":"b","defaultModel":"n","unknown":{"x":1},"theme":"local"}',
    '{"defaultProvider":"c","defaultModel":"o","unknown":{"x":1},"quiet":true}',
    "settings.json",
  );
  assert.equal(f.evidence.units.length, 1);
  assert.deepEqual(JSON.parse(f.evidence.units[0]?.local ?? "{}"), { defaultProvider: "b", defaultModel: "n" });
  const plan = applyAgentCandidate(f.plan, f.evidence, parseAgentCandidate(selectRemote(f.evidence.units), f.evidence));
  if (plan.kind !== "planned" || plan.decisions[0]?.kind !== "accepted") throw new Error("not resolved");
  assert.deepEqual(JSON.parse(Buffer.from(plan.decisions[0].file?.contentBase64 ?? "", "base64").toString()), {
    defaultProvider: "c",
    defaultModel: "o",
    unknown: { x: 1 },
    theme: "local",
    quiet: true,
  });
});

test("package versions are code-owned even when the model selects other settings", () => {
  for (const themeConflict of [false, true]) {
    const f = evidence(
      JSON.stringify({ packages: ["npm:x@1.0.0"], theme: "base" }),
      JSON.stringify({ packages: ["npm:x@3.0.0"], theme: themeConflict ? "local" : "base" }),
      JSON.stringify({ packages: ["npm:x@2.0.0"], theme: themeConflict ? "remote" : "base" }),
      "settings.json",
    );
    assert.equal(f.evidence.units.length, themeConflict ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(f.evidence.units), /packages/);
    const plan = applyAgentCandidate(
      f.plan,
      f.evidence,
      parseAgentCandidate(selectRemote(f.evidence.units), f.evidence),
    );
    if (plan.kind !== "planned" || plan.decisions[0]?.kind !== "accepted") throw new Error("not resolved");
    assert.deepEqual(JSON.parse(Buffer.from(plan.decisions[0].file?.contentBase64 ?? "", "base64").toString()), {
      packages: ["npm:x@3.0.0"],
      theme: themeConflict ? "remote" : "base",
    });
  }
});

for (const filePath of [
  "keybindings.json",
  "sessions/project/s.jsonl",
  "extensions/code.ts",
  "skills/a/run.sh",
  "custom.bin",
])
  test(`ineligible path stays unresolved: ${filePath}`, () => {
    const f = evidence("base", "left", "right", filePath);
    assert.deepEqual(f.evidence.unsupported, [filePath]);
    assert.deepEqual(f.evidence.units, []);
  });

for (const raw of [
  '{"version":1,"results":[]}',
  '{"version":1,"results":[{"id":"99","content":"x"}]}',
  '{"version":1,"results":[{"id":"0","content":"x","path":"auth.json"}]}',
  '{"version":1,"results":[{"id":"0","content":""}]}',
  '{"version":1,"results":[{"id":"0","source":"remote"}]}',
  '{"version":1,"results":[{"id":"0","content":"<<<<<<< conflict"}]}',
  '{"version":1,"results":[{"id":"0","content":"x"}],"extra":true}',
  '{"version":1,"results":[{"id":"0","content":"x","content":"y"}]}',
  "```json\n{}\n```",
])
  test(`reject malformed/unowned candidate ${raw.slice(0, 65)}`, () => {
    const f = evidence("base", "left", "right");
    assert.throws(() => parseAgentCandidate(raw, f.evidence));
  });

test("refusal leaves the entire conflicted path unchanged", () => {
  const f = evidence("base", "left", "right");
  const plan = applyAgentCandidate(
    f.plan,
    f.evidence,
    parseAgentCandidate('{"version":1,"results":[{"id":"0","refuse":true}]}', f.evidence),
  );
  assert.deepEqual(plan, f.plan);
});

for (const value of ['{"x":9007199254740993}', '{"x":1e999}', '{"x":1,"x":2}', '{"__proto__":1}'])
  test(`unsafe settings have no model disclosure: ${value}`, () => {
    const f = evidence('{"x":0}', value, '{"x":2}', "settings.json");
    assert.equal(f.evidence.units.length, 0);
    assert.deepEqual(f.evidence.unsupported, ["settings.json"]);
  });

for (const secret of [
  "sk-ant-abcdefghijklmnopqrstuvwxyz",
  'AWS_SECRET_ACCESS_KEY="ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890123456"',
  'OPENAI_API_KEY="abcdefghijklmnopqrstuvwxyz1234567890"',
])
  test("mandatory model disclosure scan checks raw strings before JSON escaping", () => {
    for (const position of [0, 1, 2]) {
      const versions = ["base", "local", "remote"] as [string, string, string];
      versions[position] = secret;
      assert.throws(() => evidence(...versions), /nothing was disclosed/);
    }
  });

test("file and output bounds reject unbounded evidence/candidates", () => {
  const f = evidence("base", "left", "right");
  assert.throws(() => parseAgentCandidate("x".repeat(17000), f.evidence));
  assert.equal(evidence("base", "x".repeat(9000), "right").evidence.units.length, 0);
});
