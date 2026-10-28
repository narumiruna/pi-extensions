import assert from "node:assert/strict";
import { test } from "vitest";
import type { JsonValue } from "../src/sync/json-document.js";
import { mergePackageVersions } from "../src/sync/package-merge.js";
import { mergeSettingsJson } from "../src/sync/settings-merge.js";

for (const [lower, higher] of [
  ["1.9.0", "1.10.0"],
  ["1.0.0-beta.2", "1.0.0-beta.10"],
  ["1.0.0-rc.1", "1.0.0"],
  ["1.0.0", "2.0.0"],
]) {
  for (const name of ["example", "@scope/example"]) {
    test(`higher version wins in either direction: ${name} ${lower}/${higher}`, () => {
      const low = `npm:${name}@${lower}`;
      const high = `npm:${name}@${higher}`;
      for (const [local, remote] of [
        [low, high],
        [high, low],
      ] as const) {
        assert.deepEqual(mergePackageVersions([high], [local], [remote]), [high]);
        assert.deepEqual(mergePackageVersions([], [local], [remote]), [high]);
      }
    });
  }
}

test("preserves filters, one-sided npm membership changes and unchanged local paths", () => {
  const old = { source: "npm:example@1.0.0", extensions: ["a.ts"], skills: [] };
  const newer = { ...old, source: "npm:example@2.0.0" };
  assert.deepEqual(
    mergePackageVersions(
      [old, "./keep", "npm:delete@1.0.0"],
      [old, "./keep", "npm:delete@1.0.0"],
      ["npm:add@1.0.0", newer, "./keep"],
    ),
    ["npm:add@1.0.0", newer, "./keep"],
  );
});

for (const [local, remote] of [
  [["npm:example@^1.0.0"], ["npm:example@^2.0.0"]],
  [["npm:example@latest"], ["npm:example@next"]],
  [["npm:example"], ["npm:example@2.0.0"]],
  [["npm:example@bad"], ["npm:example@2.0.0"]],
  [["npm:example@1.0.0", "npm:example@2.0.0"], ["npm:example@3.0.0"]],
  [[{ source: "npm:example@1.0.0", skills: [] }], [{ source: "npm:example@2.0.0", skills: ["x"] }]],
  [[42], ["npm:example@2.0.0"]],
] satisfies [JsonValue[], JsonValue[]][]) {
  test(`unsupported or ambiguous entries retain atomic conflict: ${JSON.stringify(local)}`, () => {
    assert.equal(mergePackageVersions([], [...local], [...remote]), undefined);
  });
}

test("delete/upgrade retains conflict, unchanged deletion stays deleted", () => {
  assert.equal(mergePackageVersions(["npm:x@1.0.0"], [], ["npm:x@2.0.0"]), undefined);
  assert.deepEqual(mergePackageVersions(["npm:x@1.0.0"], [], ["npm:x@1.0.0"]), []);
});

for (const [name, base, local, remote, expected] of [
  [
    "remote reorder",
    ["npm:a@1.0.0", "npm:b@1.0.0"],
    ["npm:a@2.0.0", "npm:b@1.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0"],
    ["npm:b@1.0.0", "npm:a@2.0.0"],
  ],
  [
    "local reorder",
    ["npm:a@1.0.0", "npm:b@1.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0"],
    ["npm:a@2.0.0", "npm:b@1.0.0"],
    ["npm:b@1.0.0", "npm:a@2.0.0"],
  ],
  [
    "equal reorder",
    ["npm:a@1.0.0", "npm:b@1.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0"],
    ["npm:b@1.0.0", "npm:a@2.0.0"],
    ["npm:b@1.0.0", "npm:a@2.0.0"],
  ],
  [
    "remote insertion position",
    ["npm:a@1.0.0"],
    ["npm:a@2.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0"],
    ["npm:b@1.0.0", "npm:a@2.0.0"],
  ],
  [
    "conflicting order",
    ["npm:a@1.0.0", "npm:b@1.0.0", "npm:c@1.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0", "npm:c@1.0.0"],
    ["npm:a@1.0.0", "npm:c@1.0.0", "npm:b@1.0.0"],
    undefined,
  ],
  ["concurrent additions", [], ["npm:a@1.0.0"], ["npm:b@1.0.0"], undefined],
] satisfies [string, string[], string[], string[], string[] | undefined][]) {
  test(`package order: ${name}`, () => assert.deepEqual(mergePackageVersions(base, local, remote), expected));
}

for (const [base, local, remote] of [
  ["git:github.com/example/repo@base", "git:github.com/example/repo@local", "git:github.com/example/repo@remote"],
  [
    "git:github.com/example/repo@base",
    "https://github.com/example/repo.git@local",
    "ssh://git@github.com/example/repo@remote",
  ],
  [
    "git:git@git.example.org:group/repo.git@base",
    "git:git@git.example.org:group/repo.git@local",
    "git:git.example.org/group/repo@remote",
  ],
  [
    "git:https://gitlab.com/example/repo@base",
    "git:https://gitlab.com/example/repo@local",
    "git:https://gitlab.com/example/repo@remote",
  ],
  [
    "https://git.example.org/group/repo@base",
    "http://git.example.org/group/repo@local",
    "git://git.example.org/group/repo@remote",
  ],
  ["./repo", "./group/../repo", "./repo/"],
  ["./repo", "./repo/", "./repo/"],
] as const) {
  test(`changed non-npm sources retain atomic handling: ${local}`, () => {
    for (const filtered of [false, true]) {
      const entry = (source: string) => (filtered ? { source, extensions: ["index.ts"] } : source);
      assert.equal(mergePackageVersions([entry(base)], [entry(local)], [entry(remote)]), undefined);
    }
  });
}

test("unchanged non-npm sources permit npm upgrades without source normalization", () => {
  const git = "git:github.com/example/repo@stable";
  assert.deepEqual(
    mergePackageVersions(
      [git, "./repo", "npm:x@1.0.0"],
      [git, "./repo", "npm:x@2.0.0"],
      [git, "./repo", "npm:x@3.0.0"],
    ),
    [git, "./repo", "npm:x@3.0.0"],
  );
});

test("higher version policy is opt-in and retains unknown settings", () => {
  const bytes = (packages: string[], extra = {}) =>
    Buffer.from(JSON.stringify({ packages, future: { x: 1 }, ...extra }));
  const versions = [bytes(["npm:x@1.0.0"]), bytes(["npm:x@2.0.0"]), bytes(["npm:x@3.0.0"], { theme: "dark" })] as const;
  assert.equal(mergeSettingsJson(...versions).kind, "review");
  const merged = mergeSettingsJson(...versions, undefined, true);
  assert.equal(merged.kind, "merged");
  if (merged.kind === "merged")
    assert.deepEqual(JSON.parse(merged.content.toString()), {
      packages: ["npm:x@3.0.0"],
      future: { x: 1 },
      theme: "dark",
    });
});
