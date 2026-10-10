import assert from "node:assert/strict";
import { test } from "vitest";
import { type MergedSyncSummaryInput, mergedSyncSummary } from "../src/ui/merged-sync-summary.js";
import { snapshot } from "./helpers.js";

const image = (files: Record<string, string>) =>
  snapshot(Object.entries(files).map(([path, content]) => ({ path, content: Buffer.from(content) })));
const base = image({ "APPEND_SYSTEM.md": "old" });
function review(overrides: Partial<MergedSyncSummaryInput> = {}) {
  return mergedSyncSummary({
    setupName: "default",
    destination: "bucket · pi-sync/default",
    localBefore: base,
    localAfter: base,
    remoteBefore: base,
    remoteAfter: base,
    publish: false,
    sessions: false,
    groups: [],
    decisions: [],
    capability: "conditional-required",
    ...overrides,
  });
}

test("reported APPEND_SYSTEM case shows one local update and no remote publication", () => {
  const result = review({
    localAfter: image({ "APPEND_SYSTEM.md": "new" }),
    decisions: [{ kind: "accepted", path: "APPEND_SYSTEM.md", source: "remote", file: undefined }],
  });
  assert.equal(result.title, "Update 1 local file?");
  assert.equal(result.confirmationLabel, "update local file");
  assert.match(result.lines.join("\n"), /Local changes: 1 update\n {2}Update APPEND_SYSTEM.md from remote/);
  assert.match(result.content, /Remote file changes: none/);
  assert.match(result.content, /Remote snapshot publication: no/);
  assert.match(result.content, /Conflicts: none/);
  assert.match(result.content, /Sessions: not included/);
  assert.match(result.content, /backup and recovery journal/);
  assert.match(result.content, /Resources will not reload automatically/);
  assert.doesNotMatch(result.content, /No file changes|conditional-required|baseline|withheld/);
});

for (const [name, input, title] of [
  ["remote-only", { remoteAfter: image({ "APPEND_SYSTEM.md": "new" }), publish: true }, "Update 1 remote file?"],
  [
    "two-way",
    {
      localAfter: image({ "APPEND_SYSTEM.md": "new" }),
      remoteAfter: image({ "APPEND_SYSTEM.md": "other" }),
      publish: true,
    },
    "Apply local and remote changes?",
  ],
  ["local delete", { localAfter: image({}) }, "Apply changes to 1 local file?"],
  ["remote delete", { remoteAfter: image({}), publish: true }, "Apply changes to 1 remote file?"],
  ["publication only", { publish: true }, "Publish a new remote snapshot?"],
  ["no transfer", {}, "Pi Sync is already up to date."],
] as const) {
  test(`${name} summary matches the operation`, () => {
    const result = review(input);
    assert.equal(result.title, title);
    assert.match(result.content, new RegExp(`Remote snapshot publication: ${input.publish ? "yes" : "no"}`));
    if (name.includes("delete")) assert.match(result.lines.join("\n"), /1 delete\n {2}Delete APPEND_SYSTEM.md/);
    if (name === "publication only") {
      assert.match(result.content, /Local changes: none/);
      assert.match(result.content, /Remote file changes: none/);
      assert.equal(result.confirmationLabel, "publish remote snapshot");
    }
  });
}

test("counts use snapshot differences instead of accepted decision counts", () => {
  const result = review({
    localAfter: image({ "APPEND_SYSTEM.md": "new", "added.md": "new" }),
    decisions: [{ kind: "accepted", path: "unchanged.md", source: "remote", file: undefined }],
  });
  assert.equal(result.title, "Apply changes to 2 local files?");
  assert.match(result.content, /Local changes: 1 add, 1 update/);
  assert.doesNotMatch(result.content, /unchanged.md/);
});

test("local deletion identifies its remote source without suggesting a remote mutation", () => {
  const result = review({
    localAfter: image({}),
    decisions: [{ kind: "accepted", path: "APPEND_SYSTEM.md", source: "remote", file: undefined }],
  });
  assert.match(result.content, /Delete APPEND_SYSTEM.md \(deleted remotely\)/);
  assert.doesNotMatch(result.content, /Delete APPEND_SYSTEM.md from remote/);
  assert.match(result.content, /Remote snapshot publication: no/);
});

test("merged content is not presented as a remote replacement", () => {
  const result = review({
    localAfter: image({ "APPEND_SYSTEM.md": "merged" }),
    decisions: [{ kind: "accepted", path: "APPEND_SYSTEM.md", source: "merged", file: undefined }],
  });
  assert.match(result.content, /Update APPEND_SYSTEM.md \(merged content\)/);
  assert.doesNotMatch(result.content, /from remote/);
});

test("partial summary identifies unchanged unresolved paths and accepted writes", () => {
  const result = review({
    localAfter: image({ "APPEND_SYSTEM.md": "new" }),
    groups: [{ paths: ["skills/group/SKILL.md", "skills/group/helper.ts"] }],
  });
  assert.match(result.lines.join("\n"), /Unresolved groups: 1 — these paths stay unchanged on each side/);
  assert.match(result.content, /Unchanged \(unresolved\): skills\/group\/SKILL.md/);
  assert.match(result.content, /Unchanged \(unresolved\): skills\/group\/helper.ts/);
  assert.match(result.content, /Local changes: 1 update/);
  assert.doesNotMatch(result.content, /Conflicts: none/);
});

test("large summaries stay bounded but retain counts, privacy and deletion warnings", () => {
  const files = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`${index}-${"長".repeat(80)}.md`, "new"]));
  const result = review({ localAfter: image(files), sessions: true, groups: [{ paths: ["private/unresolved.md"] }] });
  assert.match(result.lines.join("\n"), /50 add, 1 delete/);
  assert.match(result.lines.join("\n"), /48 more files/);
  assert.match(result.lines.join("\n"), /may contain private conversations/);
  assert.ok(result.lines.length < 20);
  assert.match(result.content, /Delete APPEND_SYSTEM.md/);
  assert.match(result.content, new RegExp(`49-${"長".repeat(80)}.md`));
});

test("terminal controls are escaped before truncation without changing raw paths", () => {
  const raw = "unsafe\n\u001b[31m\u202efile.md";
  const input = image({ [raw]: "new" });
  const result = review({
    setupName: "setup\nname",
    destination: "bucket\u001bname",
    localAfter: input,
    groups: [{ paths: [raw] }],
  });
  assert.match(result.content, /unsafe\\u000a\\u001b\[31m\\u202efile.md/);
  assert.equal(result.content.includes("\u001b"), false);
  assert.equal(result.content.includes("\u202e"), false);
  assert.equal(input.files[0].path, raw);
});

for (const capability of [
  "lease-protected",
  "atomic-conditional",
  "conditional-required",
  "read-check-write-verify",
] as const) {
  test(`publication safety is plain language for ${capability}`, () => {
    const published = review({ publish: true, capability });
    assert.doesNotMatch(published.content, new RegExp(capability));
    if (capability === "conditional-required") assert.match(published.lines.join("\n"), /verification failure stops/);
    if (capability === "read-check-write-verify")
      assert.match(published.lines.join("\n"), /simultaneous remote writes can still race/);
    const localOnly = review({ capability });
    assert.doesNotMatch(localOnly.content, /Warning:|verification failure/);
  });
}
